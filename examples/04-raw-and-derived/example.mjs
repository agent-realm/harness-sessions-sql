// Example 04: raw apart from derived. The reference engine (conformance/reference/engine.mjs) reads
// a toy harness store through a toy adapter over three passes, archiving every raw unit and a read
// manifest per read in session_units and deriving the entity tables from them. Then only
// session_units is copied into a fresh namespace, the engine replays it there, and the replayed
// tables match the live ones, removed versions included. See README.md.

import { runExample, EXAMPLE_HOST } from '../lib/example.mjs';
import * as toy from './toy-adapter.mjs';
import { createEngine } from '../../conformance/reference/engine.mjs';
import { AdapterSource } from '../../conformance/lib/adapters.mjs';
import { snapshot, diffSnapshots } from '../../conformance/lib/state.mjs';
import { ENTITY_TABLES } from '../../conformance/lib/keys.mjs';

// The toy adapter, in the shape the reference engine takes adapters (the kit's AdapterSource).
const adapters = new AdapterSource({ adapterFor: () => toy }, null);

const store = { host: EXAMPLE_HOST, harness: toy.HARNESS, harness_path: '/home/user/.toy-harness' };
const session = { session_id: 'toy-session-1', incarnation: '' };
const SOURCE = 'toy-session-1.jsonl';

// The session's file as the harness changes it: three lines; a fourth appended; then the file
// rewritten with its first two lines only, as a rewind does.
const line = (id, role, text) => `${JSON.stringify({ id, role, text })}\n`;
const [L1, L2, L3, L4] = [
  line('m-1', 'user', 'Plan the release.'),
  line('m-2', 'assistant', 'Step one: tag the build.'),
  line('m-3', 'user', 'And then?'),
  line('m-4', 'assistant', 'Step two: publish it.'),
];
const VERSIONS = [L1 + L2 + L3, L1 + L2 + L3 + L4, L1 + L2];

const keys = (list) => list.join(', ') || 'none';
const byNumber = (a, b) => Number(a) - Number(b);

await runExample({
  async run({ profile, namespace }) {
    // 1. The live passes: a consumer reads the source from where it left off, and hands each read
    //    to the engine as an envelope (spec §8, Envelopes).
    const live = await namespace();
    const engine = createEngine({ profile, ns: live, adapters });
    let position = null;
    for (const [i, text] of VERSIONS.entries()) {
      const read = toy.read(SOURCE, text, position);
      await engine.pass([{ store, session, source_key: SOURCE, role: 'main', mode: 'stream', position_kind: 'offset', from: position, read }]);
      console.log(`pass ${i + 1}: read ${read.continuity}, units ${keys(read.units.map((u) => u.unit_key))}`);
      position = read.position;
    }

    // 2. The archive: every unit, and one read manifest (unit_key '') per read, by generation.
    console.log('the archive, session_units (spec §4.1):');
    const archive = await live.present('session_units');
    for (const g of [...new Set(archive.map((r) => Number(r.generation)))].sort(byNumber)) {
      const rows = archive.filter((r) => Number(r.generation) === g);
      console.log(`  generation ${g}: units ${keys(rows.filter((r) => r.unit_key !== '').map((r) => r.unit_key).sort(byNumber))}`);
      const manifests = rows.filter((r) => r.unit_key === '').map((r) => JSON.parse(r.raw)).sort((a, b) => a.progress - b.progress);
      for (const m of manifests) console.log(`    read manifest: progress ${m.progress}, ${m.continuity}, units ${keys(m.units.map(([k]) => k))}, gone ${keys(m.gone)}`);
    }

    // 3. The derived tables, as the live passes left them.
    const parts = await live.present('session_parts');
    const state = (removed) => keys(parts.filter((r) => Number(r.removed) === removed).map((r) => r.message_id).sort());
    console.log(`the derived messages (session_parts): current ${state(0)}; removed versions ${state(1)}`);
    console.log(`the cursor (session_sources): ${(await live.present('session_sources')).length} row(s)`);

    // 4. Replay from the archive alone: a fresh namespace gets session_units and nothing else.
    const replayed = await namespace();
    await replayed.exec(`INSERT INTO ${replayed.t('session_units')} SELECT * FROM ${live.t('session_units')}`);
    await createEngine({ profile, ns: replayed, adapters }).replay();
    console.log(`replayed in a fresh namespace from session_units alone (its session_sources: ${(await replayed.present('session_sources')).length} row(s))`);

    // 5. The comparison: every entity row, current or removed, by identity, content_sha (and
    //    message_content_sha) and removed flag. Each writer counts its own revs (spec §7), so rev
    //    is not compared.
    const a = await snapshot(live, { tables: ENTITY_TABLES });
    const b = await snapshot(replayed, { tables: ENTITY_TABLES });
    for (const t of ENTITY_TABLES) console.log(`  ${t}: ${a.get(t).size} row(s) live, ${b.get(t).size} replayed`);
    const diff = diffSnapshots(a, b, { left: 'live', right: 'replayed' });
    if (diff.length) {
      for (const d of diff) console.log(`  ${d}`);
      throw new Error('the replayed tables differ from the live ones');
    }
    console.log('the replayed tables match the live ones, removed versions included');
  },
});

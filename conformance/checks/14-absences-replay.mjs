// §8: "Absences replay: a still-listed source reset to empty, a vanished source handled as
// "policy": "kept", a vanished source handled as "policy": "removed", and a delta read's gone
// keys, each replayed from session_units alone (no entity table, no cursor), give the same current
// state as the live pass, with the adapter-owned rows' removed versions. Replay rebuilds the
// current edges, not the removed versions of edges that ended: it folds each session alone, and
// the order of passes across sessions is not archived."
//
// The absences scenario holds the four cases in pass 2. An engine's live state and its own replay
// can agree and both be wrong (a "kept" source handled as removed in both), and a replay can read
// manifests that only that engine understands, so the check holds both to what does not depend
// on the engine:
// 1. after each live pass, the adapter-owned records are what the contract says (the oracle:
//    current with their derived shas, each key that left live a removed version);
// 2. after each pass, session_units folded as §4.1 says (by the kit, lib/archive.mjs) gives each
//    source exactly the units its reads left current;
// 3. every manifest has §4.1's shape, and records the read it stands for, in order;
// 4. only session_units is copied into a fresh namespace (no entity table, no cursor), the engine
//    replays from it, and the replay holds the live namespace's adapter-owned rows, current and
//    removed (identity, shas, removed flag), and the same current edges.

import { snapshot, diffSnapshots, records } from '../lib/state.mjs';
import { ENTITY_TABLES } from '../lib/keys.mjs';
import { expectSources } from '../lib/oracle.mjs';
import { foldArchive, diffSources, manifestProblems, readProblems } from '../lib/archive.mjs';
import { recordProblems } from '../lib/compare.mjs';
import { verdict } from '../lib/result.mjs';

export default {
  id: 'absences-replay',
  title: 'Absences replay',
  faults: ['engine:no-manifest', 'engine:ignore-policy', 'engine:policy-kept-as-removed', 'engine:private-manifest', 'engine:manifest-whole-generation'],

  async engine(ctx) {
    const problems = [];
    const sc = ctx.scenario('absences');
    const exp = ctx.expect(sc);
    const units = expectSources(sc.passes);
    const cases = Object.fromEntries(Object.entries(sc.meta).map(([k, v]) => [v.session_id, k]));
    const tag = (d) => {
      const which = Object.entries(cases).find(([sid]) => d.includes(sid));
      return which ? `${d} [case: ${which[1]}]` : d;
    };
    const live = await ctx.namespace();
    const engine = await ctx.engine(live);
    const tomb = (engine.removal ?? 'removed') === 'tombstone';
    let rows = [];
    for (let i = 0; i < sc.passes.length; i++) {
      await engine.pass(sc.passes[i]);
      const at = `live, pass ${i + 1}`;
      problems.push(...recordProblems(await records(live), exp[i], { tomb, at }).problems.map(tag));
      rows = await live.present('session_units');
      const f = foldArchive(rows);
      problems.push(...f.problems.map((d) => tag(`archive after pass ${i + 1}: ${d}`)));
      problems.push(...diffSources(f.sources, units[i], { label: `archive after pass ${i + 1}` }).map(tag));
    }
    problems.push(...manifestProblems(rows).map(tag), ...readProblems(sc.passes, rows).map(tag));

    const replayed = await ctx.namespace();
    await ctx.copyUnits(live, replayed);
    await (await ctx.engine(replayed)).replay();
    const a = await snapshot(live, { tables: ENTITY_TABLES, edgeHistory: false });
    const b = await snapshot(replayed, { tables: ENTITY_TABLES, edgeHistory: false });
    for (const d of diffSnapshots(a, b, { left: 'live', right: 'replayed' })) problems.push(tag(d));
    const manifests = rows.filter((r) => r.unit_key === '').length;
    return verdict(problems, [`cases: ${Object.entries(sc.meta).map(([k, v]) => `${k} (${v.session_id})`).join(', ')}; live state and the archive's fold checked against the reads after each pass; ${manifests} manifest(s) checked; then replayed`]);
  },
};

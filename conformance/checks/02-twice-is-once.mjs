// §8: "Twice is once: ingesting the same envelopes twice gives no duplicate logical rows in any
// table."
//
// Each pass is delivered twice in a row, and then the whole sequence again. After each repeat:
// - the entity tables and the cursor hold the same logical rows as before it (identity, shas,
//   removed flag);
// - session_units gains no unit row and no generation. It may gain read manifests that deliver
//   nothing new: in a generation it already had, not source_gone, listing only units the
//   generation already archived with the same sha256, and only gone keys an earlier manifest of
//   that generation already listed. An `unchanged` read, or a delta read whose position did not
//   move, cannot be told from a new read by its position, and its manifest replays to no change;
//   the kit reads "duplicate logical row" as a row that repeats content (SPEC-QUESTIONS.md);
// - no identity holds two rows once the table is merged (ClickHouse: OPTIMIZE ... FINAL, then
//   the physical rows grouped by identity).

import { snapshot, diffSnapshots, idOf, readable } from '../lib/state.mjs';
import { identities } from '../lib/spec.mjs';
import { ALL_TABLES, sessionKeyOf } from '../lib/keys.mjs';
import { verdict } from '../lib/result.mjs';

const OTHER = ALL_TABLES.filter((t) => t !== 'session_units');

export default {
  id: 'twice-is-once',
  title: 'Twice is once',
  kind: 'engine',
  faults: ['engine:regenerate'],

  async run(ctx) {
    const problems = [];
    const notes = [];
    let tolerated = 0;
    for (const name of ['broad', 'rewind']) {
      const sc = ctx.scenario(name);
      const ns = await ctx.namespace();
      const engine = await ctx.engine(ns);
      const repeat = async (label, fn) => {
        const before = await snapshot(ns, { tables: OTHER });
        const units = await ns.present('session_units');
        await fn();
        for (const d of diffSnapshots(before, await snapshot(ns, { tables: OTHER }), { left: 'once', right: 'twice' })) problems.push(`${name}, ${label}: ${d}`);
        const r = addedUnits(units, await ns.present('session_units'));
        tolerated += r.tolerated;
        for (const d of r.problems) problems.push(`${name}, ${label}: ${d}`);
      };
      for (let i = 0; i < sc.passes.length; i++) {
        await engine.pass(sc.passes[i]);
        await repeat(`pass ${i + 1} delivered again`, () => engine.pass(sc.passes[i]));
      }
      await repeat('the whole sequence delivered again', async () => {
        for (const p of sc.passes) await engine.pass(p);
      });
      problems.push(...(await duplicates(ns)).map((d) => `${name}: ${d}`));
      notes.push(`${name}: ${sc.passes.length} pass(es), each delivered twice, then all again`);
    }
    notes.push(`${tolerated} manifest(s) of repeated reads that deliver nothing new`);
    return verdict(problems, notes);
  },
};

const gen = (r) => `${sessionKeyOf(r)}\u0000${r.source_key}\u0000${r.generation}`;

// The session_units rows a repeat added, judged: a manifest that delivers nothing new is
// tolerated, anything else is a duplicate.
function addedUnits(before, after) {
  const ids = new Set(before.map((r) => idOf('session_units', r)));
  const gens = new Set(before.map(gen));
  const archived = new Set(before.filter((r) => r.unit_key !== '').map((r) => `${gen(r)}\u0000${r.unit_key}\u0000${r.sha256}`));
  const gone = new Set();
  for (const r of before) if (r.unit_key === '' && r.enc === 'manifest') for (const k of JSON.parse(r.raw).gone ?? []) gone.add(`${gen(r)}\u0000${k}`);
  const problems = [];
  let tolerated = 0;
  for (const r of after) {
    if (ids.has(idOf('session_units', r))) continue;
    if (r.unit_key !== '' || r.enc !== 'manifest') {
      problems.push(`session_units: a unit archived again: ${readable(idOf('session_units', r))}`);
      continue;
    }
    const m = JSON.parse(r.raw);
    const fresh = !gens.has(gen(r)) || m.source_gone
      || (m.units ?? []).some(([uk, sha]) => !archived.has(`${gen(r)}\u0000${uk}\u0000${sha}`))
      || (m.gone ?? []).some((k) => !gone.has(`${gen(r)}\u0000${k}`));
    if (fresh) problems.push(`session_units: a manifest with new content: ${readable(idOf('session_units', r))}`);
    else tolerated++;
  }
  return { problems, tolerated };
}

async function duplicates(ns) {
  const out = [];
  const { tables } = identities();
  for (const t of ALL_TABLES) {
    if (!tables[t]) continue;
    const cols = tables[t].identity.join(', ');
    if (ns.profile === 'clickhouse') await ns.exec(`OPTIMIZE TABLE ${ns.t(t)} FINAL`);
    const rows = await ns.query(`SELECT ${cols}, count(*) AS n FROM ${ns.t(t)} GROUP BY ${cols} HAVING count(*) > 1`);
    if (rows.length) out.push(`${t}: ${rows.length} identities with more than one row after a merge`);
  }
  return out;
}

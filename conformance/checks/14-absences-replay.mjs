// §8: "Absences replay: a still-listed source reset to empty, a vanished source handled as
// "policy": "kept", a vanished source handled as "policy": "removed", and a delta read's gone
// keys, each replayed from session_units alone (no entity table, no cursor), give the same current
// state as the live pass, removed versions included."
//
// The absences scenario holds the four cases in pass 2. The live passes run in one namespace;
// then only its session_units rows are copied into a fresh namespace (no entity table, no cursor)
// and the engine replays from them. Both must hold the same adapter-owned rows, current and
// removed (identity, shas, removed flag), and the same current edges.

import { snapshot, diffSnapshots } from '../lib/state.mjs';
import { ENTITY_TABLES } from '../lib/keys.mjs';
import { verdict } from '../lib/result.mjs';

export default {
  id: 'absences-replay',
  title: 'Absences replay',
  kind: 'engine',
  faults: ['engine:no-manifest', 'engine:ignore-policy'],

  async run(ctx) {
    const problems = [];
    const sc = ctx.scenario('absences');
    const live = await ctx.namespace();
    const engine = await ctx.engine(live);
    for (const p of sc.passes) await engine.pass(p);
    const replayed = await ctx.namespace();
    await ctx.copyUnits(live, replayed);
    await (await ctx.engine(replayed)).replay();
    const a = await snapshot(live, { tables: ENTITY_TABLES, edgeHistory: false });
    const b = await snapshot(replayed, { tables: ENTITY_TABLES, edgeHistory: false });
    const cases = Object.fromEntries(Object.entries(sc.meta).map(([k, v]) => [v.session_id, k]));
    for (const d of diffSnapshots(a, b, { left: 'live', right: 'replayed' })) {
      const which = Object.entries(cases).find(([sid]) => d.includes(sid));
      problems.push(which ? `${d} [case: ${which[1]}]` : d);
    }
    return verdict(problems, [`cases: ${Object.entries(sc.meta).map(([k, v]) => `${k} (${v.session_id})`).join(', ')}`]);
  },
};

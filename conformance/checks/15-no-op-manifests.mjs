// §8: "No-op manifests: a pass that omits the manifest of a read that changes nothing in the fold
// (§4.1) replays to the same current state as a pass that writes it."
//
// The noop scenario: pass 2 and pass 4 read nothing new. The live archive is copied twice: once
// whole, once without every no-op manifest. A manifest is a no-op (§4.1) when it opens no
// generation (an earlier manifest opened it), is not source_gone, and changes nothing in the
// fold: its generation already holds every unit it lists, with the same sha256, and no longer
// holds any key in its gone. Both copies are replayed; they must give the same state, removed
// versions included. An engine that omits no-op manifests already gives two equal copies, and
// passes.

import { snapshot, diffSnapshots } from '../lib/state.mjs';
import { ENTITY_TABLES, sessionKeyOf } from '../lib/keys.mjs';
import { verdict } from '../lib/result.mjs';

export default {
  id: 'no-op-manifests',
  title: 'No-op manifests',
  faults: ['engine:replay-last-manifest'],

  async engine(ctx) {
    const problems = [];
    const sc = ctx.scenario('noop');
    const live = await ctx.namespace();
    const engine = await ctx.engine(live);
    for (const p of sc.passes) await engine.pass(p);
    const manifests = (await live.present('session_units')).filter((r) => r.unit_key === '' && r.enc === 'manifest').map((r) => ({ r, m: JSON.parse(r.raw) }));
    // Each generation's units, folded in progress order; a manifest that changes nothing in it is
    // a no-op.
    const held = new Map();
    const noop = [];
    for (const x of [...manifests].sort((a, b) => Number(a.m.progress) - Number(b.m.progress))) {
      const { r, m } = x;
      const g = `${sessionKeyOf(r)}\u0000${r.source_key}\u0000${r.generation}`;
      const units = held.get(g);
      if (!units) {
        held.set(g, new Map(m.units ?? []));
        continue;
      }
      const changes = (m.units ?? []).some(([uk, sha]) => units.get(uk) !== sha) || (m.gone ?? []).some((k) => units.has(k));
      if (!m.source_gone && !changes) noop.push(x);
      for (const [uk, sha] of m.units ?? []) units.set(uk, sha);
      for (const k of m.gone ?? []) units.delete(k);
    }
    const withAll = await ctx.namespace();
    await ctx.copyUnits(live, withAll);
    const without = await ctx.namespace();
    await ctx.copyUnits(live, without, { except: noop.map(({ r }) => r) });
    const [nAll, nWithout] = [(await withAll.present('session_units')).length, (await without.present('session_units')).length];
    if (nAll - nWithout !== noop.length) problems.push(`the copy without no-op manifests left out ${nAll - nWithout} row(s), not the ${noop.length} no-op manifest(s)`);
    await (await ctx.engine(withAll)).replay();
    await (await ctx.engine(without)).replay();
    for (const d of diffSnapshots(await snapshot(withAll, { tables: ENTITY_TABLES, edgeHistory: false }), await snapshot(without, { tables: ENTITY_TABLES, edgeHistory: false }), { left: 'with no-op manifests', right: 'without' })) problems.push(d);
    return verdict(problems, [noop.length ? `${noop.length} no-op manifest(s) in the archive, of ${manifests.length}` : `the engine wrote no no-op manifest (${manifests.length} manifests): both replays read the same archive`]);
  },
};

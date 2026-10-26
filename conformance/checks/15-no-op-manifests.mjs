// §8: "No-op manifests: a pass that omits the manifest of a read that opened no generation and
// delivered nothing replays to the same current state as a pass that writes it."
//
// The noop scenario: pass 2 and pass 4 read nothing new. The live archive is copied twice: once
// whole, once without every no-op manifest (a manifest with no units, no gone keys, no
// source_gone, in a generation an earlier manifest opened). Both copies are replayed; they must
// give the same state, removed versions included. An engine that omits no-op manifests already
// gives two equal copies, and passes.

import { snapshot, diffSnapshots } from '../lib/state.mjs';
import { ENTITY_TABLES, sessionKeyOf } from '../lib/keys.mjs';
import { verdict } from '../lib/result.mjs';

export default {
  id: 'no-op-manifests',
  title: 'No-op manifests',
  kind: 'engine',
  faults: ['engine:replay-last-manifest'],

  async run(ctx) {
    const problems = [];
    const sc = ctx.scenario('noop');
    const live = await ctx.namespace();
    const engine = await ctx.engine(live);
    for (const p of sc.passes) await engine.pass(p);
    const manifests = (await live.present('session_units')).filter((r) => r.unit_key === '' && r.enc === 'manifest').map((r) => ({ r, m: JSON.parse(r.raw) }));
    const opened = new Map();
    for (const { r, m } of manifests) {
      const g = `${sessionKeyOf(r)}\u0000${r.source_key}\u0000${r.generation}`;
      opened.set(g, Math.min(opened.get(g) ?? Infinity, Number(m.progress)));
    }
    const noop = manifests.filter(({ r, m }) => !m.units?.length && !m.gone?.length && !m.source_gone
      && Number(m.progress) > opened.get(`${sessionKeyOf(r)}\u0000${r.source_key}\u0000${r.generation}`));
    const withAll = await ctx.namespace();
    await ctx.copyUnits(live, withAll);
    const without = await ctx.namespace();
    await ctx.copyUnits(live, without, { exceptSha: noop.map(({ r }) => r.sha256) });
    await (await ctx.engine(withAll)).replay();
    await (await ctx.engine(without)).replay();
    for (const d of diffSnapshots(await snapshot(withAll, { tables: ENTITY_TABLES, edgeHistory: false }), await snapshot(without, { tables: ENTITY_TABLES, edgeHistory: false }), { left: 'with no-op manifests', right: 'without' })) problems.push(d);
    return verdict(problems, [noop.length ? `${noop.length} no-op manifest(s) in the archive, of ${manifests.length}` : `the engine wrote no no-op manifest (${manifests.length} manifests): both replays read the same archive`]);
  },
};

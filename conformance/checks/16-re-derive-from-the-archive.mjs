// §8: "Re-derive from the archive: a new adapter_ver replayed from session_units alone writes
// higher revs, and physically deletes only the keys the new version no longer produces."
//
// The rewind scenario, live; then the engine replays its archive with the kit's bumped adapters
// (each harness's adapter at the next patch version, re-keying every usage record, the kind of key
// change sessions-model §1 rule 8 lets a bump make). Expected from the oracle run with the same
// bumped adapters over the same envelopes:
// - every record the new version produces is present (current or removed, as the oracle says),
//   and every row it rewrote has a higher rev than the row it replaced;
// - every record present before that the new version does not produce is physically gone;
// - no other record is gone.

import { records } from '../lib/state.mjs';
import { expectStates } from '../lib/oracle.mjs';
import { verdict } from '../lib/result.mjs';

export default {
  id: 're-derive-from-the-archive',
  title: 'Re-derive from the archive',
  faults: ['engine:rederive-keep-stale'],

  async engine(ctx) {
    const problems = [];
    const sc = ctx.scenario('rewind');
    const ns = await ctx.namespace();
    const engine = await ctx.engine(ns);
    for (const p of sc.passes) await engine.pass(p);
    const before = await records(ns);
    const harnesses = new Set(sc.passes.flat().map((e) => e.store.harness));
    const versions = ctx.adapters.bumpedVersions(harnesses);
    const bumped = { adapterFor: (h) => ctx.adapters.adapterFor(h, { adapterVer: versions[h] }) };
    const want = new Map();
    for (const [sk, st] of expectStates(sc.passes, bumped).at(-1)) {
      for (const rk of st.current.keys()) want.set(`${sk}|${rk}`, false);
      for (const rk of st.removed.keys()) want.set(`${sk}|${rk}`, true);
    }
    await (await ctx.engine(ns)).replay({ adapterVer: versions });
    const after = await records(ns);
    let higher = 0;
    for (const [k, removed] of want) {
      const got = after.get(k);
      if (!got) problems.push(`${show(k)}: produced by the new version, not present`);
      else if (got.removed !== removed) problems.push(`${show(k)}: ${got.removed ? 'removed' : 'current'}, the new version's replay says ${removed ? 'removed' : 'current'}`);
      const old = before.get(k);
      if (got && old) {
        const oldTop = Math.max(...old.rows.map(({ row }) => Number(row.rev)));
        const newTop = Math.max(...got.rows.map(({ row }) => Number(row.rev)));
        if (!(newTop > oldTop)) problems.push(`${show(k)}: rev ${newTop} after the re-derive, ${oldTop} before`);
        else higher++;
      }
    }
    let deleted = 0;
    for (const k of before.keys()) {
      if (want.has(k)) continue;
      if (after.has(k)) problems.push(`${show(k)}: the new version does not produce it, and it is still present`);
      else deleted++;
    }
    for (const k of after.keys()) if (!want.has(k) && !before.has(k)) problems.push(`${show(k)}: present after the re-derive, produced by neither version`);
    if (!deleted && !problems.length) problems.push('the new version dropped no key: the check proves nothing');
    return verdict(problems, [`${higher} records rewritten at a higher rev, ${deleted} no longer produced and deleted (versions: ${Object.entries(versions).map(([h, v]) => `${h} ${v}`).join(', ')})`]);
  },
};

const show = (k) => k.replace(/\u0000/g, '/').slice(0, 200);

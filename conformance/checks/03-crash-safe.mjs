// §8: "Crash-safe: killing the pass between the archive write and the cursor write, then
// re-running it, gives equal row counts and equal current state."
//
// A clean run of the rewind scenario is the reference. Then, for each crash point the engine
// offers (`crashPoints`, at least `archive`: right after the archive write), a run in which every
// pass is first stopped there, the engine instance dropped (a new one stands for the restarted
// process), and the same pass delivered again. Its logical row counts and current state (identity
// and shas, `rev` left out) must equal the clean run's.

import { snapshot, diffSnapshots, counts } from '../lib/state.mjs';
import { verdict } from '../lib/result.mjs';

export default {
  id: 'crash-safe',
  title: 'Crash-safe',
  kind: 'engine',
  faults: ['engine:cursor-early'],

  async run(ctx) {
    const problems = [];
    const sc = ctx.scenario('rewind');
    const clean = await ctx.namespace();
    const e0 = await ctx.engine(clean);
    for (const p of sc.passes) await e0.pass(p);
    const want = await snapshot(clean, { removed: false });
    const wantCounts = await counts(clean);
    const points = e0.crashPoints?.length ? e0.crashPoints : ['archive'];
    for (const point of points) {
      const ns = await ctx.namespace();
      for (const p of sc.passes) {
        await (await ctx.engine(ns)).pass(p, { crashAfter: point });
        await (await ctx.engine(ns)).pass(p);
      }
      const got = await snapshot(ns, { removed: false });
      for (const d of diffSnapshots(want, got, { left: 'clean', right: `crashed after ${point}` })) problems.push(d);
      const gotCounts = await counts(ns);
      for (const [t, n] of Object.entries(wantCounts)) if (gotCounts[t] !== n) problems.push(`crashed after ${point}: ${t} holds ${gotCounts[t]} logical rows, the clean run ${n}`);
    }
    return verdict(problems, [`crash points: ${points.join(', ')}; ${sc.passes.length} passes, each crashed then re-run`]);
  },
};

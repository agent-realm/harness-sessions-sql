// §8: "Edges outlive statements correctly: re-deriving the child alone keeps a merged edge
// (owner = 'engine') while the parent's statement stands. Removing every supporting statement ends
// it."
//
// The OpenCode child/task pair (opencode/features): the child's statement (at '') and the parent's
// `task` call merge into one edge, keyed on the child, stated_on 'both', at the call id.
// Pass 2 re-derives the child alone (its title changed); pass 3 removes both statements (the
// child's parent_id cleared, the parent's task part deleted).

import { verdict } from '../lib/result.mjs';
import { idOf } from '../lib/state.mjs';

export default {
  id: 'edges-outlive-statements',
  title: 'Edges outlive statements correctly',
  kind: 'engine',
  faults: ['engine:edges-from-pass'],

  async run(ctx) {
    const problems = [];
    const sc = ctx.scenario('edges');
    const { child, origin, at } = sc.pair;
    const ns = await ctx.namespace();
    const engine = await ctx.engine(ns);
    const edges = async () => (await ns.current('session_links')).filter((r) => r.owner === 'engine' && r.session_id === child && r.other_session_id === origin);

    await engine.pass(sc.passes[0]);
    const first = await edges();
    if (first.length !== 1) problems.push(`pass 1: ${first.length} current edges for the pair, expected one merged edge`);
    else {
      if (first[0].stated_on !== 'both') problems.push(`pass 1: the edge is stated_on ${first[0].stated_on}, expected both`);
      if (first[0].at !== at) problems.push(`pass 1: the edge is at '${first[0].at}', expected the task call '${at}'`);
    }
    await engine.pass(sc.passes[1]);
    const second = await edges();
    const ids = (rows) => rows.map((r) => `${idOf('session_links', r)}\u0001${r.content_sha}`).sort().join('\n');
    if (ids(second) !== ids(first)) problems.push(`pass 2 (the child alone): the edge changed: ${second.map((r) => `stated_on ${r.stated_on}, at '${r.at}'`).join('; ') || 'none current'}`);
    await engine.pass(sc.passes[2]);
    const third = await edges();
    if (third.length) problems.push(`pass 3 (both statements removed): ${third.length} edge(s) still current`);
    const stmts = (await ns.current('session_links')).filter((r) => r.owner === 'adapter' && (r.session_id === child || r.session_id === origin));
    if (stmts.length) problems.push(`pass 3: ${stmts.length} statement(s) of the pair still current: the scenario did not remove them`);
    return verdict(problems, [`the pair ${child} -> ${origin}: merged, kept through a child-only re-derive, ended with its statements`]);
  },
};

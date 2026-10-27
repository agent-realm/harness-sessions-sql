// §8: "Edges outlive statements correctly: re-deriving the child alone keeps a merged edge
// (owner = 'engine') while the parent's statement stands. Removing every supporting statement ends
// it."
//
// The OpenCode child/task pair (opencode/features): the child's statement (at '') and the parent's
// `task` call merge into one edge, keyed on the child, stated_on 'both', at the call id.
// - Pass 2 re-derives the child alone (its title changed): the merged edge is kept, the same key
//   still current and still merged (stated_on 'both'). Its other columns may change.
// - Pass 3 removes the child's statement (its parent_id cleared) while the parent's stands: an
//   edge for the pair is still current (§4.5: an edge ends when its last supporting statement is
//   removed).
// - Pass 4 removes the parent's statement too (its task part deleted): no edge of the pair is
//   current.

import { verdict } from '../lib/result.mjs';
import { idOf } from '../lib/state.mjs';

export default {
  id: 'edges-outlive-statements',
  title: 'Edges outlive statements correctly',
  faults: ['engine:edges-from-pass', 'engine:edge-needs-all'],

  async engine(ctx) {
    const problems = [];
    const sc = ctx.scenario('edges');
    const { child, origin, at } = sc.pair;
    const ns = await ctx.namespace();
    const engine = await ctx.engine(ns);
    const edges = async () => (await ns.current('session_links')).filter((r) => r.owner === 'engine' && r.session_id === child && r.other_session_id === origin);
    const statements = async (sid) => (await ns.current('session_links')).filter((r) => r.owner === 'adapter' && r.session_id === sid);

    await engine.pass(sc.passes[0]);
    const first = await edges();
    if (first.length !== 1) problems.push(`pass 1: ${first.length} current edges for the pair, expected one merged edge`);
    else {
      if (first[0].stated_on !== 'both') problems.push(`pass 1: the edge is stated_on ${first[0].stated_on}, expected both`);
      if (first[0].at !== at) problems.push(`pass 1: the edge is at '${first[0].at}', expected the task call '${at}'`);
    }
    await engine.pass(sc.passes[1]);
    const second = await edges();
    const ids = (rows) => rows.map((r) => idOf('session_links', r)).sort().join('\n');
    if (ids(second) !== ids(first)) problems.push(`pass 2 (the child alone): the merged edge was not kept: ${second.map((r) => `stated_on ${r.stated_on}, at '${r.at}'`).join('; ') || 'none current'}`);
    else if (second.some((r) => r.stated_on !== 'both')) problems.push('pass 2 (the child alone): the edge is no longer merged (stated_on both)');
    await engine.pass(sc.passes[2]);
    if ((await statements(child)).some((r) => r.other_session_id === origin)) problems.push("pass 3: the child's statement is still current: the scenario did not remove it");
    const third = await edges();
    if (!third.length) problems.push("pass 3 (the child's statement removed, the parent's standing): no edge of the pair is current");
    await engine.pass(sc.passes[3]);
    const fourth = await edges();
    if (fourth.length) problems.push(`pass 4 (every statement removed): ${fourth.length} edge(s) still current`);
    const left = [...await statements(child), ...await statements(origin)].filter((r) => r.session_id === child ? r.other_session_id === origin : r.other_session_id === child);
    if (left.length) problems.push(`pass 4: ${left.length} statement(s) of the pair still current: the scenario did not remove them`);
    return verdict(problems, [`the pair ${child} -> ${origin}: merged; kept through a child-only re-derive; kept while one statement stands (${third.map((r) => `stated_on ${r.stated_on}`).join(', ') || 'none'}); ended with the last`]);
  },
};

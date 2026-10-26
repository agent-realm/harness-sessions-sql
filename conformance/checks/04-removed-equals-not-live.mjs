// §8: "Removed equals not live: after each pass, a session's current adapter-owned keys (not
// deleted, not removed) are exactly that pass's live sets. Every key that left live has a removed
// version, or a tombstone for a tombstoning consumer (sessions §4 allows either), and none of them
// counts in totals."
//
// The rewind scenario: a Copilot rewind (reset), an OpenCode revert and prompt-while-reverted
// (delta with gone rows), a Gemini `$rewindTo` (an append-only retraction). After each pass:
// - the current records equal the pass's `live` (plus a held key's last written version, sessions
//   §2), with the derived content_sha;
// - each key that left live is a removed version of its last row, so its adapter-set `state`
//   stays (the content_sha of a record covers its state), or is gone for a tombstoning engine;
// - totals over current rows (messages, usage tokens) equal the totals over the live records;
// - a retracted message stays current with state 'retracted'.

import { records } from '../lib/state.mjs';
import { verdict } from '../lib/result.mjs';

const TOKENS = ['input', 'output', 'cache_read', 'cache_write', 'reasoning', 'tool_prompt'];

export default {
  id: 'removed-equals-not-live',
  title: 'Removed equals not live',
  kind: 'engine',
  faults: ['engine:skip-removed'],

  async run(ctx) {
    const problems = [];
    const sc = ctx.scenario('rewind');
    const exp = ctx.expect(sc);
    const ns = await ctx.namespace();
    const engine = await ctx.engine(ns);
    const tomb = (engine.removal ?? 'removed') === 'tombstone';
    let removedSeen = 0;
    let retracted = 0;
    for (let i = 0; i < sc.passes.length; i++) {
      await engine.pass(sc.passes[i]);
      const at = `pass ${i + 1}`;
      const db = await records(ns);
      const want = new Map();
      for (const [sk, st] of exp[i]) for (const [rk, r] of st.current) want.set(`${sk}|${rk}`, r);
      for (const [k, r] of want) {
        const got = db.get(k);
        if (!got?.current) problems.push(`${at}: ${show(k)} is live but not current`);
        else if (!shaMatches(r, got, true)) problems.push(`${at}: ${show(k)} is current with another content_sha than its derived record`);
        if (r.type === 'message' && r.state === 'retracted') {
          retracted++;
          if (got?.current && !got.rows.filter(({ row }) => !Number(row.removed)).every(({ row }) => row.state === 'retracted')) problems.push(`${at}: ${show(k)} is retracted but its rows say otherwise`);
        }
      }
      for (const [k, got] of db) if (got.current && !want.has(k)) problems.push(`${at}: ${show(k)} is current but not live`);
      for (const [sk, st] of exp[i]) {
        for (const [rk, r] of st.removed) {
          const k = `${sk}|${rk}`;
          const got = db.get(k);
          removedSeen++;
          if (tomb) {
            if (got && !got.removed) problems.push(`${at}: ${show(k)} left live but is still current`);
          } else if (!got) problems.push(`${at}: ${show(k)} left live and has no removed version`);
          else if (!got.removed) problems.push(`${at}: ${show(k)} left live and is still current`);
          else if (!shaMatches(r, got, false)) problems.push(`${at}: the removed version of ${show(k)} is not a copy of its last row`);
        }
      }
      // Totals: current rows count exactly what the live records count.
      const wantTotals = totals([...want.values()].filter((r) => r.type === 'usage'), [...want.values()].filter((r) => r.type === 'message').length);
      const usage = (await ns.current('session_usage')).filter((r) => r.adapter !== 'legacy');
      const msgs = new Set((await ns.current('session_parts')).map((r) => `${r.host}|${r.harness_path}|${r.session_id}|${r.incarnation}|${r.message_id}`));
      const gotTotals = totals(usage, msgs.size);
      if (JSON.stringify(gotTotals) !== JSON.stringify(wantTotals)) problems.push(`${at}: totals over current rows ${JSON.stringify(gotTotals)}, over live records ${JSON.stringify(wantTotals)}`);
    }
    const notes = [`${sc.passes.length} passes; ${removedSeen} key(s) that left live checked; ${retracted} retracted message(s) checked current; totals compared after each pass`];
    if (!removedSeen) problems.push('the scenario removed no key: the check proves nothing');
    return verdict(problems, notes);
  },
};

const show = (k) => k.replace(/\u0000/g, '/').slice(0, 200);

// The record's rows carry its content_sha (a message's parts: as message_content_sha). For a
// current record only its current rows count: a part its message dropped is a removed row beside.
// For a removed record, the rows of its latest version (the highest rev) count.
function shaMatches(r, got, current) {
  const top = Math.max(...got.rows.map(({ row }) => Number(row.rev)));
  const rows = got.rows.filter(({ row }) => (current ? !Number(row.removed) : Number(row.rev) === top));
  if (r.type === 'message') return rows.every(({ row }) => row.message_content_sha === r.content_sha);
  return rows.every(({ row }) => row.content_sha === r.content_sha);
}

function totals(usage, messages) {
  const t = Object.fromEntries(TOKENS.map((c) => [c, 0]));
  for (const u of usage) for (const c of TOKENS) t[c] += Number(u[c] ?? 0);
  return { messages, usage: usage.length, ...t };
}

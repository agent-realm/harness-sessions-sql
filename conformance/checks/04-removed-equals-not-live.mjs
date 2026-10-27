// §8: "Removed equals not live: after each pass, a session's current adapter-owned keys (not
// deleted, not removed) are exactly that pass's live sets plus each key in held that was written
// before (sessions §2: a held key's last written version stands). Every key that left live and
// held has a removed version, or a tombstone for a tombstoning consumer (sessions §4 allows
// either), and none of them counts in totals."
//
// The rewind scenario: a Copilot rewind (reset), an OpenCode revert and prompt-while-reverted
// (delta with gone rows), a Gemini `$rewindTo` (an append-only retraction). After each pass:
// - the current records equal the pass's `live` (plus a held key's last written version, sessions
//   §2), with the derived content_sha;
// - each key that left live is a removed version of its last row, or is gone for a tombstoning
//   engine. "A full copy of its last row" (principle 3): its shas, and every other column of the
//   row it had before that pass (its adapter-set `state` included), apart from rev, removed,
//   is_deleted, ingested_at and writer;
// - totals over current rows (messages, usage tokens) equal the totals over the live records;
// - a retracted message stays current with state 'retracted'.

import { records, idOf } from '../lib/state.mjs';
import { recordProblems } from '../lib/compare.mjs';
import { norm } from '../lib/db.mjs';
import { verdict } from '../lib/result.mjs';

const TOKENS = ['input', 'output', 'cache_read', 'cache_write', 'reasoning', 'tool_prompt'];
// The columns a removed version may change: its version, its flags, when and by whom it was written.
const VERSION_COLUMNS = new Set(['rev', 'removed', 'is_deleted', 'ingested_at', 'writer']);

export default {
  id: 'removed-equals-not-live',
  title: 'Removed equals not live',
  faults: ['engine:skip-removed', 'engine:removed-rewrite'],

  async engine(ctx) {
    const problems = [];
    const sc = ctx.scenario('rewind');
    const exp = ctx.expect(sc);
    const ns = await ctx.namespace();
    const engine = await ctx.engine(ns);
    const tomb = (engine.removal ?? 'removed') === 'tombstone';
    let removedSeen = 0;
    let retracted = 0;
    let copies = 0;
    let before = new Map();
    for (let i = 0; i < sc.passes.length; i++) {
      await engine.pass(sc.passes[i]);
      const at = `pass ${i + 1}`;
      const db = await records(ns);
      const cmp = recordProblems(db, exp[i], { tomb, at });
      problems.push(...cmp.problems);
      // A key that left live in this pass: its removed version against the rows it had before.
      for (const { k, got } of tomb ? [] : cmp.removed) {
        const last = before.get(k);
        if (!last || !got?.removed) continue;
        const top = Math.max(...got.rows.map(({ row }) => Number(row.rev)));
        for (const { table, row } of got.rows.filter(({ row: x }) => Number(x.rev) === top)) {
          const old = last.find((x) => x.table === table && idOf(table, x.row) === idOf(table, row));
          if (!old) continue;
          copies++;
          const changed = [...new Set([...Object.keys(old.row), ...Object.keys(row)])].filter((c) => !VERSION_COLUMNS.has(c) && norm(old.row[c]) !== norm(row[c]));
          if (changed.length) problems.push(`${at}: the removed version of ${show(k)} is not a copy of its last row: ${changed.join(', ')} changed`);
        }
      }
      before = new Map([...db].filter(([, r]) => r.current).map(([k, r]) => [k, r.rows.filter(({ row }) => !Number(row.removed))]));
      const { want } = cmp;
      removedSeen += cmp.removed.length;
      for (const [k, r] of want) {
        const got = db.get(k);
        if (r.type === 'message' && r.state === 'retracted') {
          retracted++;
          if (got?.current && !got.rows.filter(({ row }) => !Number(row.removed)).every(({ row }) => row.state === 'retracted')) problems.push(`${at}: ${show(k)} is retracted but its rows say otherwise`);
        }
      }
      // Totals: current rows count exactly what the live records count.
      const wantTotals = totals([...want.values()].filter((r) => r.type === 'usage'), [...want.values()].filter((r) => r.type === 'message').length);
      const usage = (await ns.current('session_usage')).filter((r) => r.adapter !== 'legacy');
      const msgs = new Set((await ns.current('session_parts')).map((r) => `${r.host}|${r.harness_path}|${r.session_id}|${r.incarnation}|${r.message_id}`));
      const gotTotals = totals(usage, msgs.size);
      if (JSON.stringify(gotTotals) !== JSON.stringify(wantTotals)) problems.push(`${at}: totals over current rows ${JSON.stringify(gotTotals)}, over live records ${JSON.stringify(wantTotals)}`);
    }
    const notes = [`${sc.passes.length} passes; ${removedSeen} key(s) that left live checked, ${copies} removed row(s) compared column by column with the row before; ${retracted} retracted message(s) checked current; totals compared after each pass`];
    if (!tomb && !copies) problems.push('no removed version could be compared with its last row: the check proves nothing');
    if (!removedSeen) problems.push('the scenario removed no key: the check proves nothing');
    return verdict(problems, notes);
  },
};

const show = (k) => k.replace(/\u0000/g, '/').slice(0, 200);

function totals(usage, messages) {
  const t = Object.fromEntries(TOKENS.map((c) => [c, 0]));
  for (const u of usage) for (const c of TOKENS) t[c] += Number(u[c] ?? 0);
  return { messages, usage: usage.length, ...t };
}

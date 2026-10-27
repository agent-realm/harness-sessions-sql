// Example 03: records in, rows out. A few synthetic sessions-model records (a session, four
// messages with their parts, a tool call and its result, two usage records) are sealed as an
// adapter seals them, mapped to rows by the reference mapping (conformance/reference/rows.mjs),
// written, and read back with the reads of spec §6. See README.md.

import { runExample, inNamespace, dialect, table, show, EXAMPLE_HOST } from '../lib/example.mjs';
import { seal } from '../lib/records.mjs';
import { rowsOf } from '../../conformance/reference/rows.mjs';
import { insertRows } from '../../conformance/lib/db.mjs';
import { jcsSha } from '../../conformance/lib/jcs.mjs';

// The session key every record carries (sessions-model §1).
const S = { host: EXAMPLE_HOST, harness: 'example-harness', harness_path: '/home/user/.example-harness', session_id: 'example-session-3', incarnation: '' };
// What the adapter's output states (sessions §5): written into every row.
const META = { adapter: 'example-adapter', adapter_ver: '0.1.0', model_version: 'sessions-model/1' };

const message = (message_id, order, ts, role, parts, more = {}) => seal({
  type: 'message', ...S, message_id, parent_id: null, order, agent_id: '', role,
  source: role === 'user' ? 'user' : role === 'assistant' ? 'model' : null,
  to_user: null, to_model: null, status: 'complete', state: 'current', on_active_branch: null, ts,
  requested_model: null, served_model: null, effort: null, response_id: null, aliases: [], parts, ...more,
});

const messages = [
  message('m-1', '0001', '2026-01-02T09:00:00.000Z', 'user', [
    { part_id: '0', kind: 'text', text: 'List the files in this folder.' },
  ]),
  message('m-2', '0002', '2026-01-02T09:00:03.000Z', 'assistant', [
    { part_id: '0', kind: 'text', text: 'I will run ls.' },
    { part_id: '1', kind: 'tool_call', call_id: 'call-1', name: 'shell', args: { command: 'ls' }, server: null },
  ], { response_id: 'resp-1', served_model: 'example-model' }),
  message('m-3', '0003', '2026-01-02T09:00:04.000Z', 'tool', [
    { part_id: '0', kind: 'tool_result', call_id: 'call-1', is_error: null, status: 'completed', output: 'README.md\nsrc', output_len: 13, truncated: null, exit_code: 0 },
  ]),
  message('m-4', '0004', '2026-01-02T09:00:06.000Z', 'assistant', [
    { part_id: '0', kind: 'text', text: 'The folder holds README.md and src.' },
  ], { response_id: 'resp-2', served_model: 'example-model' }),
];

// Anthropic-style counts: cached input beside `input`, reasoning inside `output` (sessions-model §2.4).
const usage = (response_id, input, output, cache_read, cache_write) => seal({
  type: 'usage', ...S, usage_id: `response:${response_id}#1`, anchor: { response_id },
  input, output, cache_read, cache_write, reasoning: null, tool_prompt: null, cost: null,
  input_includes_cache: false, output_includes_reasoning: true, granularity: 'per_response', model: 'example-model',
});

const session = seal({
  type: 'session', ...S, engine: null, client: null, harness_version: null,
  title: 'List the project files', title_set_by: 'user', cwd: '/home/user/project', last_cwd: '/home/user/project',
  created_at: '2026-01-02T09:00:00.000Z', updated_at: '2026-01-02T09:00:06.000Z',
  state: 'active', pinned: null, mode: null, kind: null, reuse: 'impossible', ts_source: 'event', aliases: [],
  fingerprint: { cmp_shas: messages.map((m) => m.cmp_sha) }, setup: null,
});

const RECORDS = [session, ...messages, usage('resp-1', 120, 35, 900, 300), usage('resp-2', 15, 20, 1200, 40)];

await runExample({
  async run({ profile, target, namespace }) {
    const ns = await namespace();
    // Records to rows: the reference mapping, every row at rev 1 (a first write; example 02 shows
    // later versions). Plain inserts into empty tables, through the kit's insertRows.
    const byTable = new Map();
    for (const { table: t, row } of RECORDS.flatMap((r) => rowsOf(r, META))) {
      if (!byTable.has(t)) byTable.set(t, []);
      byTable.get(t).push({ ...row, rev: 1 });
    }
    for (const [t, rows] of byTable) await insertRows(ns, t, rows);
    console.log(`rows written: ${[...byTable].map(([t, rows]) => `${t} ${rows.length}`).join(', ')}`);

    const db = inNamespace(ns, target);
    const { final: F, current } = dialect(profile);
    try {
      console.log('the session, whole (its tables joined on the session key):');
      console.log(table(await db.query(`
        SELECT s.session_id AS session_id, s.title AS title, s.state AS state,
               count(DISTINCT p.message_id) AS messages, count(*) AS part_rows
        FROM sessions AS s ${F}
        JOIN session_parts AS p ${F}
          ON p.host = s.host AND p.harness = s.harness AND p.harness_path = s.harness_path
         AND p.session_id = s.session_id AND p.incarnation = s.incarnation
        WHERE ${current('s.')} AND ${current('p.')}
        GROUP BY s.session_id, s.title, s.state`)));

      console.log('its messages, one row per part, in order:');
      const parts = await db.query(`
        SELECT message_id, part_id, role, kind, text, tool_name, args, output
        FROM session_parts ${F}
        WHERE ${current()}
        ORDER BY order_key, ts, message_id, part_index`);
      console.log(table(parts.map((p) => ({
        message_id: p.message_id, part_id: p.part_id, role: p.role, kind: p.kind,
        says: p.kind === 'tool_call' ? `${p.tool_name} ${show(p.args)}` : p.kind === 'tool_result' ? JSON.stringify(p.output) : p.text,
      }))));

      console.log('tool calls with their results (joined on call_id):');
      console.log(table(await db.query(`
        SELECT c.tool_name AS tool, c.args AS args, r.is_error AS is_error, r.exit_code AS exit_code, r.output_len AS output_len
        FROM session_parts AS c ${F}
        JOIN session_parts AS r ${F}
          ON r.host = c.host AND r.harness = c.harness AND r.harness_path = c.harness_path
         AND r.session_id = c.session_id AND r.incarnation = c.incarnation AND r.call_id = c.call_id
        WHERE c.kind = 'tool_call' AND r.kind = 'tool_result' AND ${current('c.')} AND ${current('r.')}
        ORDER BY c.order_key`)));

      // The totals of spec §4.4: the stored counts, added up as the two flags say. Where a flag is
      // null, §4.4 does not say what the total is: this SQL leaves it null (unknown), a choice of
      // this example's own while that question is open. This example's records set both flags.
      console.log('usage, with the totals of spec §4.4:');
      console.log(table(await db.query(`
        SELECT usage_id, input, cache_read, cache_write, output,
               input + CASE WHEN input_includes_cache THEN 0
                            WHEN NOT input_includes_cache THEN cache_read + cache_write END
                     + coalesce(tool_prompt, 0) AS total_input,
               output + CASE WHEN output_includes_reasoning THEN 0
                             WHEN NOT output_includes_reasoning THEN reasoning END AS total_output
        FROM session_usage ${F}
        WHERE ${current()}
        ORDER BY usage_id`)));

      // Spec §4: a part row's content_sha is the sha of its part object as emitted, and its
      // message_content_sha the message's own content_sha. Checked against the records.
      const m2 = messages[1];
      const got = await db.query(`SELECT part_id, content_sha, message_content_sha FROM session_parts ${F} WHERE ${current()} AND message_id = 'm-2' ORDER BY part_index`);
      const want = m2.parts.map((p) => ({ part_id: p.part_id, content_sha: jcsSha(p), message_content_sha: m2.content_sha }));
      if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error('the shas of m-2\'s rows are not the shas of its records');
      console.log('the shas of m-2\'s two rows (first 12 hex digits; checked against its records):');
      console.log(table(got.map((r) => ({ part_id: r.part_id, content_sha: r.content_sha.slice(0, 12), message_content_sha: r.message_content_sha.slice(0, 12) }))));
    } finally {
      await db.close();
    }
  },
});

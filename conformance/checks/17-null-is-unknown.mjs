// §8: "Null is unknown: usage counters, exit_code and output_ref_bytes that the adapter emitted as
// null stay null in every database profile, and a part's own source or state survives beside its
// message's."
//
// Database part: a synthetic usage row with every counter and flag null, and a tool_result part
// row with exit_code, output_ref_bytes and output_len null and its own part_source and
// part_state, inserted with plain SQL and read back. (ClickHouse would turn a null into a non-
// Nullable column's default on insert, silently.)
// Engine part: the broad scenario. Every usage counter and flag, every tool_result's exit_code
// and output_ref_bytes, and every part's own source and state, compared with the record the
// adapter derived. No fixture emits a null input, output or output_ref_bytes; the database part
// covers those.

import { insertRows } from '../lib/db.mjs';
import { syntheticRows } from '../envelopes.mjs';
import { verdict } from '../lib/result.mjs';

const COUNTERS = ['input', 'output', 'cache_read', 'cache_write', 'reasoning', 'tool_prompt', 'cost'];
const FLAGS = ['input_includes_cache', 'output_includes_reasoning'];
const val = (v) => (v === null || v === undefined ? null : typeof v === 'boolean' ? v : Number(v));

export default {
  id: 'null-is-unknown',
  title: 'Null is unknown',
  kind: 'database, engine',
  faults: ['ddl:counters-not-null', 'engine:zero-nulls'],

  async run(ctx) {
    const problems = [];
    const notes = [];
    const ns = await ctx.namespace();
    const rows = syntheticRows();
    const usage = { ...rows.session_usage, ...Object.fromEntries([...COUNTERS, ...FLAGS].map((c) => [c, null])) };
    const part = { ...rows.session_parts, source: 'user', state: 'current', kind: 'tool_result', call_id: 'c-1', exit_code: null, output_ref: 'spill/1', output_ref_bytes: null, output_len: null, part_source: 'injected', part_state: 'reverted' };
    try {
      await insertRows(ns, 'session_usage', [usage]);
      await insertRows(ns, 'session_parts', [part]);
      const [u] = await ns.present('session_usage');
      for (const c of [...COUNTERS, ...FLAGS]) if (u[c] !== null) problems.push(`database: session_usage.${c} written null, read back ${u[c]}`);
      const [p] = await ns.present('session_parts');
      for (const c of ['exit_code', 'output_ref_bytes', 'output_len']) if (p[c] !== null) problems.push(`database: session_parts.${c} written null, read back ${p[c]}`);
      if (p.part_source !== 'injected' || p.part_state !== 'reverted' || p.source !== 'user' || p.state !== 'current') problems.push(`database: a part's own source and state did not survive beside its message's (${p.part_source}/${p.part_state} beside ${p.source}/${p.state})`);
    } catch (e) {
      problems.push(`database: a null was refused: ${e.message.slice(0, 200)}`);
    }

    const seen = { nullCounters: 0, values: 0, exitNull: 0, refBytes: 0, ownSource: 0, ownState: 0 };
    await ctx.enginePart(problems, async () => {
      const sc = ctx.scenario('broad');
      const exp = ctx.expect(sc).at(-1);
      const ens = await ctx.namespace();
      const engine = await ctx.engine(ens);
      for (const p of sc.passes) await engine.pass(p);
      const usageRows = new Map((await ens.current('session_usage')).map((r) => [`${r.host}|${r.harness_path}|${r.session_id}|${r.usage_id}`, r]));
      const partRows = new Map((await ens.current('session_parts')).map((r) => [`${r.host}|${r.harness_path}|${r.session_id}|${r.message_id}|${r.part_id}`, r]));
      for (const st of exp.values()) {
        for (const r of st.current.values()) {
          if (r.type === 'usage') {
            const row = usageRows.get(`${r.host}|${r.harness_path}|${r.session_id}|${r.usage_id}`);
            if (!row) { problems.push(`usage ${r.usage_id}: no current row`); continue; }
            for (const c of [...COUNTERS, ...FLAGS]) {
              if (r[c] === null) seen.nullCounters++;
              else seen.values++;
              if (val(row[c]) !== val(r[c])) problems.push(`usage ${r.usage_id}.${c}: the adapter emitted ${r[c]}, stored ${row[c]}`);
            }
          }
          if (r.type === 'message') {
            for (const p of r.parts ?? []) {
              const row = partRows.get(`${r.host}|${r.harness_path}|${r.session_id}|${r.message_id}|${p.part_id}`);
              if (!row) { problems.push(`part ${r.message_id}/${p.part_id}: no current row`); continue; }
              if (p.kind === 'tool_result') {
                if (p.exit_code === null) seen.exitNull++;
                if (val(row.exit_code) !== val(p.exit_code ?? null)) problems.push(`part ${r.message_id}/${p.part_id}: exit_code ${p.exit_code} emitted, ${row.exit_code} stored`);
                if (p.output_ref) {
                  seen.refBytes++;
                  if (val(row.output_ref_bytes) !== val(p.output_ref.bytes)) problems.push(`part ${r.message_id}/${p.part_id}: output_ref_bytes ${p.output_ref.bytes} emitted, ${row.output_ref_bytes} stored`);
                }
              }
              if (p.source) seen.ownSource++;
              if (p.state) seen.ownState++;
              if (row.part_source !== (p.source ?? '') || row.part_state !== (p.state ?? '')) problems.push(`part ${r.message_id}/${p.part_id}: own source/state ${p.source ?? ''}/${p.state ?? ''} emitted, ${row.part_source}/${row.part_state} stored`);
              if (row.source !== (r.source ?? '') || row.state !== r.state) problems.push(`part ${r.message_id}/${p.part_id}: its message's source/state ${r.source}/${r.state}, stored ${row.source}/${row.state}`);
            }
          }
        }
      }
    });
    notes.push(`database: every counter, flag, exit_code, output_ref_bytes and output_len null; engine: ${seen.nullCounters} null and ${seen.values} non-null counters, ${seen.exitNull} null exit_code, ${seen.refBytes} output_ref, ${seen.ownSource} own source, ${seen.ownState} own state`);
    return verdict(problems, notes);
  },
};

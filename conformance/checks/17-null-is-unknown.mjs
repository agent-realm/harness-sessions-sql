// §8: "Null is unknown: usage counters, exit_code and output_ref_bytes that the adapter emitted as
// null stay null in every database profile, and a part's own source or state survives beside its
// message's."
//
// Database part: a synthetic usage row with every counter and flag null, and a tool_result part
// row with exit_code, output_ref_bytes and output_len null and its own part_source and
// part_state, inserted with plain SQL and read back. (ClickHouse would turn a null into a non-
// Nullable column's default on insert, silently.)
// Engine part: the broad scenario, and refLost (a tool result whose output reference a newer
// version drops). Every usage counter and flag, every tool_result's exit_code and output
// reference (output_ref_bytes null, output_ref and its sha '', where the part has none), and every
// part's own source and state, compared with the record the adapter derived. No fixture emits a
// null input or output; the database part covers those.

import { insertRows } from '../lib/db.mjs';
import { syntheticRows } from '../envelopes.mjs';
import { verdict } from '../lib/result.mjs';

const COUNTERS = ['input', 'output', 'cache_read', 'cache_write', 'reasoning', 'tool_prompt', 'cost'];
const FLAGS = ['input_includes_cache', 'output_includes_reasoning'];
const val = (v) => (v === null || v === undefined ? null : typeof v === 'boolean' ? v : Number(v));

export default {
  id: 'null-is-unknown',
  title: 'Null is unknown',
  faults: ['ddl:counters-not-null', 'engine:zero-nulls', 'engine:pg-partial-upsert'],

  async database(ctx) {
    const problems = [];
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
    return verdict(problems, ['every counter, flag, exit_code, output_ref_bytes and output_len written null']);
  },

  async engine(ctx) {
    const problems = [];
    const seen = { nullCounters: 0, values: 0, exitNull: 0, refBytes: 0, refLost: 0, ownSource: 0, ownState: 0 };
    for (const name of ['broad', 'refLost']) {
      const sc = ctx.scenario(name);
      const exps = ctx.expect(sc);
      const exp = exps.at(-1);
      const ens = await ctx.namespace();
      const engine = await ctx.engine(ens);
      for (const p of sc.passes) await engine.pass(p);
      const usageRows = new Map((await ens.current('session_usage')).map((r) => [`${r.host}|${r.harness_path}|${r.session_id}|${r.usage_id}`, r]));
      const partRows = new Map((await ens.current('session_parts')).map((r) => [`${r.host}|${r.harness_path}|${r.session_id}|${r.message_id}|${r.part_id}`, r]));
      const at = (r, p) => `${name}: part ${r.message_id}/${p.part_id}`;
      for (const st of exp.values()) {
        for (const r of st.current.values()) {
          if (r.type === 'usage') {
            const row = usageRows.get(`${r.host}|${r.harness_path}|${r.session_id}|${r.usage_id}`);
            if (!row) { problems.push(`${name}: usage ${r.usage_id}: no current row`); continue; }
            for (const c of [...COUNTERS, ...FLAGS]) {
              if (r[c] === null) seen.nullCounters++;
              else seen.values++;
              if (val(row[c]) !== val(r[c])) problems.push(`${name}: usage ${r.usage_id}.${c}: the adapter emitted ${r[c]}, stored ${row[c]}`);
            }
          }
          if (r.type === 'message') {
            for (const p of r.parts ?? []) {
              const row = partRows.get(`${r.host}|${r.harness_path}|${r.session_id}|${r.message_id}|${p.part_id}`);
              if (!row) { problems.push(`${at(r, p)}: no current row`); continue; }
              if (p.kind === 'tool_result') {
                if (p.exit_code === null) seen.exitNull++;
                if (val(row.exit_code) !== val(p.exit_code ?? null)) problems.push(`${at(r, p)}: exit_code ${p.exit_code} emitted, ${row.exit_code} stored`);
                // The output reference as emitted, or none: a part with no output_ref has no
                // output_ref_bytes (null) and no ref or sha (''), whatever an earlier version had.
                if (p.output_ref) seen.refBytes++;
                const ref = p.output_ref ?? null;
                if (val(row.output_ref_bytes) !== val(ref?.bytes ?? null)) problems.push(`${at(r, p)}: output_ref_bytes ${ref?.bytes ?? null} emitted, ${row.output_ref_bytes} stored`);
                if ((row.output_ref ?? '') !== (ref?.ref ?? '') || (row.output_ref_sha256 ?? '') !== (ref?.sha256 ?? '')) problems.push(`${at(r, p)}: output_ref ${ref ? `${ref.ref}/${ref.sha256}` : 'none'} emitted, ${row.output_ref}/${row.output_ref_sha256} stored`);
              }
              if (p.source) seen.ownSource++;
              if (p.state) seen.ownState++;
              // §4.3: a part's own source and state, where they differ from its message's; '' where
              // it has none. Where its own equals its message's, either the value or '' is kept.
              const own = (mine, msg, stored) => stored === (mine ?? '') || (mine != null && mine === msg && stored === '');
              if (!own(p.source, r.source, row.part_source) || !own(p.state, r.state, row.part_state)) problems.push(`${at(r, p)}: own source/state ${p.source ?? ''}/${p.state ?? ''} emitted, ${row.part_source}/${row.part_state} stored`);
              if (row.source !== (r.source ?? '') || row.state !== r.state) problems.push(`${at(r, p)}: its message's source/state ${r.source}/${r.state}, stored ${row.source}/${row.state}`);
            }
          }
        }
      }
      if (name === 'refLost') {
        const refs = (snap) => new Set([...snap.values()].flatMap((st) => [...st.current.values()].flatMap((r) => (r.parts ?? []).filter((p) => p.kind === 'tool_result' && p.output_ref).map((p) => `${r.session_id}|${r.message_id}|${p.part_id}`))));
        const now = refs(exp);
        seen.refLost = [...refs(exps[0])].filter((k) => !now.has(k)).length;
        if (!seen.refLost) problems.push('refLost: no tool_result lost its output_ref: the scenario proves nothing');
      }
    }
    return verdict(problems, [`${seen.nullCounters} null and ${seen.values} non-null counters, ${seen.exitNull} null exit_code, ${seen.refBytes} output_ref, ${seen.refLost} output_ref lost by a newer version, ${seen.ownSource} own source, ${seen.ownState} own state`]);
  },
};

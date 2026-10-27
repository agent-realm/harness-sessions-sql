// The reference engine's mapping of sessions-model records to the rows of spec §4, and the edge
// rows it projects from link statements (§4.5). Rows here are logical: plain values, before a
// profile's own encoding (see `encodeRow` in engine.mjs).

import { jcs, jcsSha } from '../lib/jcs.mjs';
import { linkTableKey, SESSION_KEY } from '../lib/keys.mjs';

// The identity of every table, as spec §3 states it and both DDL files declare it.
export const IDENTITY = {
  session_units: [...SESSION_KEY, 'source_key', 'generation', 'unit_key', 'chunk', 'sha256'],
  session_sources: [...SESSION_KEY, 'source_key'],
  sessions: [...SESSION_KEY],
  session_parts: [...SESSION_KEY, 'message_id', 'part_id'],
  session_usage: [...SESSION_KEY, 'usage_id'],
  session_links: [...SESSION_KEY, 'owner', 'kind', 'other_host', 'other_harness_path', 'other_harness', 'other_session_id', 'other_incarnation', 'at'],
  session_lifecycle: [...SESSION_KEY, 'lifecycle_id'],
};

// Columns holding JSON: canonical JSON text in ClickHouse where the column is a String, jsonb in
// PostgreSQL. ClickHouse keeps `aliases`, `message_aliases` and `statements` as arrays of tuples.
// In a logical row, `args` and `setup` are canonical JSON text (or null), the others arrays.
export const JSON_COLUMNS = {
  sessions: ['aliases', 'setup'],
  session_parts: ['message_aliases', 'args'],
  session_links: ['statements'],
};
export const CH_STRING_JSON = { sessions: ['setup'], session_parts: ['args'] };

export const rowKey = (table, row) => IDENTITY[table].map((c) => String(row[c] ?? '')).join('\u0000');

// adapter_ver is the version string the adapter's output states (sessions §5, `0.2.0`). Both
// database profiles keep it in a string column, as given (spec §4): no encoding, no order.
export function statedAdapterVer(v) {
  if (v === null || v === undefined || v === '') throw new Error('adapter_ver: the adapter states none');
  return String(v);
}

// A boolean as either profile reads it back (ClickHouse and PostgreSQL booleans, or 1/0, or
// their text), null kept.
export const bool = (v) => (v === true || v === 1 || v === 'true' ? true : v === false || v === 0 || v === 'false' ? false : v ?? null);

const s = (v) => (v === null || v === undefined ? '' : String(v));
const n = (v) => (v === undefined ? null : v);
const sessionCols = (r) => ({ host: r.host, harness: r.harness, harness_path: r.harness_path, session_id: r.session_id, incarnation: r.incarnation ?? '' });

// The rows of one record: [{ table, row }]. `meta`: { adapter, adapter_ver, model_version }.
export function rowsOf(r, meta) {
  const common = { adapter: meta.adapter, adapter_ver: statedAdapterVer(meta.adapter_ver), model_version: meta.model_version, is_deleted: 0, removed: 0 };
  switch (r.type) {
    case 'session':
      return [{
        table: 'sessions',
        row: {
          ...sessionCols(r),
          host_label: '',
          engine: s(r.engine), client: s(r.client), harness_version: s(r.harness_version),
          title: s(r.title), title_set_by: r.title_set_by ?? 'unknown', cwd: s(r.cwd), last_cwd: s(r.last_cwd),
          created_at: n(r.created_at), updated_at: n(r.updated_at),
          state: r.state, pinned: n(r.pinned), mode: s(r.mode), kind: s(r.kind), reuse: r.reuse, ts_source: r.ts_source,
          aliases: (r.aliases ?? []).map((a) => ({ id: s(a.id), kind: s(a.kind) })),
          fingerprint: r.fingerprint?.cmp_shas ?? [],
          setup: r.setup === null || r.setup === undefined ? null : jcs(r.setup),
          content_sha: r.content_sha,
          ...common,
        },
      }];
    case 'message': {
      const msg = {
        ...sessionCols(r),
        message_id: r.message_id,
        parent_id: s(r.parent_id), order_key: s(r.order), agent_id: s(r.agent_id),
        role: r.role, source: s(r.source), to_user: n(r.to_user), to_model: n(r.to_model),
        status: r.status, state: r.state, on_active_branch: n(r.on_active_branch),
        ts: n(r.ts), requested_model: s(r.requested_model), served_model: s(r.served_model), effort: s(r.effort),
        response_id: s(r.response_id),
        message_aliases: (r.aliases ?? []).map((a) => ({ id: s(a.id), kind: s(a.kind) })),
        cmp_sha: r.cmp_sha, message_content_sha: r.content_sha,
        ...common,
      };
      const parts = r.parts ?? [];
      // A message with no parts keeps one header row (spec §3): part_id '', kind 'none', the
      // message's sha in both columns.
      if (!parts.length) return [{ table: 'session_parts', row: { ...msg, part_id: '', part_index: 0, kind: 'none', content_sha: r.content_sha } }];
      return parts.map((p, i) => ({ table: 'session_parts', row: { ...msg, ...partCols(p), part_index: i, content_sha: jcsSha(p) } }));
    }
    case 'usage': {
      const [anchorKind, anchorId] = anchorOf(r.anchor);
      return [{
        table: 'session_usage',
        row: {
          ...sessionCols(r),
          usage_id: r.usage_id, anchor_kind: anchorKind, anchor_id: anchorId,
          input: n(r.input), output: n(r.output), cache_read: n(r.cache_read), cache_write: n(r.cache_write),
          reasoning: n(r.reasoning), tool_prompt: n(r.tool_prompt), cost: n(r.cost),
          input_includes_cache: n(r.input_includes_cache), output_includes_reasoning: n(r.output_includes_reasoning),
          granularity: r.granularity, model: s(r.model),
          content_sha: r.content_sha,
          ...common,
        },
      }];
    }
    case 'link': {
      const other = r.stated_on === 'origin' ? r.child : r.origin;
      const ref = (prefix, x) => ({
        [`${prefix}_host`]: s(x?.host), [`${prefix}_harness_path`]: s(x?.harness_path), [`${prefix}_harness`]: s(x?.harness),
        [`${prefix}_session_id`]: s(x?.session_id), [`${prefix}_incarnation`]: x?.incarnation ?? null,
      });
      const inh = r.inherits ?? {};
      return [{
        table: 'session_links',
        row: {
          ...sessionCols(r),
          owner: 'adapter', kind: r.kind,
          other_host: s(other?.host), other_harness_path: s(other?.harness_path), other_harness: s(other?.harness),
          other_session_id: s(other?.session_id), other_incarnation: s(other?.incarnation), at: s(r.at),
          stated_on: r.stated_on,
          ...ref('child', r.child), ...ref('origin', r.origin),
          through_message_id: s(inh.through_message_id), ids_preserved: n(inh.ids_preserved), marked: n(inh.marked), usage_copied: n(inh.usage_copied),
          // null is unknown (an origin-side statement that does not say), kept null (spec §4.5).
          child_stored: n(r.child_stored),
          evidence: r.evidence ?? 'explicit', verified: null, statements: [],
          content_sha: r.content_sha,
          ...common,
        },
      }];
    }
    case 'lifecycle': {
      const t = r.target ?? {};
      const target = t.message_id !== undefined ? { target_kind: 'message', target_id: s(t.message_id) }
        : t.range ? { target_kind: 'range', target_from: s(t.range.from_id), target_through: s(t.range.through_id) }
          : { target_kind: 'session' };
      return [{
        table: 'session_lifecycle',
        row: {
          ...sessionCols(r),
          lifecycle_id: r.lifecycle_id, op: r.op,
          target_id: '', target_from: '', target_through: '', ...target,
          at: s(r.at), ts: n(r.ts), evidence: r.evidence ?? 'explicit',
          content_sha: r.content_sha,
          ...common,
        },
      }];
    }
    default:
      throw new Error(`unknown record type ${r.type}`);
  }
}

function anchorOf(a = {}) {
  if (a.response_id !== undefined) return ['response', s(a.response_id)];
  if (a.message_id !== undefined) return ['message', s(a.message_id)];
  if (a.compaction !== undefined) return ['compaction', typeof a.compaction === 'string' ? a.compaction : ''];
  return ['session', ''];
}

function partCols(p) {
  const out = { part_id: s(p.part_id), kind: p.kind, text: s(p.text) };
  if (p.kind === 'tool_call') Object.assign(out, { call_id: s(p.call_id), tool_name: s(p.name), args: p.args === undefined || p.args === null ? null : jcs(p.args), server: s(p.server) });
  if (p.kind === 'tool_result') {
    Object.assign(out, {
      call_id: s(p.call_id), is_error: n(p.is_error), result_status: s(p.status), output: s(p.output),
      output_len: n(p.output_len), truncated: n(p.truncated), exit_code: n(p.exit_code),
    });
    if (p.output_ref) Object.assign(out, { output_ref: s(p.output_ref.ref), output_ref_sha256: s(p.output_ref.sha256), output_ref_bytes: n(p.output_ref.bytes) });
  }
  if (p.kind === 'attachment') Object.assign(out, { media_type: s(p.media_type), inline_b64: s(p.inline), ref: s(p.ref), bytes_len: n(p.bytes_len) });
  if (p.kind === 'reasoning') Object.assign(out, { opaque: n(p.opaque), signature_len: n(p.signature_len) });
  if (p.kind === 'summary') {
    const rep = p.replaces;
    if (rep === 'unknown' || rep === undefined || rep === null) Object.assign(out, { replaces_form: rep ? 'unknown' : '', replaces_value: '' });
    else {
      const [form, value] = Object.entries(rep)[0] ?? ['unknown', ''];
      Object.assign(out, { replaces_form: form, replaces_value: typeof value === 'string' ? value : jcs(value) });
    }
  }
  if (p.kind === 'error') Object.assign(out, { error_kind: s(p.error_kind), error_message: s(p.message), http_status: n(p.http_status) });
  if (p.kind === 'notice') Object.assign(out, { level: s(p.level), native_type: s(p.native_type) });
  out.part_source = s(p.source);
  out.part_state = s(p.state);
  return out;
}

// ---- edges (spec §4.5, sessions-model §2.5) ---------------------------------------------------

// The reference resolves a reference within the harness store it names (by default the stating
// session's own), and only when exactly one held session matches; an edge is written only when
// both its ends resolve. Statements of one edge merge when kind and both ends agree and `at` is
// equal or empty on one side; otherwise each statement is an edge of its own.
export function edgesOf(statements, heldSessions) {
  const held = new Map();
  for (const h of heldSessions) {
    const k = [h.host, h.harness_path, h.harness, h.session_id].join('\u0000');
    if (!held.has(k)) held.set(k, []);
    held.get(k).push(h);
  }
  const resolve = (st, prefix) => {
    const host = st[`${prefix}_host`] || st.host;
    const hp = st[`${prefix}_harness_path`] || st.harness_path;
    const inc = st[`${prefix}_incarnation`];
    const cands = (held.get([host, hp, st[`${prefix}_harness`], st[`${prefix}_session_id`]].join('\u0000')) ?? [])
      .filter((h) => inc === null || inc === undefined || h.incarnation === inc);
    return cands.length === 1 ? cands[0] : null;
  };
  const skey = (x) => [x.host, x.harness, x.harness_path, x.session_id, x.incarnation].join('\u0000');
  const groups = new Map();
  for (const st of statements) {
    const child = resolve(st, 'child');
    const origin = resolve(st, 'origin');
    if (!child || !origin) continue;
    const g = `${st.kind}\u0001${skey(child)}\u0001${skey(origin)}`;
    if (!groups.has(g)) groups.set(g, { kind: st.kind, child, origin, child_side: [], origin_side: [] });
    groups.get(g)[st.stated_on === 'origin' ? 'origin_side' : 'child_side'].push(st);
  }
  const edges = [];
  for (const g of groups.values()) {
    const [c, o] = [g.child_side, g.origin_side];
    if (c.length === 1 && o.length === 1 && (c[0].at === o[0].at || c[0].at === '' || o[0].at === '')) {
      edges.push(edgeRow(g, 'both', c[0].at || o[0].at, [c[0], o[0]]));
    } else {
      const byAt = new Map();
      for (const st of [...c, ...o]) {
        const k = `${st.stated_on}\u0000${st.at}`;
        if (!byAt.has(k)) byAt.set(k, []);
        byAt.get(k).push(st);
      }
      for (const sts of byAt.values()) edges.push(edgeRow(g, sts[0].stated_on, sts[0].at, sts));
    }
  }
  return edges;
}

function edgeRow(g, statedOn, at, sts) {
  const { child, origin } = g;
  const same = origin.host === child.host && origin.harness_path === child.harness_path;
  const first = (f) => sts.map((x) => x[f]).find((v) => v !== null && v !== undefined && v !== '') ?? null;
  const supporting = sts.map((x) => ({ host: x.host, harness: x.harness, harness_path: x.harness_path, session_id: x.session_id, incarnation: x.incarnation }))
    .sort((a, b) => (jcs(a) < jcs(b) ? -1 : 1));
  const lead = sts.find((x) => x.stated_on === 'child') ?? sts[0];
  const edge = {
    host: child.host, harness: child.harness, harness_path: child.harness_path, session_id: child.session_id, incarnation: child.incarnation,
    owner: 'engine', kind: g.kind,
    other_host: same ? '' : origin.host, other_harness_path: same ? '' : origin.harness_path, other_harness: origin.harness,
    other_session_id: origin.session_id, other_incarnation: origin.incarnation, at,
    stated_on: statedOn,
    child_host: '', child_harness_path: '', child_harness: child.harness, child_session_id: child.session_id, child_incarnation: child.incarnation,
    origin_host: same ? '' : origin.host, origin_harness_path: same ? '' : origin.harness_path, origin_harness: origin.harness,
    origin_session_id: origin.session_id, origin_incarnation: origin.incarnation,
    through_message_id: first('through_message_id') ?? '', ids_preserved: first('ids_preserved'), marked: first('marked'), usage_copied: first('usage_copied'),
    // false when a supporting statement says the child was never stored, true when one says it
    // was, and null (unknown) when none says.
    child_stored: sts.some((x) => bool(x.child_stored) === false) ? false : sts.some((x) => bool(x.child_stored) === true) ? true : null,
    evidence: 'explicit', verified: null, statements: supporting,
  };
  for (const f of ['ids_preserved', 'marked', 'usage_copied']) edge[f] = bool(edge[f]);
  return { ...edge, content_sha: jcsSha(edge), adapter: lead.adapter, adapter_ver: statedAdapterVer(lead.adapter_ver), model_version: lead.model_version, is_deleted: 0, removed: 0 };
}

export { linkTableKey };

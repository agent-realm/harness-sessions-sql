// Keys, as the specification maps them:
// - a record's key within its session (sessions-model §1), as `live` lists it per type;
// - its `rk`: one string per adapter-owned record, `<type>\0<key>`, used to compare what a
//   derive says is live with what the tables hold;
// - a link statement's table key (spec §3, §4.5): `live` names a statement by the JCS of
//   [kind, other side's reference, at], the table by (owner, kind, other_host,
//   other_harness_path, other_harness, other_session_id, other_incarnation, at), where an absent
//   host, harness_path or incarnation is ''.

import { jcs } from './jcs.mjs';

export const SESSION_KEY = ['host', 'harness', 'harness_path', 'session_id', 'incarnation'];
const SEP = '\u0000';

export const sessionKeyOf = (o) => SESSION_KEY.map((k) => String(o[k] ?? '')).join(SEP);
export const sessionKeyObject = (store, session) => ({
  host: store.host,
  harness: store.harness,
  harness_path: store.harness_path,
  session_id: session.session_id,
  incarnation: session.incarnation ?? '',
});

export function recordKey(r) {
  switch (r.type) {
    case 'session': return '';
    case 'message': return r.message_id;
    case 'usage': return r.usage_id;
    case 'lifecycle': return r.lifecycle_id;
    case 'link': return jcs([r.kind, r.stated_on === 'origin' ? r.child : r.origin, r.at ?? '']);
    default: throw new TypeError(`unknown record type ${r.type}`);
  }
}

// The table key of a link statement, from its kind, the other side's reference and at.
export function linkTableKey(kind, ref, at) {
  return ['adapter', kind, ref?.host ?? '', ref?.harness_path ?? '', ref?.harness ?? '', ref?.session_id ?? '', ref?.incarnation ?? '', at ?? ''].join(SEP);
}

// The rk of a `live` or `held` entry: links go through their table key.
export function rkOfLive(type, key) {
  if (type === 'link') {
    const [kind, ref, at] = JSON.parse(key);
    return `link${SEP}${linkTableKey(kind, ref, at)}`;
  }
  return `${type}${SEP}${key}`;
}

export const rkOfRecord = (r) => rkOfLive(r.type, recordKey(r));

// The rk of a table row of an adapter-owned record, or null for a row that is not one (an engine
// edge).
export function rkOfRow(table, row) {
  switch (table) {
    case 'sessions': return `session${SEP}`;
    case 'session_parts': return `message${SEP}${row.message_id}`;
    case 'session_usage': return `usage${SEP}${row.usage_id}`;
    case 'session_lifecycle': return `lifecycle${SEP}${row.lifecycle_id}`;
    case 'session_links':
      if (row.owner !== 'adapter') return null;
      return `link${SEP}${['adapter', row.kind, row.other_host, row.other_harness_path, row.other_harness, row.other_session_id, row.other_incarnation, row.at].join(SEP)}`;
    default: return null;
  }
}

// Every `live` (or `held`) set of a derive, as rks.
export function rksOf(sets = {}) {
  const out = new Set();
  for (const [type, keys] of Object.entries(sets)) for (const k of keys) out.add(rkOfLive(type, k));
  return out;
}

export const ENTITY_TABLES = ['sessions', 'session_parts', 'session_usage', 'session_links', 'session_lifecycle'];
export const ALL_TABLES = ['session_units', 'session_sources', ...ENTITY_TABLES];

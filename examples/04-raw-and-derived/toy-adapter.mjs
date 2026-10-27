// A toy session adapter, written for this example only: not a session adapter of any harness (the
// real ones are the session-adapters package's, example 05). Its harness store keeps a session as
// one JSONL file, one line per message: {"id", "role", "text"}. It offers the two operations the
// reference engine calls, after the `sessions` seam:
// - read(source_key, text, from): one read of the file from the position `from`, with the
//   continuity of sessions §3: `reset` for a first read or a file now shorter than `from` (a
//   rewrite), `appended` for new whole lines, `unchanged` for none. A unit is one whole line, its
//   unit_key the decimal byte offset where it starts; a partial last line waits until it is whole.
//   (A real adapter tells a rewrite by the file's identity, not by its length alone.)
// - derive(session, input): every record of the session from its current units, in full: one
//   session record and one message record per line, sealed (sessions-model §2), with the `live`
//   keys that say what exists now.

import { sha256 } from '../../conformance/lib/jcs.mjs';
import { seal } from '../lib/records.mjs';

export const HARNESS = 'toy-harness';

const DESCRIBE = { harness: HARNESS, adapter: 'toy-adapter', adapter_ver: '0.1.0', model_version: 'sessions-model/1', state_ver: 1 };
export const describe = () => DESCRIBE;

export function read(source_key, text, from) {
  const bytes = Buffer.from(text, 'utf8');
  const fresh = !from || from.offset > bytes.length;
  const units = [];
  let at = fresh ? 0 : from.offset;
  for (let nl = bytes.indexOf(0x0a, at); nl >= 0; nl = bytes.indexOf(0x0a, at)) {
    const line = bytes.subarray(at, nl);
    units.push({ source_key, unit_key: String(at), enc: 'utf8', bytes: line.length, sha256: sha256(line), redacted: false, body: line.toString('utf8') });
    at = nl + 1;
  }
  return { continuity: fresh ? 'reset' : units.length ? 'appended' : 'unchanged', units, gone: [], position: { offset: at }, held_back: [] };
}

export function derive(session, input) {
  const units = input.flatMap((source) => source.units).sort((a, b) => Number(a.unit_key) - Number(b.unit_key));
  const messages = units.map((u) => {
    const line = JSON.parse(u.body);
    return seal({
      type: 'message', ...session, message_id: line.id, parent_id: null, order: u.unit_key.padStart(12, '0'), agent_id: '',
      role: line.role, source: line.role === 'user' ? 'user' : 'model', to_user: null, to_model: null,
      status: 'complete', state: 'current', on_active_branch: null, ts: null,
      requested_model: null, served_model: null, effort: null, response_id: null, aliases: [],
      parts: [{ part_id: '0', kind: 'text', text: line.text }],
    });
  });
  // The toy store keeps no time, so every ts is null and ts_source is `none`.
  const record = seal({
    type: 'session', ...session, engine: null, client: null, harness_version: null,
    title: null, title_set_by: null, cwd: null, last_cwd: null, created_at: null, updated_at: null,
    state: 'active', pinned: null, mode: null, kind: null, reuse: 'impossible', ts_source: 'none', aliases: [],
    fingerprint: { cmp_shas: messages.map((m) => m.cmp_sha) }, setup: null,
  });
  return { changed: [record, ...messages], live: { session: [''], message: messages.map((m) => m.message_id) }, held: {} };
}

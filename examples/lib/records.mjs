// The two hashes of a sessions-model record (sessions-model §2), as an adapter seals the records it
// derives. The examples write their records by hand (03) or derive them with a toy adapter (04),
// so they seal them here, the way the session-adapters package's own seal does (its
// src/records.js, which the package does not export):
// - members the model gives every record of a type, filled in where a record leaves them out, as
//   the package's seal fills them: `exit_code: null` on a tool_result part, `setup: null` on a
//   session, `tool_prompt: null` on a usage record;
// - content_sha: the sha256 of the record's JCS canonical JSON, without content_sha and cmp_sha;
// - cmp_sha, on a message only: the sha256 of the JCS of {role, parts}, each part reduced to what
//   it says: the text of a text part, the name and args of a tool call, the output and is_error of
//   a tool result. The examples hold no other part kind, so any other is refused here.
// JCS and sha256 are the conformance kit's (conformance/lib/jcs.mjs). The examples' test checks
// this seal against the package's (examples/test.mjs).

import { jcsSha } from '../../conformance/lib/jcs.mjs';

function said(p) {
  switch (p.kind) {
    case 'text':
      return { kind: p.kind, text: p.text ?? null };
    case 'tool_call':
      return { kind: p.kind, name: p.name ?? null, args: p.args ?? null };
    case 'tool_result':
      return { kind: p.kind, output: p.output ?? null, is_error: p.is_error ?? null };
    default:
      throw new Error(`the examples' records hold no ${p.kind} part`);
  }
}

export const cmpSha = (message) => jcsSha({ role: message.role, parts: (message.parts ?? []).map(said) });

// The members every record of the type has (sessions-model §2.1, §2.3, §2.4), null where the
// record leaves them out.
function filled(r) {
  const out = { ...r };
  if (out.type === 'message' && Array.isArray(out.parts)) {
    out.parts = out.parts.map((p) => (p && p.kind === 'tool_result' && !('exit_code' in p) ? { ...p, exit_code: null } : p));
  }
  if (out.type === 'session' && !('setup' in out)) out.setup = null;
  if (out.type === 'usage' && !('tool_prompt' in out)) out.tool_prompt = null;
  return out;
}

// The record with its members filled in and its hashes set: cmp_sha on a message, then
// content_sha on every record.
export function seal(record) {
  const { content_sha: _c, cmp_sha: _m, ...rest } = filled(record);
  return { ...rest, ...(rest.type === 'message' ? { cmp_sha: cmpSha(rest) } : {}), content_sha: jcsSha(rest) };
}

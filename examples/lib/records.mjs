// The two hashes of a sessions-model record (sessions-model §2), as an adapter seals the records it
// derives. The examples write their records by hand (03) or derive them with a toy adapter (04),
// so they seal them here:
// - content_sha: the sha256 of the record's JCS canonical JSON, without content_sha and cmp_sha;
// - cmp_sha, on a message only: the sha256 of the JCS of {role, parts}, each part reduced to what
//   it says: the text of a text part, the name and args of a tool call, the output and is_error of
//   a tool result. The examples hold no other part kind, so any other is refused here.
// JCS and sha256 are the conformance kit's (conformance/lib/jcs.mjs).

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

// The record with its hashes set: cmp_sha on a message, then content_sha on every record.
export function seal(record) {
  const { content_sha: _c, cmp_sha: _m, ...rest } = record;
  return { ...rest, ...(rest.type === 'message' ? { cmp_sha: cmpSha(rest) } : {}), content_sha: jcsSha(rest) };
}

// §8: "Zero-part messages: an assistant message with content: [] keeps one row (kind = 'none')."
//
// opencode/edits holds an assistant message with no parts. Every message the adapter derived with
// no parts must be exactly one current session_parts row: part_id '', kind 'none', and the
// message's content_sha in both sha columns (spec §4).

import { verdict } from '../lib/result.mjs';

export default {
  id: 'zero-part-messages',
  title: 'Zero-part messages',
  kind: 'engine',
  faults: ['engine:drop-empty'],

  async run(ctx) {
    const problems = [];
    const sc = ctx.scenario('zeroPart');
    const exp = ctx.expect(sc).at(-1);
    const ns = await ctx.namespace();
    const engine = await ctx.engine(ns);
    for (const p of sc.passes) await engine.pass(p);
    const parts = await ns.current('session_parts');
    let n = 0;
    for (const st of exp.values()) {
      for (const r of st.current.values()) {
        if (r.type !== 'message' || (r.parts ?? []).length) continue;
        n++;
        const rows = parts.filter((x) => x.session_id === r.session_id && x.harness_path === r.harness_path && x.message_id === r.message_id);
        if (rows.length !== 1) problems.push(`${r.message_id}: ${rows.length} rows, expected one`);
        else {
          const [x] = rows;
          if (x.part_id !== '' || x.kind !== 'none') problems.push(`${r.message_id}: its row is part_id '${x.part_id}', kind '${x.kind}'`);
          if (x.content_sha !== r.content_sha || x.message_content_sha !== r.content_sha) problems.push(`${r.message_id}: its row does not carry the message's content_sha in both columns`);
        }
      }
    }
    if (!n) problems.push('no zero-part message in the scenario: the check proves nothing');
    return verdict(problems, [`${n} zero-part message(s) checked`]);
  },
};

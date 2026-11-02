// §8 (v1.1): "Native is declared: every key in a `native` column (sessions.native,
// session_parts.message_native and part_native) is a path that the harness's adapter declares in
// describe() for that record type, and the column holds the record's `native` as the adapter
// derived it: canonical JSON, or nothing where the record has none."
//
// The broad scenario through the engine (sessions-model v1.4: an adapter that declares native
// paths fills `native`, one that declares none leaves it absent). After the pass, every current
// session and part row: each key of each native column must be in the adapter's describe().native
// list for the record type (session, message, part), and the column must equal the derived
// record's `native`, compared as canonical JSON ('' or null where the record has none). Over the
// run, at least one row holds a native value, so the check proves something.

import { verdict } from '../lib/result.mjs';
import { jcs } from '../lib/jcs.mjs';
import { sessionKeyOf } from '../lib/keys.mjs';

// A native column as stored, as canonical JSON, or null where it holds none: '' (ClickHouse) and
// null (PostgreSQL) alike.
function stored(v) {
  if (v === null || v === undefined || v === '') return null;
  return jcs(typeof v === 'string' ? JSON.parse(v) : v);
}
const derived = (v) => (v === null || v === undefined ? null : jcs(v));

export default {
  id: 'native-is-declared',
  title: 'Native is declared',
  faults: ['engine:native-leftovers', 'engine:native-dropped'],

  async engine(ctx) {
    const problems = [];
    let held = 0;
    const sc = ctx.scenario('broad');
    const exp = ctx.expect(sc).at(-1);
    const ns = await ctx.namespace();
    const engine = await ctx.engine(ns);
    for (const p of sc.passes) await engine.pass(p);
    const declared = (harness, type) => ctx.adapters.adapterFor(harness).describe().native?.[type] ?? [];
    const sessions = new Map((await ns.current('sessions')).map((r) => [sessionKeyOf(r), r]));
    const parts = new Map((await ns.current('session_parts')).map((r) => [`${sessionKeyOf(r)}|${r.message_id}|${r.part_id}`, r]));
    const judge = (at, harness, type, column, record) => {
      let got;
      try {
        got = stored(column);
      } catch {
        problems.push(`${at}: the column does not hold JSON`);
        return;
      }
      if (got !== null) {
        held++;
        const allowed = new Set(declared(harness, type));
        for (const k of Object.keys(JSON.parse(got))) if (!allowed.has(k)) problems.push(`${at}: holds ${JSON.stringify(k)}, a path ${harness} does not declare for ${type} records`);
      }
      if (got !== derived(record)) problems.push(`${at}: holds ${got ?? 'nothing'}, the derived record ${derived(record) ?? 'nothing'}`);
    };
    for (const [sk, st] of exp) {
      for (const r of st.current.values()) {
        if (r.type === 'session') {
          const row = sessions.get(sk);
          if (!row) problems.push(`session ${r.session_id}: no current row`);
          else judge(`session ${r.session_id}: native`, r.harness, 'session', row.native, r.native);
        }
        if (r.type !== 'message') continue;
        const ps = r.parts?.length ? r.parts : [{ part_id: '' }];
        for (const p of ps) {
          const row = parts.get(`${sk}|${r.message_id}|${p.part_id}`);
          if (!row) {
            problems.push(`part ${r.message_id}/${p.part_id}: no current row`);
            continue;
          }
          judge(`part ${r.message_id}/${p.part_id}: message_native`, r.harness, 'message', row.message_native, r.native);
          if (p.part_id !== '') judge(`part ${r.message_id}/${p.part_id}: part_native`, r.harness, 'part', row.part_native, p.native);
        }
      }
    }
    if (!held) problems.push('no row holds a native value: the scenario proves nothing (are the adapters older than sessions-model v1.4?)');
    return verdict(problems.slice(0, 50), [`${held} native columns hold a value, each key a declared path and each equal to its record's`]);
  },
};

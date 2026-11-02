// §8 (v1.1): "Units resolve: every `units` triple of a current row (sessions.units,
// session_parts.message_units) names a unit of its own session in session_units, by source_key,
// generation and unit_key, unless that source was removed under the `removed` vanish policy
// (§4.1). The column holds the `units` of a derivation of the content the row holds: the current
// record's, or, because `units` is outside `content_sha` (§4.2), an earlier derivation's with the
// same `content_sha`."
//
// The broad scenario through the engine (sessions-model v1.4: every adapter emits `units`). After
// the passes, every current session and part row: each triple must name a unit of the session's
// archive (any chunk of it), and the column must equal, in order, the `units` of a record the kit
// expects for that key after some pass with the row's content_sha (message_content_sha for a part
// row). So the triples must resolve in the archive, as a reader's LEFT JOIN reads them (§6), and
// need not be the latest derivation's: `units` is outside `content_sha` (sessions-model §2.7), and
// a triple of an earlier generation still names the unit that produced the row's content. An
// engine that writes a new version when only `units` move holds the latest; one that writes only
// when `content_sha` moves may hold an earlier one; both pass. The scenario removes no
// source, so no triple is exempt. Over the run, at least one row holds a triple, so the check
// proves something.

import { verdict } from '../lib/result.mjs';
import { sessionKeyOf } from '../lib/keys.mjs';

// A units column as stored: ClickHouse's named tuples, PostgreSQL's jsonb objects, or arrays.
function triples(v) {
  const list = typeof v === 'string' ? JSON.parse(v || '[]') : v ?? [];
  return list.map((t) => (Array.isArray(t) ? [String(t[0]), Number(t[1]), String(t[2])] : [String(t.source_key), Number(t.generation), String(t.unit_key)]));
}
const asText = (units) => JSON.stringify((units ?? []).map(([s, g, u]) => [s, g, u]));
const recordKey = (sk, r) => (r.type === 'session' ? `${sk}|session` : `${sk}|message|${r.message_id}`);

export default {
  id: 'units-resolve',
  title: 'Units resolve',
  faults: ['engine:units-shifted', 'engine:units-dropped'],

  async engine(ctx) {
    const problems = [];
    let named = 0;
    const sc = ctx.scenario('broad');
    const states = ctx.expect(sc);
    const ns = await ctx.namespace();
    const engine = await ctx.engine(ns);
    for (const p of sc.passes) await engine.pass(p);
    const archive = new Set((await ns.present('session_units')).filter((u) => u.unit_key !== '').map((u) => `${sessionKeyOf(u)}|${u.source_key}|${Number(u.generation)}|${u.unit_key}`));
    const sessions = new Map((await ns.current('sessions')).map((r) => [sessionKeyOf(r), r]));
    const parts = new Map((await ns.current('session_parts')).map((r) => [`${sessionKeyOf(r)}|${r.message_id}|${r.part_id}`, r]));

    // The units each content of each record had, over every pass: key|content_sha -> units texts.
    const derived = new Map();
    for (const snap of states) {
      for (const [sk, st] of snap) {
        for (const r of st.current.values()) {
          if (r.type !== 'session' && r.type !== 'message') continue;
          const k = `${recordKey(sk, r)}|${r.content_sha}`;
          if (!derived.has(k)) derived.set(k, new Set());
          derived.get(k).add(asText(r.units));
        }
      }
    }

    const judge = (at, sk, rk, sha, column) => {
      const got = triples(column);
      for (const [s, g, u] of got) {
        named++;
        if (!archive.has(`${sk}|${s}|${g}|${u}`)) problems.push(`${at}: [${s}, ${g}, ${u}] names no unit of the session's archive`);
      }
      const want = derived.get(`${rk}|${sha}`);
      if (!want) problems.push(`${at}: its content_sha is no derivation's of that record`);
      else if (!want.has(JSON.stringify(got))) problems.push(`${at}: holds ${got.length} triples, which no derivation of its content had${[...want].some((w) => JSON.parse(w).length === got.length) ? ' (another order or other values)' : ''}`);
    };
    for (const [sk, st] of states.at(-1)) {
      for (const r of st.current.values()) {
        if (r.type === 'session') {
          const row = sessions.get(sk);
          if (!row) problems.push(`session ${r.session_id}: no current row`);
          else judge(`session ${r.session_id}: units`, sk, recordKey(sk, r), row.content_sha, row.units);
        }
        if (r.type !== 'message') continue;
        for (const p of r.parts?.length ? r.parts : [{ part_id: '' }]) {
          const row = parts.get(`${sk}|${r.message_id}|${p.part_id}`);
          if (!row) problems.push(`part ${r.message_id}/${p.part_id}: no current row`);
          else judge(`part ${r.message_id}/${p.part_id}: message_units`, sk, recordKey(sk, r), row.message_content_sha, row.message_units);
        }
      }
    }
    if (!named) problems.push('no row holds a units triple: the scenario proves nothing (are the adapters older than sessions-model v1.4?)');
    return verdict(problems.slice(0, 50), [`${named} triples, each naming a unit of its session's archive, each column the units of a derivation of its content`]);
  },
};

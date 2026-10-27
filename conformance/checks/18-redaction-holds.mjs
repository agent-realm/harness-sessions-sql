// §8: "Redaction holds: on the sentinel-secret fixtures, no value the adapter redacted on a
// declared redaction path (sessions-model §4) is in any table, a column a deployment adds
// included. No row holds, in this specification's columns, a planted value that the unit or
// record it was written from did not hold. A column a deployment adds (§3, derived columns) holds
// one only where a record of the row's session holds it, never another session's, and in the
// current state (§6) only where a current record holds it, never a removed or forgotten one. Free
// text an adapter keeps on purpose (sessions-model §4 rule 6) is the adapter's contract, not
// storage's."
//
// The package's sentinel fixtures (goose/conformance-goose-sentinel, zed/sentinel,
// opencode/sentinel) plant fake secrets on declared redaction paths, and, on purpose, the same or
// another fake value in free text, which no path covers and which an adapter keeps. A second pass
// deletes OpenCode's first user message, whose text holds a planted value (envelopes.mjs). After
// the last pass, in every row of every table:
// - this specification's columns (the table's columns in schema/<profile>.sql, MATERIALIZED ones
//   included) hold a planted value only where the unit or record the row was written from holds
//   it: an engine never puts back what the adapter redacted, and never copies a value into a row
//   of its own (a manifest, a cursor, an edge);
// - every other column is one the deployment adds (§3, derived columns). It holds a planted value
//   only where a record of the row's session holds it, never only another session's record, and
//   in the current state (an entity row, not removed) only where a current record of the session
//   holds it, never only a removed one. The session's records are the contracts' expectation
//   after the last pass (lib/oracle.mjs): current, and removed (left `live`, or derived from units
//   the fold forgot). A removed version is a copy of its last row (principle 3; Removed equals not
//   live checks it column by column) and the archive keeps every unit (principle 1), so in those
//   rows, as in the cursor, a removed record of the session counts too (SPEC-QUESTIONS.md, 30);
// and over the run:
// - at least one planted value is held by no emitted unit or record (redacted on its path), and
//   the archive keeps the redacted units with `redacted` set;
// - at least one planted value is held by a removed record of a session and by no current record
//   of it, so the scenario exercises a removal.
// A unit is read whole and as its text: its chunks joined in chunk order, and a `b64` body decoded
// (a planted value in base64 is still the planted value).

import { sessionKeyOf, rkOfRow, ALL_TABLES, ENTITY_TABLES } from '../lib/keys.mjs';
import { emittedUnits } from '../lib/oracle.mjs';
import { ddlColumns } from '../lib/spec.mjs';
import { verdict } from '../lib/result.mjs';

export default {
  id: 'redaction-holds',
  title: 'Redaction holds',
  faults: ['engine:unredact', 'engine:unredact-b64', 'engine:derived-stale', 'engine:derived-other-session'],

  async engine(ctx) {
    const problems = [];
    const sc = ctx.scenario('sentinels');
    const values = sc.sentinels;
    const ns = await ctx.namespace();
    const engine = await ctx.engine(ns, { faultData: { sentinels: values } });
    for (const p of sc.passes) await engine.pass(p);
    const { units } = emittedUnits(sc.passes);
    const exp = ctx.expect(sc).at(-1);
    // Each record the row of a table was written from, and each session's records as text: its
    // current ones, and its current and removed ones.
    const derived = new Map();
    const held = new Map();
    for (const [sk, st] of exp) {
      const current = [...st.current.values()].map((r) => JSON.stringify(r));
      const removed = [...st.removed.values()].map((r) => JSON.stringify(r));
      held.set(sk, { current: current.join('\n'), all: [...current, ...removed].join('\n') });
      for (const [rk, r] of [...st.current, ...st.removed]) derived.set(`${sk}|${rk}`, JSON.stringify(r));
    }
    const emittedText = [...[...units.values()].map((u) => textOf(u.enc, u.body)), ...derived.values()].join('\n');
    const redactedOnly = values.filter((v) => !emittedText.includes(v));
    const removedOnly = values.filter((v) => [...held.values()].some((h) => h.all.includes(v) && !h.current.includes(v)));
    let hits = 0;
    let addedHits = 0;
    const added = new Set();
    for (const table of ALL_TABLES) {
      const spec = new Set(ddlColumns(ns.profile, table, { materialized: true }));
      for (const row of table === 'session_units' ? wholeUnits(await ns.present(table)) : await ns.present(table)) {
        const own = Object.keys(row).filter((c) => !spec.has(c));
        for (const c of own) added.add(`${table}.${c}`);
        const specRow = Object.fromEntries(Object.entries(row).filter(([c]) => spec.has(c)));
        const text = table === 'session_units' ? `${JSON.stringify({ ...specRow, raw: undefined })}\n${textOf(row.enc, row.raw)}` : JSON.stringify(specRow);
        const sk = sessionKeyOf(row);
        const current = ENTITY_TABLES.includes(table) && Number(row.removed ?? 0) === 0;
        for (const v of values) {
          if (text.includes(v)) {
            hits++;
            let source = null;
            if (table === 'session_units' && row.unit_key !== '') {
              const u = units.get(`${sk}\u0000${row.source_key}\u0000${row.unit_key}\u0000${row.sha256}`);
              source = u ? textOf(u.enc, u.body) : null;
            } else if (table !== 'session_units' && table !== 'session_sources') {
              const rk = rkOfRow(table, row);
              source = rk === null ? null : derived.get(`${sk}|${rk}`) ?? null;
            }
            if (source === null) problems.push(`${table}: a row holds a planted value (${v.length} chars) and comes from no emitted unit or record`);
            else if (!source.includes(v)) problems.push(`${table}: a row holds a planted value (${v.length} chars) that the unit or record it was written from does not hold`);
          }
          // A column the deployment adds: the session's records, current ones for a current row.
          for (const c of own) {
            if (!JSON.stringify(row[c] ?? null).includes(v)) continue;
            const h = held.get(sk);
            if (current ? h?.current.includes(v) : h?.all.includes(v)) {
              addedHits++;
              continue;
            }
            problems.push(`${table}.${c}, a column the deployment adds: ${current ? 'a current row' : 'a row'} holds a planted value (${v.length} chars) that no ${current ? 'current ' : ''}record of its session holds (${whereHeld(v, sk, held)})`);
          }
        }
      }
    }
    if (!redactedOnly.length) problems.push('every planted value is in an emitted unit or record: the fixtures exercise no redaction');
    if (!removedOnly.length) problems.push('no planted value is held by a removed record of a session and by no current one: the scenario exercises no removal');
    const redactedUnits = (await ns.present('session_units')).filter((r) => r.redacted === true || r.redacted === 1);
    if (!redactedUnits.length) problems.push('no unit in the archive has redacted set');
    return verdict(problems, [
      `${sc.passes.length} passes, ${values.length} planted values, ${redactedOnly.length} redacted on declared paths and found in no table; ${hits} free-text occurrence(s) in this specification's columns traced to the unit or record that holds them; ${redactedUnits.length} redacted units archived`,
      `${removedOnly.length} planted value(s) held by a removed record of a session and by no current one`,
      added.size ? `columns the deployment adds (§3): ${[...added].sort().join(', ')}; ${addedHits} planted value(s) in them traced to a record of the row's session` : 'no column the deployment adds',
    ]);
  },
};

// Where a planted value an added column holds is held instead, for the report.
function whereHeld(v, sk, held) {
  if (held.get(sk)?.all.includes(v)) return 'only a removed record of the session holds it';
  if ([...held].some(([k, h]) => k !== sk && h.all.includes(v))) return "another session's record holds it";
  return 'no record holds it';
}

// A unit's text: its body, and for `b64` the decoded bytes as well.
function textOf(enc, raw) {
  if (enc !== 'b64') return String(raw);
  const bytes = Buffer.from(String(raw), 'base64');
  return `${raw}\n${bytes.toString('utf8')}\n${bytes.toString('latin1')}`;
}

// session_units rows with each unit's chunks joined into one row, in chunk order.
function wholeUnits(rows) {
  const groups = new Map();
  for (const r of rows) {
    const k = [sessionKeyOf(r), r.source_key, r.generation, r.unit_key, r.sha256].join('\u0000');
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  return [...groups.values()].map((rs) => {
    const sorted = [...rs].sort((a, b) => Number(a.chunk) - Number(b.chunk));
    return { ...sorted[0], raw: sorted.map((r) => r.raw).join('') };
  });
}

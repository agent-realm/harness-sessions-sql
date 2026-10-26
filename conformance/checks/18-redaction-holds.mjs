// §8: "Redaction holds: the sentinel-secret fixtures leave no sentinel value in any table."
//
// The package's sentinel fixtures (goose/conformance-goose-sentinel, zed/sentinel,
// opencode/sentinel) plant fake secrets on declared redaction paths, and, on purpose, the same or
// another fake value in free text, which no path covers and which an adapter keeps
// (sessions-model §4 rule 6). Read literally, no table could pass; the check holds the engine to
// what the item is for (SPEC-QUESTIONS.md):
// - no row of any table holds a planted value unless the unit or record it was written from holds
//   it too: an engine never puts back what the adapter redacted, and never copies a value into a
//   row of its own (a manifest, a cursor, an edge);
// - at least one planted value is held by no emitted unit or record (redacted on its path), and
//   the archive keeps the redacted units with `redacted` set.

import { sessionKeyOf, rkOfRow, ALL_TABLES } from '../lib/keys.mjs';
import { emittedUnits } from '../lib/oracle.mjs';
import { verdict } from '../lib/result.mjs';

export default {
  id: 'redaction-holds',
  title: 'Redaction holds',
  kind: 'engine',
  faults: ['engine:unredact'],

  async run(ctx) {
    const problems = [];
    const sc = ctx.scenario('sentinels');
    const values = sc.sentinels;
    const ns = await ctx.namespace();
    const engine = await ctx.engine(ns, { faultData: { sentinels: values } });
    for (const p of sc.passes) await engine.pass(p);
    const { units } = emittedUnits(sc.passes);
    const exp = ctx.expect(sc).at(-1);
    const derived = new Map();
    for (const [sk, st] of exp) for (const [rk, r] of [...st.current, ...st.removed]) derived.set(`${sk}|${rk}`, JSON.stringify(r));
    const emittedText = [...[...units.values()].map((u) => u.body), ...derived.values()].join('\n');
    const redactedOnly = values.filter((v) => !emittedText.includes(v));
    let hits = 0;
    for (const table of ALL_TABLES) {
      for (const row of await ns.present(table)) {
        const text = JSON.stringify(row);
        for (const v of values) {
          if (!text.includes(v)) continue;
          hits++;
          let source = null;
          if (table === 'session_units' && row.unit_key !== '') source = units.get(`${sessionKeyOf(row)}\u0000${row.source_key}\u0000${row.unit_key}\u0000${row.sha256}`)?.body ?? null;
          else if (table !== 'session_units' && table !== 'session_sources') {
            const rk = rkOfRow(table, row);
            source = rk === null ? null : derived.get(`${sessionKeyOf(row)}|${rk}`) ?? null;
          }
          if (source === null) problems.push(`${table}: a row holds a planted value (${v.length} chars) and comes from no emitted unit or record`);
          else if (!source.includes(v)) problems.push(`${table}: a row holds a planted value (${v.length} chars) that the unit or record it was written from does not hold`);
        }
      }
    }
    if (!redactedOnly.length) problems.push('every planted value is in an emitted unit or record: the fixtures exercise no redaction');
    const redactedUnits = (await ns.present('session_units')).filter((r) => r.redacted === true || r.redacted === 1);
    if (!redactedUnits.length) problems.push('no unit in the archive has redacted set');
    return verdict(problems, [`${values.length} planted values, ${redactedOnly.length} redacted on declared paths and found in no table; ${hits} free-text occurrence(s) traced to the unit or record that holds them; ${redactedUnits.length} redacted units archived`]);
  },
};

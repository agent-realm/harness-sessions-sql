// §8: "Units only: session_units holds no partial line, and each of its unit rows is a unit an
// adapter's read emitted, unless its adapter names an exemption of §4.8. Read manifests (§4.1) are
// normal rows, outside this check. Each entity record is one an adapter derived, unless its
// adapter names an exemption of §4.8. Engine-owned edges (§4.5, owner = 'engine') are normal rows,
// outside this check."
//
// The partial scenario: pass 1 reads a file whose last line is cut in half (`read` holds it back),
// pass 2 reads it whole; then the broad scenario.
// - Every unit in session_units equals a unit the reads emitted (session, source, unit_key,
//   sha256, enc and raw bytes), so a fragment, which no read emitted, cannot be there. A unit
//   stored in several chunks (§4.1 `chunk`) is put back together first: its chunks numbered 0, 1,
//   … with one enc, their raw joined in chunk order (SPEC-QUESTIONS.md).
// - Every row with unit_key '' is a read manifest of §4.1's shape that records the read it stands
//   for (manifests are normal rows, so they are held to their shape here; lib/archive.mjs).
// - Every adapter-owned entity record is one the adapter derived, and each of its rows says so by
//   its shas (§4): content_sha is the record's (a part row: the sha of the part object as the
//   adapter emitted it, `exit_code: null` included; a message's header row: the message's), and
//   message_content_sha is its message's. A current record's current rows are compared with the
//   record as derived; a removed record's latest rows with its last derived version.

import { sessionKeyOf } from '../lib/keys.mjs';
import { emittedUnits } from '../lib/oracle.mjs';
import { records } from '../lib/state.mjs';
import { jcsSha } from '../lib/jcs.mjs';
import { EXEMPT, manifestProblems, readProblems } from '../lib/archive.mjs';
import { verdict } from '../lib/result.mjs';

const SEP = '\u0000';
const show = (k) => k.replace(/\u0000/g, '/').slice(0, 160);

export default {
  id: 'units-only',
  title: 'Units only',
  faults: ['engine:archive-held-back', 'engine:private-manifest', 'engine:part-sha-no-nulls', 'engine:chunk-drop'],

  async engine(ctx) {
    const problems = [];
    const notes = [];
    for (const name of ['partial', 'broad']) {
      const sc = ctx.scenario(name);
      const ns = await ctx.namespace();
      const engine = await ctx.engine(ns);
      for (const p of sc.passes) await engine.pass(p);
      const { units, heldBack } = emittedUnits(sc.passes);
      const archive = await ns.present('session_units');
      problems.push(...manifestProblems(archive).map((d) => `${name}: ${d}`), ...readProblems(sc.passes, archive).map((d) => `${name}: ${d}`));

      // The units, each put back together from its chunks.
      const stored = new Map();
      let m = 0;
      for (const row of archive) {
        if (EXEMPT.has(row.adapter)) continue;
        if (row.unit_key === '') {
          m++;
          continue;
        }
        const k = [sessionKeyOf(row), row.source_key, row.generation, row.unit_key, row.sha256].join(SEP);
        if (!stored.has(k)) stored.set(k, []);
        stored.get(k).push(row);
      }
      let chunked = 0;
      for (const rows of stored.values()) {
        const [row] = rows;
        const at = `${name}: ${row.source_key}@${row.unit_key} (sha ${row.sha256.slice(0, 12)}…)`;
        const chunks = [...rows].sort((a, b) => Number(a.chunk) - Number(b.chunk));
        if (chunks.length > 1) chunked++;
        if (chunks.some((r, i) => Number(r.chunk) !== i)) problems.push(`${at}: its chunks are numbered ${chunks.map((r) => r.chunk).join(', ')}, not 0 to ${chunks.length - 1}`);
        if (chunks.some((r) => r.enc !== row.enc)) problems.push(`${at}: its chunks differ in enc`);
        const raw = chunks.map((r) => r.raw).join('');
        const u = units.get([sessionKeyOf(row), row.source_key, row.unit_key, row.sha256].join(SEP));
        if (!u) problems.push(`${at} is not a unit any read emitted`);
        else if (u.enc !== row.enc || u.body !== raw) problems.push(`${at} differs from the unit read emitted${chunks.length > 1 ? ` (its ${chunks.length} chunks joined)` : ''}`);
      }

      // The records, by their shas.
      const exp = ctx.expect(sc).at(-1);
      const current = new Map();
      const removed = new Map();
      for (const [sk, st] of exp) {
        for (const [rk, r] of st.current) current.set(`${sk}|${rk}`, r);
        for (const [rk, r] of st.removed) removed.set(`${sk}|${rk}`, r);
      }
      let e = 0;
      let rowsChecked = 0;
      for (const [k, rec] of await records(ns)) {
        if (rec.rows.every(({ row }) => EXEMPT.has(row.adapter))) continue;
        e++;
        const r = current.get(k) ?? removed.get(k);
        if (!r) {
          problems.push(`${name}: the record ${show(k)} is not one the adapter derived`);
          continue;
        }
        const top = Math.max(...rec.rows.map(({ row }) => Number(row.rev)));
        const rows = current.has(k) ? rec.rows.filter(({ row }) => !Number(row.removed)) : rec.rows.filter(({ row }) => Number(row.rev) === top);
        for (const { table, row } of rows) {
          rowsChecked++;
          for (const d of shaProblems(table, row, r)) problems.push(`${name}: ${show(k)}: ${d}`);
        }
      }
      notes.push(`${name}: ${stored.size} units (${chunked} in several chunks) and ${m} manifests checked, ${heldBack.length} held-back line(s) delivered, ${e} records, ${rowsChecked} rows' shas`);
      if (name === 'partial' && !heldBack.length) problems.push('partial: no read held a line back: the scenario proves nothing');
    }
    return verdict(problems, notes);
  },
};

// What a row's shas say against the record it was written from (spec §4).
function shaProblems(table, row, r) {
  if (table !== 'session_parts') return row.content_sha === r.content_sha ? [] : [`${table}: content_sha is not the record's`];
  const out = [];
  if (row.message_content_sha !== r.content_sha) out.push(`part ${row.part_id || "''"}: message_content_sha is not its message's`);
  const parts = r.parts ?? [];
  if (row.part_id === '' && row.kind === 'none') {
    if (parts.length) out.push('a header row (kind none) for a message that has parts');
    else if (row.content_sha !== r.content_sha) out.push("the header row's content_sha is not its message's");
    return out;
  }
  const part = parts.find((p) => (p.part_id ?? '') === row.part_id);
  if (!part) out.push(`part ${row.part_id || "''"}: a current row for a part the message does not have`);
  else if (row.content_sha !== jcsSha(part)) out.push(`part ${row.part_id || "''"}: content_sha is not the sha of the part as emitted`);
  return out;
}

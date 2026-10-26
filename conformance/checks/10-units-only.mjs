// §8: "Units only: session_units holds no partial line, and each of its unit rows is a unit an
// adapter's read emitted, unless its adapter names an exemption of §4.8. Read manifests (§4.1) are
// normal rows, outside this check. Each entity record is one an adapter derived, unless its
// adapter names an exemption of §4.8. Engine-owned edges (§4.5, owner = 'engine') are normal rows,
// outside this check."
//
// The partial scenario: pass 1 reads a file whose last line is cut in half (`read` holds it back),
// pass 2 reads it whole; then the broad scenario. Every unit row must equal a unit the reads
// emitted (session, source, unit_key, sha256, enc and raw bytes), so a fragment, which no read
// emitted, cannot be there. Every row with unit_key '' must be a manifest. Every adapter-owned
// entity record must be one the adapter derived, with its content_sha.

import { sessionKeyOf } from '../lib/keys.mjs';
import { emittedUnits } from '../lib/oracle.mjs';
import { records } from '../lib/state.mjs';
import { verdict } from '../lib/result.mjs';

const EXEMPT = new Set(['memhouse-bridge', 'memhouse-log', 'legacy']);

export default {
  id: 'units-only',
  title: 'Units only',
  kind: 'engine',
  faults: ['engine:archive-held-back'],

  async run(ctx) {
    const problems = [];
    const notes = [];
    for (const name of ['partial', 'broad']) {
      const sc = ctx.scenario(name);
      const ns = await ctx.namespace();
      const engine = await ctx.engine(ns);
      for (const p of sc.passes) await engine.pass(p);
      const { units, heldBack } = emittedUnits(sc.passes);
      let n = 0;
      let m = 0;
      for (const row of await ns.present('session_units')) {
        if (EXEMPT.has(row.adapter)) continue;
        if (row.unit_key === '') {
          m++;
          if (row.enc !== 'manifest') problems.push(`${name}: a row with unit_key '' that is not a manifest (enc ${row.enc})`);
          continue;
        }
        n++;
        const u = units.get(`${sessionKeyOf(row)}\u0000${row.source_key}\u0000${row.unit_key}\u0000${row.sha256}`);
        if (!u) problems.push(`${name}: ${row.source_key}@${row.unit_key} (sha ${row.sha256.slice(0, 12)}…) is not a unit any read emitted`);
        else if (u.enc !== row.enc || u.body !== row.raw) problems.push(`${name}: ${row.source_key}@${row.unit_key} differs from the unit read emitted`);
      }
      const exp = ctx.expect(sc).at(-1);
      const derived = new Map();
      for (const [sk, st] of exp) for (const [rk, r] of [...st.current, ...st.removed]) derived.set(`${sk}|${rk}`, r);
      let e = 0;
      for (const [k, rec] of await records(ns)) {
        if (rec.rows.every(({ row }) => EXEMPT.has(row.adapter))) continue;
        e++;
        const r = derived.get(k);
        if (!r) problems.push(`${name}: the record ${k.replace(/\u0000/g, '/').slice(0, 160)} is not one the adapter derived`);
      }
      notes.push(`${name}: ${n} unit rows and ${m} manifests checked, ${heldBack.length} held-back line(s) delivered, ${e} records`);
      if (name === 'partial' && !heldBack.length) problems.push('partial: no read held a line back: the scenario proves nothing');
    }
    return verdict(problems, notes);
  },
};

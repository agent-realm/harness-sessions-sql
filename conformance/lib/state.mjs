// Reading a namespace back as sets the checks compare. Identities come from spec §3.

import { identities } from './spec.mjs';
import { norm } from './db.mjs';
import { rkOfRow, sessionKeyOf, ENTITY_TABLES, ALL_TABLES } from './keys.mjs';

const ID = identities().tables;
const SEP = '\u0000';

export const idOf = (table, row) => ID[table].identity.map((c) => norm(row[c]) ?? '').join(SEP);
export const removedOf = (row) => Number(row.removed ?? 0);

// One string per present row: identity, its shas and its removed flag (entity tables), the
// identity alone (session_units, session_sources). `edgeHistory: false` leaves removed engine
// edges out (a replay folds each session alone, so an ended edge's removed version is history it
// does not rebuild). `rev: true` adds each row's rev, so any new version of a row shows.
export async function snapshot(ns, { tables = ALL_TABLES, edgeHistory = true, removed = true, rev = false } = {}) {
  const out = new Map();
  for (const table of tables) {
    const set = new Set();
    for (const row of await ns.present(table)) {
      if (!ENTITY_TABLES.includes(table)) {
        set.add(idOf(table, row));
        continue;
      }
      if (!removed && removedOf(row)) continue;
      if (!edgeHistory && table === 'session_links' && row.owner === 'engine' && removedOf(row)) continue;
      set.add([idOf(table, row), row.content_sha, row.message_content_sha ?? '', removedOf(row), ...(rev ? [String(row.rev)] : [])].join('\u0001'));
    }
    out.set(table, set);
  }
  return out;
}

// The differences between two snapshots, as readable lines (at most `limit` per table).
export function diffSnapshots(a, b, { left = 'first', right = 'second', limit = 3 } = {}) {
  const out = [];
  for (const [table, sa] of a) {
    const sb = b.get(table) ?? new Set();
    const onlyA = [...sa].filter((x) => !sb.has(x));
    const onlyB = [...sb].filter((x) => !sa.has(x));
    if (onlyA.length || onlyB.length) {
      out.push(`${table}: ${onlyA.length} only in ${left}, ${onlyB.length} only in ${right}`);
      for (const x of onlyA.slice(0, limit)) out.push(`  ${left}: ${readable(x)}`);
      for (const x of onlyB.slice(0, limit)) out.push(`  ${right}: ${readable(x)}`);
    }
  }
  return out;
}

export const readable = (s) => s.replace(/\u0000/g, '/').replace(/\u0001/g, ' | ').slice(0, 300);

// Every adapter-owned record the namespace holds: `${sk}|${rk}` -> { current, removed, rows }.
// A record is current when any of its rows is current, removed when all present rows are removed.
export async function records(ns) {
  const out = new Map();
  for (const table of ENTITY_TABLES) {
    for (const row of await ns.present(table)) {
      const rk = rkOfRow(table, row);
      if (rk === null) continue;
      const k = `${sessionKeyOf(row)}|${rk}`;
      if (!out.has(k)) out.set(k, { rows: [], current: false, removed: true });
      const r = out.get(k);
      r.rows.push({ table, row });
      if (!removedOf(row)) {
        r.current = true;
        r.removed = false;
      }
    }
  }
  return out;
}

// Rows per table, as plain counts of present rows (logical rows).
export async function counts(ns, tables = ALL_TABLES) {
  const out = {};
  for (const t of tables) out[t] = (await ns.present(t)).length;
  return out;
}

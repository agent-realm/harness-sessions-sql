// §8: "Every table and key of §3 exists in the database profile's DDL, under the deployment's
// physical table names (§3), with each table's identity columns as its key set (session_sources
// is informative and may be absent). An entity row is physically deleted only for a true
// duplicate, for a key an upgraded adapter no longer produces (§2, principle 3), or as a
// tombstoning consumer's tombstone."
//
// Database part: the DDL (the engine's own, through createTables, or schema/ as a self-check),
// as loaded under the deployment prefix, read back from the catalogue.
// Engine part: after the rewind scenario, every record that was ever current is still present
// (current, or a removed version); for a tombstoning engine, a record that left live may be gone.

import { identities } from '../lib/spec.mjs';
import { records } from '../lib/state.mjs';
import { verdict } from '../lib/result.mjs';

export default {
  id: 'tables-and-keys',
  title: 'Tables and keys',
  faults: ['ddl:drop-key-column', 'engine:delete-removed'],

  async database(ctx) {
    const problems = [];
    const notes = [];
    const ns = await ctx.namespace();
    const { tables } = identities();
    const keys = await keySets(ns);
    for (const [name, { identity, informative }] of Object.entries(tables)) {
      const physical = `${ns.prefix}${name}`;
      const got = keys.get(physical);
      if (!got) {
        if (informative) notes.push(`${physical} is absent (informative)`);
        else problems.push(`${physical}: no such table`);
        continue;
      }
      const want = new Set(identity);
      const missing = identity.filter((c) => !got.has(c));
      const extra = [...got].filter((c) => !want.has(c));
      if (missing.length || extra.length) problems.push(`${physical}: key ${[...got].join(', ')}; ${missing.length ? `missing ${missing.join(', ')}` : ''}${extra.length ? ` extra ${extra.join(', ')}` : ''}`);
    }
    notes.push(`${Object.keys(tables).length} tables of §3 checked under the prefix ${ns.prefix || '(none)'}`);
    return verdict(problems, notes);
  },

  async engine(ctx) {
    const problems = [];
    const sc = ctx.scenario('rewind');
    const ens = await ctx.namespace();
    const engine = await ctx.engine(ens);
    const exp = ctx.expect(sc);
    const ever = new Set();
    for (let i = 0; i < sc.passes.length; i++) {
      await engine.pass(sc.passes[i]);
      for (const [sk, st] of exp[i]) for (const rk of st.current.keys()) ever.add(`${sk}|${rk}`);
    }
    const held = await records(ens);
    const last = exp.at(-1);
    let gone = 0;
    for (const k of ever) {
      if (held.has(k)) continue;
      const [sk, rk] = [k.slice(0, k.indexOf('|')), k.slice(k.indexOf('|') + 1)];
      const leftLive = last.get(sk)?.removed.has(rk);
      if ((engine.removal ?? 'removed') === 'tombstone' && leftLive) continue;
      gone++;
      if (gone <= 5) problems.push(`physically deleted: ${k.replace(/\u0000/g, '/')}${leftLive ? ' (left live; the engine keeps removed versions, not tombstones)' : ' (still live)'}`);
    }
    if (gone > 5) problems.push(`… ${gone} records physically deleted in all`);
    return verdict(problems, [`${ever.size} records ever current over ${sc.passes.length} passes, each still present`]);
  },
};

// The key columns of every table of the namespace, from the catalogue.
async function keySets(ns) {
  const out = new Map();
  if (ns.profile === 'clickhouse') {
    const rows = await ns.query('SELECT name, sorting_key FROM system.tables WHERE database = {db:String}', { settings: { param_db: ns.name } });
    for (const r of rows) out.set(r.name, new Set(r.sorting_key.split(',').map((c) => c.trim()).filter(Boolean)));
    return out;
  }
  const rows = await ns.query(`
    SELECT c.relname AS name, a.attname AS col
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)
    WHERE i.indisprimary AND n.nspname = $1`, [ns.name]);
  for (const r of rows) {
    if (!out.has(r.name)) out.set(r.name, new Set());
    out.get(r.name).add(r.col);
  }
  const tables = await ns.query('SELECT table_name AS name FROM information_schema.tables WHERE table_schema = $1', [ns.name]);
  for (const t of tables) if (!out.has(t.name)) out.set(t.name, new Set());
  return out;
}

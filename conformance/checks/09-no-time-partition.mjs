// §8: "No time partition: no entity table is partitioned by time, ts is Nullable, and a null ts is
// never filled with a consumer's first-seen time (§3)."
//
// Database part: the catalogue. No entity table has a partition key that reads a time column or
// a time function (ClickHouse partition_key; PostgreSQL pg_partitioned_table), and every `ts`
// column is Nullable.
// Engine part: Zed keeps no message time (ts_source `none`): every record the adapter derived with
// a null ts is stored with a null ts.

import { ENTITY_TABLES } from '../lib/keys.mjs';
import { verdict } from '../lib/result.mjs';

const TIME = /\b(ts|ingested_at|created_at|updated_at|captured_at|committed_at)\b|toYYYYMM|toDate|toStartOf|toMonday|toYear|date_trunc/i;

export default {
  id: 'no-time-partition',
  title: 'No time partition',
  kind: 'database, engine',
  faults: ['ddl:partition-by-time', 'ddl:ts-not-null', 'engine:fill-ts'],

  async run(ctx) {
    const problems = [];
    const ns = await ctx.namespace();
    const physical = new Map(ENTITY_TABLES.map((t) => [`${ns.prefix}${t}`, t]));
    if (ns.profile === 'clickhouse') {
      const tables = await ns.query('SELECT name, partition_key FROM system.tables WHERE database = {db:String}', { settings: { param_db: ns.name } });
      for (const t of tables) if (physical.has(t.name) && t.partition_key && TIME.test(t.partition_key)) problems.push(`${t.name}: partitioned by ${t.partition_key}`);
      const cols = await ns.query("SELECT table, type FROM system.columns WHERE database = {db:String} AND name = 'ts'", { settings: { param_db: ns.name } });
      for (const c of cols) if (!c.type.startsWith('Nullable(')) problems.push(`${c.table}.ts is ${c.type}, not Nullable`);
      if (!cols.length) problems.push('no ts column found');
    } else {
      const parts = await ns.query(`
        SELECT c.relname AS name, pg_get_partkeydef(c.oid) AS key
        FROM pg_partitioned_table p JOIN pg_class c ON c.oid = p.partrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1`, [ns.name]);
      for (const t of parts) if (physical.has(t.name) && TIME.test(t.key)) problems.push(`${t.name}: partitioned by ${t.key}`);
      const cols = await ns.query("SELECT table_name, is_nullable FROM information_schema.columns WHERE table_schema = $1 AND column_name = 'ts'", [ns.name]);
      for (const c of cols) if (c.is_nullable !== 'YES') problems.push(`${c.table_name}.ts is NOT NULL`);
      if (!cols.length) problems.push('no ts column found');
    }

    let n = 0;
    await ctx.enginePart(problems, async () => {
      const sc = ctx.scenario('nullTs');
      const exp = ctx.expect(sc).at(-1);
      const ens = await ctx.namespace();
      const engine = await ctx.engine(ens);
      for (const p of sc.passes) await engine.pass(p);
      const parts = await ens.current('session_parts');
      const byMsg = new Map(parts.map((r) => [`${r.session_id}\u0000${r.message_id}`, r]));
      for (const st of exp.values()) {
        for (const r of st.current.values()) {
          if (r.type !== 'message' || r.ts !== null) continue;
          n++;
          const row = byMsg.get(`${r.session_id}\u0000${r.message_id}`);
          if (!row) problems.push(`${r.message_id}: no current row`);
          else if (row.ts !== null) problems.push(`${r.message_id}: ts is ${row.ts}, the adapter emitted null`);
        }
      }
      if (!n) problems.push('no message with a null ts in the scenario: the engine part proves nothing');
    });
    return verdict(problems, [`entity tables' partition keys and ts columns read from the catalogue; ${n} null-ts message(s) stored null`]);
  },
};

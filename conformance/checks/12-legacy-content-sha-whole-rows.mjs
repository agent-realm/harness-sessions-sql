// §8: "Legacy content_sha, whole rows: for each of §4.8's full-row vectors, the conversion of that
// row gives that line and that content_sha."
//
// The vectors are read from §4.8. The kit cannot run an implementation's conversion of a memhouse
// 0.18 database (it has no such input); what it proves is the half the database profile owns:
// each vector's fields, named by the specification's DDL order (schema/clickhouse.sql as
// committed) and loaded into the deployed table by name, format back through the implementation's
// SQL, in the deployed table's own column order, into the same line and the same sha. A deployed
// DDL whose order or types differ gives another line. On PostgreSQL the item does not apply (see
// the line format check).

import { fullRowVectors, LEGACY_LINE_EXCLUDES, ddlColumns } from '../lib/spec.mjs';
import { sha256 } from '../lib/jcs.mjs';
import { verdict, na } from '../lib/result.mjs';

// The engine's legacy sha SQL, or §4.8's when the engine has none.
export function legacyShaOf(engine, exprs) {
  if (typeof engine.legacySha === 'function') return engine.legacySha(exprs);
  const line = `trimRight(formatRow('TabSeparated', ${exprs.join(', ')}), '\\n')`;
  return { line, sql: `lower(hex(SHA256(${line})))`, settings: { format_tsv_null_representation: '\\N', bool_true_representation: 'true', bool_false_representation: 'false' } };
}

export default {
  id: 'legacy-content-sha-whole-rows',
  title: 'Legacy content_sha, whole rows',
  kind: 'database',
  faults: ['ddl:reorder-columns'],
  profiles: ['clickhouse'],

  async run(ctx) {
    if (ctx.profile !== 'clickhouse') return na('§4.8: a legacy row exists only in the ClickHouse database its conversion ran in, and its line is ClickHouse TabSeparated');
    const problems = [];
    const ns = await ctx.namespace();
    const engine = await ctx.engine(ns);
    const vectors = fullRowVectors();
    for (const v of vectors) {
      const label = v.label.replace(/`/g, '');
      if (sha256(Buffer.from(v.line, 'utf8')) !== v.sha256) problems.push(`${label}: its line does not hash to its sha outside SQL`);
      const exclude = new Set([...LEGACY_LINE_EXCLUDES.common, ...(LEGACY_LINE_EXCLUDES[v.table] ?? [])]);
      const named = ddlColumns('clickhouse', v.table).filter((c) => !exclude.has(c));
      const cols = (await ns.query(`SELECT name, default_kind FROM system.columns WHERE database = {db:String} AND table = {t:String} ORDER BY position`, { settings: { param_db: ns.name, param_t: `${ns.prefix}${v.table}` } }))
        .filter((c) => c.default_kind !== 'MATERIALIZED' && c.default_kind !== 'ALIAS' && !exclude.has(c.name)).map((c) => c.name);
      const fields = v.line.split('\t').length;
      if (fields !== named.length || fields !== cols.length) {
        problems.push(`${label}: the line has ${fields} fields; ${v.table} has ${named.length} line columns in the specification's DDL, ${cols.length} deployed`);
        continue;
      }
      try {
        await ns.client.insertFormat(ns.t(v.table), named, 'TabSeparated', `${v.line}\n`);
      } catch (e) {
        problems.push(`${label}: the line does not load into ${v.table}: ${e.message.slice(0, 200)}`);
        continue;
      }
      const q = legacyShaOf(engine, cols);
      const key = v.table === 'sessions' ? 'session_id' : 'message_id';
      const field = (c) => v.line.split('\t')[named.indexOf(c)];
      const rows = await ns.query(`SELECT ${q.line} AS line, ${q.sql} AS sha FROM ${ns.t(v.table)} WHERE ${key} = {id:String} AND host = {h:String} AND session_id = {s:String}`,
        { settings: { ...q.settings, param_id: field(key), param_h: field('host'), param_s: field('session_id') } });
      if (rows.length !== 1) {
        problems.push(`${label}: ${rows.length} rows read back`);
        continue;
      }
      if (rows[0].line !== v.line) problems.push(`${label}: the stored row formats as another line (${firstDiff(rows[0].line, v.line)})`);
      if (rows[0].sha !== v.sha256) problems.push(`${label}: sha ${rows[0].sha}, §4.8 says ${v.sha256}`);
    }
    return verdict(problems, [`${vectors.length} full-row vectors from §4.8, stored and formatted back in DDL order`]);
  },
};

function firstDiff(a, b) {
  const fa = a.split('\t');
  const fb = b.split('\t');
  for (let i = 0; i < Math.max(fa.length, fb.length); i++) if (fa[i] !== fb[i]) return `field ${i + 1}: ${JSON.stringify(fa[i])} vs ${JSON.stringify(fb[i])}`;
  return 'same fields';
}

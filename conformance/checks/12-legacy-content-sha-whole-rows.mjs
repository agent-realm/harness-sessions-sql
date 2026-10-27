// §8: "Legacy content_sha, whole rows: for each of §4.8's full-row vectors, the conversion of that
// row gives that line and that content_sha."
//
// The vectors are read from §4.8. The kit cannot run an implementation's conversion of a memhouse
// 0.18 database (it has no such input); what it proves is what the deployment owns: each vector's
// fields, named by the specification's DDL order (schema/clickhouse.sql as committed) and loaded
// into the deployed table by name, format back, in the deployed table's own column order, into the
// same line and the same sha. A deployed DDL whose order or types differ gives another line. A
// column the deployment adds is left out of the line, as §4.8 says ("and any column a deployment
// adds"): the line's columns are the specification DDL's, in the order the deployed table has them.
// On PostgreSQL the item does not apply (see the line format check).
//
// Two parts, so each is judged by what it tests:
// - database: the deployed DDL, formatted through §4.8's own expression. Without the engine's DDL
//   (no createTables) it tests schema/, and is a self-check, outside the engine's verdict.
// - engine: the same, through the engine's own legacy SQL (`legacySha`), which is always the
//   engine's, so it counts in the verdict whenever the engine supplies one. Without it the part is
//   skipped: the item proves the implementation's SQL, and is never passed on §4.8's expression.

import { fullRowVectors, LEGACY_LINE_EXCLUDES, ddlColumns, specLegacySha } from '../lib/spec.mjs';
import { sha256 } from '../lib/jcs.mjs';
import { verdict, na, skip } from '../lib/result.mjs';

export const NO_LEGACY_SQL = 'the engine supplies no legacy SQL (legacySha): the item proves the implementation\'s SQL, so it is not checked on §4.8\'s own expression';
const NOT_CLICKHOUSE = '§4.8: a legacy row exists only in the ClickHouse database its conversion ran in, and its line is ClickHouse TabSeparated';

export default {
  id: 'legacy-content-sha-whole-rows',
  title: 'Legacy content_sha, whole rows',
  faults: ['ddl:reorder-columns', 'engine:sql-tsv-no-trim'],
  profiles: ['clickhouse'],

  // The deployed DDL, through §4.8's own expression.
  async database(ctx) {
    if (ctx.profile !== 'clickhouse') return na(NOT_CLICKHOUSE);
    return wholeRows(await ctx.namespace(), specLegacySha(), "§4.8's own expression");
  },

  // The engine's legacy SQL, over the same deployed table.
  async engine(ctx) {
    if (ctx.profile !== 'clickhouse') return na(NOT_CLICKHOUSE);
    const ns = await ctx.namespace();
    const engine = await ctx.engine(ns);
    if (typeof engine.legacySha !== 'function') return skip(NO_LEGACY_SQL);
    return wholeRows(ns, (exprs) => engine.legacySha(exprs), "the engine's legacy SQL");
  },
};

// Each full-row vector loaded into the namespace's table and formatted back through `legacySha`.
async function wholeRows(ns, legacySha, through) {
  const problems = [];
  const vectors = fullRowVectors();
  const added = new Set();
  for (const v of vectors) {
    const label = v.label.replace(/`/g, '');
    if (sha256(Buffer.from(v.line, 'utf8')) !== v.sha256) problems.push(`${label}: its line does not hash to its sha outside SQL`);
    const exclude = new Set([...LEGACY_LINE_EXCLUDES.common, ...(LEGACY_LINE_EXCLUDES[v.table] ?? [])]);
    const named = ddlColumns('clickhouse', v.table).filter((c) => !exclude.has(c));
    const deployed = (await ns.query(`SELECT name, default_kind FROM system.columns WHERE database = {db:String} AND table = {t:String} ORDER BY position`, { settings: { param_db: ns.name, param_t: `${ns.prefix}${v.table}` } }))
      .filter((c) => c.default_kind !== 'MATERIALIZED' && c.default_kind !== 'ALIAS' && !exclude.has(c.name)).map((c) => c.name);
    // The specification's columns, in the deployed order; the deployment's own are left out.
    const cols = deployed.filter((c) => named.includes(c));
    for (const c of deployed.filter((x) => !named.includes(x))) added.add(`${v.table}.${c}`);
    const absent = named.filter((c) => !deployed.includes(c));
    const fields = v.line.split('\t').length;
    if (fields !== named.length || absent.length) {
      problems.push(`${label}: the line has ${fields} fields; ${v.table} has ${named.length} line columns in the specification's DDL${absent.length ? `, of which the deployed table lacks ${absent.join(', ')}` : ''}`);
      continue;
    }
    try {
      await ns.client.insertFormat(ns.t(v.table), named, 'TabSeparated', `${v.line}\n`);
    } catch (e) {
      problems.push(`${label}: the line does not load into ${v.table}: ${e.message.slice(0, 200)}`);
      continue;
    }
    const q = legacySha(cols);
    const key = v.table === 'sessions' ? 'session_id' : 'message_id';
    const field = (c) => v.line.split('\t')[named.indexOf(c)];
    const rows = await ns.query(`SELECT ${q.line} AS line, ${q.sql} AS sha FROM ${ns.t(v.table)} WHERE ${key} = {id:String} AND host = {h:String} AND session_id = {s:String}`,
      { settings: { ...q.settings, param_id: field(key), param_h: field('host'), param_s: field('session_id') } });
    if (rows.length !== 1) {
      problems.push(`${label}: ${rows.length} rows read back`);
      continue;
    }
    if (rows[0].line !== v.line) problems.push(`${label}: through ${through}, the stored row formats as another line (${firstDiff(rows[0].line, v.line)})`);
    if (rows[0].sha !== v.sha256) problems.push(`${label}: through ${through}, sha ${rows[0].sha}, §4.8 says ${v.sha256}`);
  }
  return verdict(problems, [`${vectors.length} full-row vectors from §4.8, stored and formatted back in DDL order through ${through}`, ...(added.size ? [`columns the deployment adds, left out of the line (§4.8): ${[...added].join(', ')}`] : [])]);
}

function firstDiff(a, b) {
  const fa = a.split('\t');
  const fb = b.split('\t');
  for (let i = 0; i < Math.max(fa.length, fb.length); i++) if (fa[i] !== fb[i]) return `field ${i + 1}: ${JSON.stringify(fa[i])} vs ${JSON.stringify(fb[i])}`;
  return 'same fields';
}

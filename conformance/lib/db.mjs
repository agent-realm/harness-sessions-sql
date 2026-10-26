// Targets, namespaces and reads.
//
// The kit takes its targets from the environment only:
//   SSQL_CH_URL, SSQL_CH_USER, SSQL_CH_PASSWORD   a ClickHouse HTTP endpoint
//   SSQL_PG_URL                                   a PostgreSQL connection URL
//   SSQL_PREFIX                                   the deployment prefix of every table (default conf_)
// A profile without a URL is skipped. Every check runs in a namespace of its own, created fresh
// and dropped after it: a ClickHouse database, or a PostgreSQL schema, named ssql_conf_<run>_<n>.
// The DDL is the profile's file in schema/, with every logical table name replaced by its
// physical name (spec §3: the deployment prefix).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClickHouse } from './ch.mjs';
import { Postgres } from './pg.mjs';
import { ALL_TABLES } from './keys.mjs';
import { jcs } from './jcs.mjs';
import { registerSecret, registerUrl } from './secrets.mjs';

const SCHEMA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'schema');
export const PROFILES = ['clickhouse', 'postgres'];

export function targets(env = process.env) {
  const prefix = env.SSQL_PREFIX ?? 'conf_';
  if (!/^[a-z0-9_]*$/.test(prefix)) throw new Error('SSQL_PREFIX: lowercase letters, digits and _ only');
  registerUrl(env.SSQL_CH_URL);
  registerUrl(env.SSQL_PG_URL);
  registerSecret(env.SSQL_CH_USER, { word: true });
  registerSecret(env.SSQL_CH_PASSWORD);
  return {
    prefix,
    clickhouse: env.SSQL_CH_URL ? clickhouseTarget(env.SSQL_CH_URL, env.SSQL_CH_USER ?? '', env.SSQL_CH_PASSWORD ?? '') : null,
    postgres: env.SSQL_PG_URL ? { url: env.SSQL_PG_URL } : null,
  };
}

// A ClickHouse target with any user info moved out of its URL (SSQL_CH_USER and SSQL_CH_PASSWORD
// win over it), so neither the kit nor an engine handed the target ever holds a URL with a
// credential in it.
function clickhouseTarget(url, user, password) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return { url, user, password };
  }
  const t = { url: '', user: user || decodeURIComponent(u.username), password: password || decodeURIComponent(u.password) };
  u.username = '';
  u.password = '';
  t.url = u.href.replace(/\/+$/, '');
  return t;
}

// A target as it may be printed: the URL without its user info, never a password.
export function describeTarget(profile, t) {
  if (!t) return `${profile}: skipped (no ${profile === 'clickhouse' ? 'SSQL_CH_URL' : 'SSQL_PG_URL'})`;
  try {
    const u = new URL(t.url);
    return `${profile}: ${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ''}${u.pathname === '/' ? '' : u.pathname}`;
  } catch {
    return `${profile}: (unparsable URL)`;
  }
}

// The profile's DDL as statements, comments stripped, with physical names.
export function ddlStatements(profile, { qualify, transforms = [] }) {
  let text = fs.readFileSync(path.join(SCHEMA_DIR, `${profile}.sql`), 'utf8');
  for (const t of transforms) text = t(text, profile);
  const body = text.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');
  return body.split(';').map((s) => s.trim()).filter(Boolean)
    .map((s) => s.replace(/CREATE TABLE ([a-z_]+)/, (_, name) => `CREATE TABLE ${qualify(name)}`));
}

let nsCounter = 0;
const RUN = Math.random().toString(36).slice(2, 8);
// Every namespace not yet dropped, so an interrupted run can drop them (run.mjs).
export const openNamespaces = new Set();

export class Namespace {
  constructor(profile, client, name, prefix) {
    this.profile = profile;
    this.client = client;
    this.name = name;
    this.prefix = prefix;
    this.tables = Object.fromEntries(ALL_TABLES.map((t) => [t, this.qualify(t)]));
    openNamespaces.add(this);
  }

  // `columns` IN `tuples` as a condition with bound values, compared as text: { where, params }
  // for present() and exec(). No value is ever spliced into the SQL.
  tupleIn(columns, tuples, { name = 'k' } = {}) {
    if (this.profile === 'clickhouse') {
      if (!tuples.length) return { where: '0', params: {} };
      const params = {};
      const rows = tuples.map((t, i) => `(${t.map((v, j) => {
        params[`${name}${i}_${j}`] = String(v ?? '');
        return `{${name}${i}_${j}:String}`;
      }).join(', ')})`);
      return { where: `(${columns.map((c) => `toString(${c})`).join(', ')}) IN (${rows.join(', ')})`, params };
    }
    if (!tuples.length) return { where: 'false', params: [] };
    const params = [];
    const rows = tuples.map((t) => `(${t.map((v) => {
      params.push(String(v ?? ''));
      return `$${params.length}`;
    }).join(', ')})`);
    return { where: `(${columns.map((c) => `${c}::text`).join(', ')}) IN (${rows.join(', ')})`, params };
  }

  // A statement with bound values in the profile's form (see tupleIn).
  async run(sql, params) {
    if (this.profile === 'clickhouse') return this.client.query(sql, { settings: chParams(params) });
    return this.client.query(sql, params ?? []);
  }

  qualify(logical) {
    return `${this.name}.${this.prefix}${logical}`;
  }

  t(logical) {
    return this.tables[logical] ?? this.qualify(logical);
  }

  async exec(sql, ...rest) {
    return this.client.exec(sql, ...rest);
  }

  async query(sql, ...rest) {
    return this.client.query(sql, ...rest);
  }

  // Every row whose latest version is not physically deleted: current rows and removed versions.
  // `params` binds the values of `where` (tupleIn).
  async present(logical, where = '', params = undefined) {
    const w = where ? ` WHERE ${where}` : '';
    if (this.profile === 'clickhouse') return this.client.query(`SELECT * FROM ${this.t(logical)} FINAL${w}`, { settings: chParams(params) });
    const del = logical === 'session_units' || logical === 'session_sources' ? '' : 'NOT is_deleted';
    const all = [del, where].filter(Boolean).join(' AND ');
    return this.client.query(`SELECT * FROM ${this.t(logical)}${all ? ` WHERE ${all}` : ''}`, params ?? []);
  }

  // Current state (spec §6): not deleted, not removed.
  async current(logical, where = '') {
    return (await this.present(logical, where)).filter((r) => Number(r.removed) === 0);
  }

  // Every stored version (ClickHouse: without FINAL; PostgreSQL keeps one row per key).
  async versions(logical) {
    return this.client.query(`SELECT * FROM ${this.t(logical)}`);
  }

  // The client is closed once the namespace is gone; a drop that fails can be tried again.
  async drop() {
    if (this.profile === 'clickhouse') await this.client.exec(`DROP DATABASE IF EXISTS ${this.name} SYNC`);
    else await this.client.exec(`DROP SCHEMA IF EXISTS ${this.name} CASCADE`);
    openNamespaces.delete(this);
    await this.client.close();
  }
}

const chParams = (params) => Object.fromEntries(Object.entries(params ?? {}).map(([k, v]) => [`param_${k}`, v]));

export function clientFor(profile, target) {
  return profile === 'clickhouse' ? new ClickHouse(target) : new Postgres(target);
}

// Load this repository's DDL (schema/<profile>.sql) into a namespace, under its physical names.
// `transforms` alter the DDL text first (the self-test's DDL faults).
export async function loadSchema(ns, { transforms = [] } = {}) {
  for (const stmt of ddlStatements(ns.profile, { qualify: (t) => ns.qualify(t), transforms })) await ns.client.exec(stmt);
}

// A fresh, empty namespace (a ClickHouse database, or a PostgreSQL schema), then `create(ns)` to
// make its tables: the engine's own DDL (its `createTables`), or this repository's schema/.
export async function openNamespace(profile, target, { prefix, create = (ns) => loadSchema(ns) } = {}) {
  const client = clientFor(profile, target);
  const name = `ssql_conf_${RUN}_${++nsCounter}`;
  const ns = new Namespace(profile, client, name, prefix);
  if (profile === 'clickhouse') await client.exec(`CREATE DATABASE ${name}`);
  else await client.exec(`CREATE SCHEMA ${name}`);
  try {
    await create(ns);
  } catch (e) {
    await ns.drop().catch(() => {});
    throw e;
  }
  return ns;
}

// A value as the kit compares it across profiles: null stays null; booleans, numbers and
// strings become strings; timestamps become ISO UTC with milliseconds; arrays and objects
// become canonical JSON.
export function norm(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string') {
    const m = v.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)(Z|[+-]\d{2}(?::?\d{2})?)?$/);
    if (m) {
      const d = new Date(`${m[1]}T${m[2]}${m[3] ? (m[3].length === 3 ? `${m[3]}:00` : m[3]) : 'Z'}`);
      if (!Number.isNaN(d.getTime())) return d.toISOString();
    }
    return v;
  }
  return jcs(v);
}

// A plain INSERT of rows given as logical values, for the database checks (no engine involved).
// ClickHouse gets JSONEachRow with its default settings, so what a column does with a null is
// the column's own behaviour; PostgreSQL gets a parameterised INSERT, its jsonb values as text.
const PG_JSON = new Set(['aliases', 'setup', 'message_aliases', 'args', 'statements']);
export async function insertRows(ns, logical, rows) {
  if (ns.profile === 'clickhouse') {
    await ns.client.insert(ns.t(logical), rows, { settings: { input_format_null_as_default: 1 } });
    return;
  }
  for (const row of rows) {
    const cols = Object.keys(row);
    const vals = cols.map((c) => (PG_JSON.has(c) && row[c] !== null && typeof row[c] !== 'string' ? JSON.stringify(row[c]) : row[c]));
    await ns.query(`INSERT INTO ${ns.t(logical)} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, vals);
  }
}

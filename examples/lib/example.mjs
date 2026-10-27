// What every example shares. Its targets come from the environment, read by the conformance kit's
// own code (conformance/lib/db.mjs), so the variables are the kit's: SSQL_CH_URL, SSQL_CH_USER,
// SSQL_CH_PASSWORD and SSQL_PG_URL. Each example works in fresh namespaces of its own (a ClickHouse
// database, a PostgreSQL schema), each holding schema/'s tables under their logical names, and drops
// them when it ends, when it fails and when it is interrupted. No message it prints carries a
// credential: the kit's scrub (conformance/lib/secrets.mjs) takes them out first.
//
//   node example.mjs                       every profile the example runs on that has a target
//   node example.mjs --profile <profile>   that profile only: clickhouse or postgres
//   node example.mjs --about               print, as one line of JSON, the profiles the example runs
//                                          on and whether it reads the session-adapters package
//                                          (SSQL_ADAPTERS), and exit
//
// Without --profile, and with more than one profile to run, each profile's output follows a line
// `== <profile> ==`.
//
// Exit 0: done. Exit 1: the example failed, or a namespace it opened could not be dropped. Exit 2:
// a usage error (an unknown argument or profile, a profile the example does not run on or that has
// no target, no target at all). Exit 3: skipped, it cannot run here (it needs the session adapters,
// SSQL_ADAPTERS). An interrupted example exits 130 (SIGINT) or 143 (SIGTERM), after it dropped its
// namespaces.

import { targets as readTargets, openNamespace, loadSchema, openNamespaces, refuseNewNamespaces, PROFILES, norm } from '../../conformance/lib/db.mjs';
import { Postgres } from '../../conformance/lib/pg.mjs';
import { hostOf } from '../../conformance/lib/jcs.mjs';
import { scrub } from '../../conformance/lib/secrets.mjs';

// The synthetic machine id of the examples' hand-written rows, and its host/v0 value
// (sessions-model §1): dd20281dfd2171973d41a8686efeb11e. Never a real machine's.
export const EXAMPLE_MACHINE_ID = '0e0e0e0e0e0e4e0e8e0e0e0e0e0e0e01';
export const EXAMPLE_HOST = hostOf(EXAMPLE_MACHINE_ID);

export class Skip extends Error {}
class Usage extends Error {}

const ENV = { clickhouse: 'SSQL_CH_URL', postgres: 'SSQL_PG_URL' };

// Work to do before the namespaces are dropped on an interrupt (a child process to stop, say).
const cleanups = new Set();
export function onInterrupt(fn) {
  cleanups.add(fn);
  return () => cleanups.delete(fn);
}

let stopping = false;
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    refuseNewNamespaces(`the example was interrupted (${signal})`);
    process.stderr.write(`\n${signal}: dropping ${openNamespaces.size} namespace(s)\n`);
    for (const fn of cleanups) await Promise.resolve().then(fn).catch(() => {});
    // A statement still in flight can make the first drop fail: retry, as the kit's runner does.
    const dropHard = async (ns) => {
      for (let i = 0; i < 20 && openNamespaces.has(ns); i++) await ns.drop().catch(() => new Promise((r) => setTimeout(r, 250)));
    };
    await Promise.race([Promise.allSettled([...openNamespaces].map(dropHard)), new Promise((r) => setTimeout(r, 30000).unref())]);
    if (openNamespaces.size) process.stderr.write(`not dropped: ${[...openNamespaces].map((ns) => ns.name).join(', ')}\n`);
    process.exit(code);
  });
}

function parseArgs(argv) {
  if (argv.length === 1 && argv[0] === '--about') return { about: true };
  let profile = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--profile') throw new Usage(`unknown argument ${argv[i]}`);
    if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Usage('--profile needs a value');
    profile = argv[++i];
  }
  return { profile };
}

// Run `run(ctx)` once per selected profile. `ctx`: { profile, target, namespace() }, where
// namespace() opens a fresh namespace with schema/'s tables, dropped when this profile's run ends.
// `sessionAdapters`: whether the example reads the session-adapters package, so its README names
// the version its output is from (examples/test.mjs).
export async function runExample({ profiles = PROFILES, sessionAdapters = false, run }) {
  let notDropped = 0;
  try {
    const { profile: only, about } = parseArgs(process.argv.slice(2));
    if (about) {
      console.log(JSON.stringify({ profiles, sessionAdapters }));
      return;
    }
    const targets = readTargets();
    let selected;
    if (only !== null) {
      if (!PROFILES.includes(only)) throw new Usage(`--profile ${only}: the profiles are ${PROFILES.join(', ')}`);
      if (!profiles.includes(only)) throw new Usage(`--profile ${only}: this example runs on ${profiles.join(' and ')} only`);
      if (!targets[only]) throw new Usage(`--profile ${only}: no target (${ENV[only]} is not set)`);
      selected = [only];
    } else {
      selected = profiles.filter((p) => targets[p]);
      if (!selected.length) throw new Usage(`no target: set ${profiles.map((p) => ENV[p]).join(' and/or ')}`);
    }
    for (const profile of selected) {
      if (selected.length > 1) console.log(`== ${profile} ==`);
      const opened = [];
      const ctx = {
        profile,
        target: targets[profile],
        async namespace() {
          const ns = await openNamespace(profile, targets[profile], { prefix: '', create: (n) => loadSchema(n) });
          opened.push(ns);
          return ns;
        },
      };
      try {
        await run(ctx);
      } finally {
        for (const ns of opened) {
          await ns.drop().catch((e) => {
            notDropped++;
            process.stderr.write(`error: namespace ${ns.name} was not dropped: ${scrub(e?.message ?? e).slice(0, 200)}\n`);
          });
        }
      }
    }
  } catch (e) {
    if (e instanceof Usage) {
      console.error(`usage: ${scrub(e.message)}`);
      process.exitCode = 2;
    } else if (e instanceof Skip) {
      console.error(`skipped: ${scrub(e.message)}`);
      process.exitCode = 3;
    } else {
      console.error(`error: ${scrub(String(e?.message ?? e).split('\n')[0]).slice(0, 500)}`);
      process.exitCode = 1;
    }
  }
  // A namespace left behind fails the example, whatever else happened.
  if (notDropped) process.exitCode = 1;
}

// A client of the namespace's tables under their unqualified names, as clickhouse-client or psql
// sees them once the DDL is loaded: ClickHouse's `database` request parameter, and PostgreSQL's
// search_path, set on every connection through libpq's `options` parameter. close() it after use.
export function inNamespace(ns, target) {
  if (ns.profile === 'clickhouse') {
    return {
      query: (sql) => ns.client.query(sql, { database: ns.name }),
      exec: (sql) => ns.client.exec(sql, { database: ns.name }),
      close: async () => {},
    };
  }
  const u = new URL(target.url);
  u.searchParams.set('options', `-c search_path=${ns.name}`);
  const pg = new Postgres({ url: u.href });
  return { query: (sql) => pg.query(sql), exec: (sql) => pg.exec(sql), close: () => pg.close() };
}

// The pieces of SQL that differ between the profiles. Current state (spec §6): ClickHouse reads
// with FINAL and filters is_deleted = 0 AND removed = 0; PostgreSQL keeps one row per key and
// filters NOT is_deleted AND removed = 0. `current('p.')` qualifies the columns with an alias.
export function dialect(profile) {
  return profile === 'clickhouse'
    ? { final: 'FINAL', current: (a = '') => `${a}is_deleted = 0 AND ${a}removed = 0` }
    : { final: '', current: (a = '') => `NOT ${a}is_deleted AND ${a}removed = 0` };
}

// A value as the kit compares values across profiles (lib/db.mjs norm), NULL for null.
export const show = (v) => norm(v) ?? 'NULL';

// Rows as an aligned table, two spaces between columns, `(no rows)` for none.
export function table(rows, { indent = '  ', columns } = {}) {
  if (!rows.length) return `${indent}(no rows)`;
  const cols = columns ?? Object.keys(rows[0]);
  const cells = [cols, ...rows.map((r) => cols.map((c) => show(r[c])))];
  const width = cols.map((_, i) => Math.max(...cells.map((r) => r[i].length)));
  return cells.map((r) => `${indent}${r.map((v, i) => v.padEnd(width[i])).join('  ')}`.trimEnd()).join('\n');
}

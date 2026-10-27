#!/usr/bin/env node
// The sessions-sql conformance kit: the checks of 01-SESSIONS-SQL-SPEC.md §8, run against a
// ClickHouse or PostgreSQL target taken from the environment.
//
//   node run.mjs                 every check, on every profile with a target
//   node run.mjs --self-test     every check against each of its faults (must fail)
//   node run.mjs --only a,b      only the checks with these ids
//   node run.mjs --profile clickhouse|postgres
//   node run.mjs --allow-skip    exit 0 although a selected check could not run here
//   node run.mjs --fault k:name  with --self-test: run these faults (comma list), not each
//                                check's own, against the selected checks
//   node run.mjs --json <file>   also write the results as JSON
//   node run.mjs --verbose       print every check's notes
//
// Exit 0: every selected check ran and passed. Exit 1: a check failed or errored, or (without
// --allow-skip) a selected check was skipped or ran only as a self-check of schema/, or nothing
// was checked at all. Exit 2: a usage error (an unknown check id, flag, profile or fault; a
// profile with no target; no target at all) or the kit itself failed.
//
// Environment: SSQL_CH_URL, SSQL_CH_USER, SSQL_CH_PASSWORD, SSQL_PG_URL, SSQL_PREFIX (default
// conf_), SSQL_ENGINE (the engine module under test; default the reference engine), SSQL_ADAPTERS
// (the session-adapters package: a path or a package name). See README.md.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { targets as readTargets, describeTarget, openNamespace, loadSchema, clientFor, openNamespaces, refuseNewNamespaces, PROFILES } from './lib/db.mjs';
import { loadAdapters } from './lib/adapters.mjs';
import { expectStates } from './lib/oracle.mjs';
import { EngineError } from './lib/result.mjs';
import { scrub } from './lib/secrets.mjs';
import { DDL_FAULTS, DDL_FAULT_PROFILES, ENGINE_FAULT_PROFILES, FAULT_NOTES } from './reference/faults.mjs';
import { ENGINE_FAULTS } from './reference/engine.mjs';
import * as scenarios from './envelopes.mjs';
import { removeFixtureCopies } from './envelopes.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KIT_VERSION = JSON.parse(fs.readFileSync(path.join(HERE, 'package.json'), 'utf8')).version;
const REFERENCE = pathToFileURL(path.join(HERE, 'reference', 'engine.mjs')).href;

class SkipError extends Error {}
class UsageError extends Error {}

// Namespaces a check could not drop: named at the end of the report, never silently left.
const dropFailures = [];

// An interrupted run (Ctrl-C, or a test harness's timeout) drops what it opened and removes its
// fixture copies before it exits. It opens no namespace after the signal, and each drop waits for
// its namespace's CREATE to settle (Namespace.drop), so one whose CREATE was in flight is dropped
// after the server made it, not before.
let stopping = false;
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    refuseNewNamespaces(`the run was interrupted (${signal})`);
    process.stderr.write(`\n${signal}: dropping ${openNamespaces.size} namespace(s) and removing fixture copies\n`);
    removeFixtureCopies();
    // A statement still in flight (a table being created) can make the first drop fail: retry.
    const dropHard = async (ns) => {
      for (let i = 0; i < 20 && openNamespaces.has(ns); i++) {
        await ns.drop().catch(() => new Promise((r) => setTimeout(r, 250)));
      }
    };
    const drops = (async () => {
      for (let round = 0; round < 3 && openNamespaces.size; round++) await Promise.allSettled([...openNamespaces].map(dropHard));
    })();
    await Promise.race([drops, new Promise((r) => setTimeout(r, 30000).unref())]);
    if (openNamespaces.size) process.stderr.write(`not dropped: ${[...openNamespaces].map((ns) => ns.name).join(', ')}\n`);
    process.exit(code);
  });
}

const SCENARIOS = {
  broad: scenarios.broad, rewind: scenarios.rewind, edges: scenarios.edges, absences: scenarios.absences,
  noop: scenarios.noop, partial: scenarios.partial, twoHosts: scenarios.twoHosts, sentinels: scenarios.sentinels,
  zeroPart: scenarios.zeroPart, nullTs: scenarios.nullTs, crashRerun: scenarios.crashRerun, refLost: scenarios.refLost,
};

// Whether the engine supplies its own DDL (spec §3: a deployment's tables are its own). Without
// it, every namespace is made from this repository's schema/, and the database parts check that
// DDL, not the engine's: a self-check of schema/, kept out of the engine's verdict.
const suppliesDdl = (engineModule) => typeof engineModule?.createTables === 'function';

// What a check runs in. Every namespace it opens is dropped when it ends.
class Context {
  constructor({ profile, targets, adapters, adaptersError, engineModule, ddlFaults = [], engineFaults = [], cache }) {
    Object.assign(this, { profile, targets, adapters, adaptersError, engineModule, ddlFaults, engineFaults, cache });
    this.opened = [];
  }

  // A fresh namespace, its tables made by the engine's createTables (its own DDL), or from
  // schema/ when the engine has none.
  async namespace(profile = this.profile) {
    const create = suppliesDdl(this.engineModule)
      ? async (ns) => {
        try {
          await this.engineModule.createTables({
            profile: ns.profile, ns, target: this.targets[ns.profile], database: ns.name, prefix: ns.prefix, tables: ns.tables, faults: this.ddlFaults,
          });
        } catch (err) {
          throw new EngineError(`the engine's createTables threw: ${scrub(String(err?.message ?? err).split('\n')[0]).slice(0, 300)}`);
        }
      }
      : (ns) => loadSchema(ns, { transforms: this.ddlFaults.map((f) => DDL_FAULTS[f]) });
    const ns = await openNamespace(profile, this.targets[profile], { prefix: this.targets.prefix, create });
    this.opened.push(ns);
    return ns;
  }

  async engine(ns, { faultData } = {}) {
    if (!this.adapters) throw new SkipError(this.adaptersError);
    const e = await this.engineModule.createEngine({
      profile: ns.profile, ns, target: this.targets[ns.profile], database: ns.name, prefix: ns.prefix, tables: ns.tables,
      adapters: this.adapters, faults: this.engineFaults, faultData,
    });
    const call = async (what, fn) => {
      try {
        return await fn();
      } catch (err) {
        throw new EngineError(`the engine's ${what} threw: ${scrub(String(err?.message ?? err).split('\n')[0]).slice(0, 300)}`);
      }
    };
    return {
      name: e.name, version: e.version, removal: e.removal ?? 'removed', crashPoints: e.crashPoints, vanishPolicies: e.vanishPolicies,
      pass: (envelopes, opts = {}) => call('pass', () => e.pass(envelopes, opts)),
      replay: (opts = {}) => call('replay', () => e.replay(opts)),
      cursor: typeof e.cursor === 'function' ? () => call('cursor', () => e.cursor()) : undefined,
      legacySha: typeof e.legacySha === 'function' ? (exprs) => e.legacySha(exprs) : undefined,
    };
  }

  // A scenario, built once per run; `opts` selects a variant (the absences a check asks for).
  scenario(name, opts) {
    if (!this.adapters) throw new SkipError(this.adaptersError);
    const key = opts === undefined ? name : `${name} ${JSON.stringify(opts)}`;
    if (!this.cache.scenarios.has(key)) this.cache.scenarios.set(key, SCENARIOS[name](this.adapters, opts));
    return this.cache.scenarios.get(key);
  }

  expect(sc) {
    if (!this.cache.expect.has(sc)) this.cache.expect.set(sc, expectStates(sc.passes, this.adapters));
    return this.cache.expect.get(sc);
  }

  // Copy session_units, and nothing else, from one namespace into another (same server), leaving
  // out `except`: rows named by their whole identity (§3), never by a sha alone, which two
  // manifests of two sources can share.
  async copyUnits(from, to, { except = [] } = {}) {
    const id = ['host', 'harness', 'harness_path', 'session_id', 'incarnation', 'source_key', 'generation', 'unit_key', 'chunk', 'sha256'];
    const { where, params } = to.tupleIn(id, except.map((r) => id.map((c) => r[c])), { name: 'x' });
    await to.run(`INSERT INTO ${to.t('session_units')} SELECT * FROM ${from.t('session_units')}${except.length ? ` WHERE NOT ${where}` : ''}`, params);
  }

  async close() {
    for (const ns of this.opened) {
      await ns.drop().catch((e) => {
        dropFailures.push(ns.name);
        process.stderr.write(`warning: namespace ${ns.name} was not dropped: ${scrub(e?.message ?? e).slice(0, 200)}\n`);
      });
    }
  }
}

async function loadChecks(only) {
  const dir = path.join(HERE, 'checks');
  const files = fs.readdirSync(dir).filter((f) => /^\d\d-.*\.mjs$/.test(f)).sort();
  const all = [];
  for (const f of files) {
    const c = (await import(pathToFileURL(path.join(dir, f)).href)).default;
    c.file = f;
    c.n = Number(f.slice(0, 2));
    all.push(c);
  }
  // A mistyped id is an error, never a check silently left out.
  const unknown = (only ?? []).filter((id) => !all.some((c) => c.id === id));
  if (unknown.length) throw new UsageError(`unknown check id(s): ${unknown.join(', ')}; the checks are ${all.map((c) => c.id).join(', ')}`);
  return all.filter((c) => !only || only.includes(c.id));
}

async function loadEngine() {
  const spec = process.env.SSQL_ENGINE;
  if (!spec) return { module: await import(REFERENCE), reference: true };
  const url = spec.startsWith('.') || spec.startsWith('/') ? pathToFileURL(path.resolve(spec)).href : spec;
  const module = await import(url);
  if (typeof module.createEngine !== 'function') throw new Error(`SSQL_ENGINE ${spec} does not export createEngine()`);
  return { module, reference: url === REFERENCE };
}

// A check's parts: `database` (the profile's DDL, read through the catalogue and plain SQL) and
// `engine` (the engine under test, driven through passes). A check written as one `run` is one
// part, of its `kind`; one that lists `parts` ([{part, run}]) has those, each its own row.
function partsOf(check) {
  if (Array.isArray(check.parts)) return check.parts.map((p) => ({ part: p.part, fn: (ctx) => p.run(ctx) }));
  if (typeof check.run === 'function') return [{ part: check.kind ?? 'engine', fn: (ctx) => check.run(ctx) }];
  return ['database', 'engine'].filter((p) => typeof check[p] === 'function').map((p) => ({ part: p, fn: (ctx) => check[p](ctx) }));
}

// The status of several parts run together (the self-test): a failing part fails them all.
function combined(rs) {
  for (const s of ['fail', 'error', 'skipped']) {
    const r = rs.find((x) => x.status === s);
    if (r) return { status: s, details: rs.flatMap((x) => x.details), notes: rs.flatMap((x) => x.notes) };
  }
  return { status: rs.every((x) => x.status === 'n/a') ? 'n/a' : 'pass', details: [], notes: rs.flatMap((x) => x.notes) };
}

async function runOne(fn, ctx) {
  try {
    return await fn(ctx);
  } catch (e) {
    if (e instanceof SkipError) return { status: 'skipped', details: [], notes: [e.message] };
    if (e instanceof EngineError) return { status: 'fail', details: [scrub(e.message)], notes: [] };
    return { status: 'error', details: [scrub(`${e?.message ?? e}`.split('\n')[0]).slice(0, 400)], notes: [] };
  } finally {
    await ctx.close();
  }
}

// The profiles a run selects: --profile's, else every profile with a target. Either way, at
// least one, each with a target.
function selectProfiles(targets, onlyProfile) {
  const env = { clickhouse: 'SSQL_CH_URL', postgres: 'SSQL_PG_URL' };
  if (onlyProfile !== null) {
    if (!PROFILES.includes(onlyProfile)) throw new UsageError(`--profile ${onlyProfile}: the profiles are ${PROFILES.join(', ')}`);
    if (!targets[onlyProfile]) throw new UsageError(`--profile ${onlyProfile}: no target (${env[onlyProfile]} is not set)`);
    return [onlyProfile];
  }
  const selected = PROFILES.filter((p) => targets[p]);
  if (!selected.length) throw new UsageError(`no target: set ${PROFILES.map((p) => env[p]).join(' and/or ')}`);
  return selected;
}

// The profiles a check runs on: one column per profile, or one run over both (parity). A column
// outside the selection is `not run`: reported, never part of the verdict.
function plan(check, targets, selected) {
  if (check.both) {
    if (PROFILES.every((p) => selected.includes(p))) return [{ profile: 'both', column: 'both' }];
    return [{ profile: 'both', column: 'both', notRun: 'needs a ClickHouse and a PostgreSQL target in one run' }];
  }
  return PROFILES.map((p) => (selected.includes(p) ? { profile: p, column: p }
    : { profile: p, column: p, notRun: targets[p] ? 'not selected (--profile)' : `no ${p} target` }));
}

// The faults a self-test runs against a check: --fault's, or the check's own.
function faultsFor(check, faultArg) {
  return faultArg ?? check.faults ?? [];
}

function validFault(f) {
  const [kind, name] = f.split(':');
  if (kind === 'ddl') return Object.hasOwn(DDL_FAULTS, name);
  if (kind === 'engine') return ENGINE_FAULTS.has(name);
  return false;
}

async function serverVersion(profile, target) {
  if (!target) return null;
  const c = clientFor(profile, target);
  try {
    const rows = profile === 'clickhouse' ? await c.query('SELECT version() AS v') : await c.query('SHOW server_version');
    return profile === 'clickhouse' ? rows[0].v : rows[0].server_version;
  } catch (e) {
    return `${troubleOf(e)} (${scrub(e?.message ?? e).slice(0, 80)})`;
  } finally {
    await c.close();
  }
}

// What a target's failed first query says: `refused` when the server answered and turned the
// credentials down (ClickHouse code 516 or HTTP 401/403; a PostgreSQL SQLSTATE of class 28),
// `unreachable` when nothing answered, `error` otherwise.
function troubleOf(e) {
  const status = String(e?.status ?? '');
  const message = String(e?.message ?? e);
  if (status === '401' || status === '403' || /^28/.test(status) || /\bCode: 516\b|AUTHENTICATION_FAILED/.test(message)) return 'refused';
  if (/unreachable|did not answer/.test(message)) return 'unreachable';
  return 'error';
}

function kitCommit() {
  try {
    return execFileSync('git', ['-C', HERE, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return 'unknown';
  }
}

const FLAGS = new Set(['--self-test', '--verbose', '--allow-skip']);
const OPTIONS = new Set(['--only', '--profile', '--json', '--fault']);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (FLAGS.has(a)) out[a] = true;
    else if (OPTIONS.has(a)) {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new UsageError(`${a} needs a value`);
      out[a] = argv[++i];
    } else throw new UsageError(`unknown argument ${a}`);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const selfTest = !!args['--self-test'];
  const verbose = !!args['--verbose'];
  const allowSkip = !!args['--allow-skip'];
  const only = args['--only']?.split(',').filter(Boolean) ?? null;
  const onlyProfile = args['--profile'] ?? null;
  const jsonOut = args['--json'] ?? null;
  const faultArg = args['--fault']?.split(',').filter(Boolean) ?? null;
  if (faultArg && !selfTest) throw new UsageError('--fault runs with --self-test only');
  for (const f of faultArg ?? []) if (!validFault(f)) throw new UsageError(`unknown fault ${f} (see reference/faults.mjs)`);
  const targets = readTargets();
  const selected = selectProfiles(targets, onlyProfile);
  const { source: adapters, error: adaptersError } = await loadAdapters();
  const engine = await loadEngine();
  const checks = await loadChecks(only);
  const cache = { scenarios: new Map(), expect: new Map() };
  const engineInfo = engine.module.name ? `${engine.module.name} ${engine.module.version ?? ''}`.trim() : (process.env.SSQL_ENGINE ?? 'reference');
  let adaptersInfo = adaptersError ?? 'loaded';
  if (adapters?.root) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(adapters.root, 'package.json'), 'utf8'));
      adaptersInfo = `${pkg.name} ${pkg.version}${adapters.fixtures ? ', with fixtures' : ', no fixtures/ folder'}`;
    } catch { /* keep "loaded" */ }
  }
  console.log(`sessions-sql conformance kit ${KIT_VERSION} (commit ${kitCommit()})`);
  console.log(`engine: ${engineInfo}`);
  console.log(`session adapters: ${adaptersInfo}`);
  for (const p of PROFILES) {
    const v = await serverVersion(p, targets[p]);
    console.log(`target ${describeTarget(p, targets[p])}${v ? ` (${v})` : ''}`);
  }

  const ownDdl = suppliesDdl(engine.module);
  console.log(ownDdl
    ? 'ddl: the engine\'s own (createTables); the database parts check it'
    : 'ddl: this repository\'s schema/ (the engine supplies no createTables); the database parts are a self-check of schema/, outside the engine\'s verdict');
  console.log('');

  const results = [];
  if (!selfTest) {
    for (const check of checks) {
      for (const { part, fn } of partsOf(check)) {
        const selfCheck = part === 'database' && !ownDdl;
        for (const { profile, column, notRun } of plan(check, targets, selected)) {
          let r;
          if (notRun) r = { status: 'not run', details: [], notes: [notRun] };
          else r = await runOne(fn, new Context({ profile, targets, adapters, adaptersError, engineModule: engine.module, cache }));
          results.push({ n: check.n, id: check.id, title: check.title, part, selfCheck, column, ...r });
          process.stderr.write(`${check.n}. ${check.title} (${part}${selfCheck ? ', self-check of schema/' : ''}) [${column}]: ${r.status}\n`);
        }
      }
    }
    printReport(checks, results, verbose);
  } else {
    if (!engine.reference) throw new Error('the self-test runs the reference engine only: unset SSQL_ENGINE');
    for (const check of checks) {
      for (const fault of faultsFor(check, faultArg)) {
        const [kind, name] = fault.split(':');
        for (const { profile, column, notRun } of plan(check, targets, selected)) {
          if (notRun) continue;
          if (profile !== 'both' && !((kind === 'ddl' ? DDL_FAULT_PROFILES : ENGINE_FAULT_PROFILES)[name] ?? PROFILES).includes(profile)) continue;
          if (check.profiles && profile !== 'both' && !check.profiles.includes(profile)) continue;
          const rs = [];
          for (const { fn } of partsOf(check)) {
            rs.push(await runOne(fn, new Context({
              profile, targets, adapters, adaptersError, engineModule: engine.module, cache,
              ddlFaults: kind === 'ddl' ? [name] : [], engineFaults: kind === 'engine' ? [name] : [],
            })));
          }
          const r = combined(rs);
          results.push({ n: check.n, id: check.id, title: check.title, fault, column, ...r });
          process.stderr.write(`${check.n}. ${check.title} with ${fault} [${column}]: ${r.status === 'fail' ? 'failed, as it must' : r.status}\n`);
        }
      }
    }
    printSelfTest(results, verbose);
  }
  const v = selfTest ? selfTestVerdict(results) : verdictOf(results, allowSkip);
  if (dropFailures.length) console.log(`\nwarning: ${dropFailures.length} namespace(s) were not dropped: ${dropFailures.join(', ')}`);
  console.log(`\n${v.line}`);
  if (jsonOut) fs.writeFileSync(jsonOut, `${JSON.stringify({ kit: KIT_VERSION, commit: kitCommit(), engine: engineInfo, ddl: ownDdl ? 'engine' : 'schema/ (self-check)', selfTest, verdict: v, results }, null, 2)}\n`);
  process.exitCode = v.ok ? 0 : 1;
}

// The run's verdict. A self-check row tests schema/, not the engine: it is never part of the
// engine's pass or fail, and, like a skipped row, it is an item the run did not prove for the
// engine (exit 1 unless --allow-skip). A `not run` row (a profile outside the selection) counts
// for nothing. A run that checked nothing never passes.
function verdictOf(results, allowSkip) {
  const rows = results.filter((r) => r.status !== 'not run');
  const failed = rows.filter((r) => !r.selfCheck && (r.status === 'fail' || r.status === 'error'));
  const unproven = rows.filter((r) => r.status === 'skipped' || r.selfCheck);
  const checked = rows.filter((r) => !r.selfCheck && (r.status === 'pass' || r.status === 'fail'));
  const why = [];
  if (failed.length) why.push(`${failed.length} row(s) failed or errored`);
  if (unproven.length && !allowSkip) why.push(`${unproven.length} selected row(s) not proven for the engine (skipped, or a self-check of schema/); --allow-skip accepts that`);
  if (!checked.length) why.push('nothing was checked');
  return { ok: !why.length, failed: failed.length, unproven: unproven.length, checked: checked.length, line: why.length ? `exit 1: ${why.join('; ')}` : `exit 0: ${checked.length} row(s) checked${unproven.length ? `, ${unproven.length} not proven (allowed)` : ''}` };
}

function selfTestVerdict(results) {
  const bad = results.filter((r) => r.status !== 'fail');
  const why = [];
  if (bad.length) why.push(`${bad.length} control(s) did not make their check fail`);
  if (!results.length) why.push('no control ran');
  return { ok: !why.length, controls: results.length, caught: results.length - bad.length, line: why.length ? `exit 1: ${why.join('; ')}` : `exit 0: ${results.length} control(s), each made its check fail` };
}

function printReport(checks, results, verbose) {
  const cols = ['clickhouse', 'postgres'];
  console.log('| # | §8 item | part | ClickHouse | PostgreSQL |');
  console.log('|---|---|---|---|---|');
  for (const c of checks) {
    for (const { part } of partsOf(c)) {
      const mine = results.filter((r) => r.id === c.id && r.part === part);
      const both = mine.find((r) => r.column === 'both');
      const show = (r) => (!r || r.status === 'not run' ? '-' : `${r.status}${r.selfCheck ? ' (self-check)' : ''}`);
      const cell = (col) => (both ? show(both) : show(mine.find((r) => r.column === col)));
      const label = mine.some((r) => r.selfCheck) ? `${part}: schema/ self-check` : part;
      console.log(`| ${c.n} | ${c.title} | ${label} | ${cell(cols[0])} | ${cell(cols[1])} |`);
    }
  }
  for (const r of results) {
    if (r.status === 'not run') continue;
    if (r.details.length || (verbose && r.notes.length)) {
      console.log(`\n${r.n}. ${r.title} (${r.part}${r.selfCheck ? ', self-check of schema/' : ''}) [${r.column}]: ${r.status}`);
      for (const d of r.details) console.log(`  - ${d}`);
      if (verbose || r.status !== 'pass') for (const n of r.notes) console.log(`  · ${n}`);
    }
  }
  const tally = (rs) => {
    const t = {};
    for (const r of rs) t[r.status] = (t[r.status] ?? 0) + 1;
    return Object.entries(t).map(([k, v]) => `${v} ${k}`).join(', ') || 'none';
  };
  const notRun = results.filter((r) => r.status === 'not run');
  console.log(`\nthe engine: ${tally(results.filter((r) => !r.selfCheck && r.status !== 'not run'))}`);
  if (notRun.length) console.log(`not run (outside this run's profiles): ${[...new Set(notRun.map((r) => `${r.column}: ${r.notes[0]}`))].join('; ')}`);
  const self = results.filter((r) => r.selfCheck);
  if (self.length) console.log(`self-check of schema/ (not the engine's DDL, outside its verdict): ${tally(self)}`);
}

function printSelfTest(results, verbose) {
  console.log('| # | §8 item | fault | profile | result |');
  console.log('|---|---|---|---|---|');
  for (const r of results) {
    const ok = r.status === 'fail';
    console.log(`| ${r.n} | ${r.title} | ${r.fault}: ${FAULT_NOTES[r.fault] ?? ''} | ${r.column} | ${ok ? 'fails, as required' : `**${r.status}**: the control did not make it fail`} |`);
    if (verbose || !ok) for (const d of [...r.details, ...r.notes]) console.log(`|   |   |   |   | ${d.replace(/\|/g, '/').slice(0, 200)} |`);
  }
  const bad = results.filter((r) => r.status !== 'fail');
  console.log(`\n${results.length} controls, ${results.length - bad.length} made their check fail${bad.length ? `, ${bad.length} did not` : ''}`);
}

main().catch((e) => {
  console.error(`${e instanceof UsageError ? 'usage' : 'kit error'}: ${scrub(e?.message ?? e)}`);
  process.exitCode = 2;
});

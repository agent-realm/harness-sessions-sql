#!/usr/bin/env node
// The sessions-sql conformance kit: the checks of 01-SESSIONS-SQL-SPEC.md §8, run against a
// ClickHouse or PostgreSQL target taken from the environment.
//
//   node run.mjs                 every check, on every profile with a target
//   node run.mjs --self-test     every check against each of its faults (must fail)
//   node run.mjs --only a,b      only the checks with these ids
//   node run.mjs --profile clickhouse|postgres
//   node run.mjs --json <file>   also write the results as JSON
//   node run.mjs --verbose       print every check's notes
//
// Environment: SSQL_CH_URL, SSQL_CH_USER, SSQL_CH_PASSWORD, SSQL_PG_URL, SSQL_PREFIX (default
// conf_), SSQL_ENGINE (the engine module under test; default the reference engine), SSQL_ADAPTERS
// (the session-adapters package: a path or a package name). See README.md.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { targets as readTargets, describeTarget, openNamespace, clientFor, PROFILES } from './lib/db.mjs';
import { loadAdapters } from './lib/adapters.mjs';
import { expectStates } from './lib/oracle.mjs';
import { EngineError } from './lib/result.mjs';
import { DDL_FAULTS, FAULT_NOTES } from './reference/faults.mjs';
import * as scenarios from './envelopes.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KIT_VERSION = JSON.parse(fs.readFileSync(path.join(HERE, 'package.json'), 'utf8')).version;
const REFERENCE = pathToFileURL(path.join(HERE, 'reference', 'engine.mjs')).href;

class SkipError extends Error {}

const SCENARIOS = {
  broad: scenarios.broad, rewind: scenarios.rewind, edges: scenarios.edges, absences: scenarios.absences,
  noop: scenarios.noop, partial: scenarios.partial, twoHosts: scenarios.twoHosts, sentinels: scenarios.sentinels,
  zeroPart: scenarios.zeroPart, nullTs: scenarios.nullTs,
};

// What a check runs in. Every namespace it opens is dropped when it ends.
class Context {
  constructor({ profile, targets, adapters, adaptersError, engineModule, ddlFaults = [], engineFaults = [], cache }) {
    Object.assign(this, { profile, targets, adapters, adaptersError, engineModule, ddlFaults, engineFaults, cache });
    this.opened = [];
  }

  async namespace(profile = this.profile) {
    const transforms = this.ddlFaults.map((f) => DDL_FAULTS[f]);
    const ns = await openNamespace(profile, this.targets[profile], { prefix: this.targets.prefix, transforms });
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
        throw new EngineError(`the engine's ${what} threw: ${String(err.message).split('\n')[0].slice(0, 300)}`);
      }
    };
    return {
      name: e.name, version: e.version, removal: e.removal ?? 'removed', crashPoints: e.crashPoints,
      pass: (envelopes, opts = {}) => call('pass', () => e.pass(envelopes, opts)),
      replay: (opts = {}) => call('replay', () => e.replay(opts)),
      legacySha: typeof e.legacySha === 'function' ? (exprs) => e.legacySha(exprs) : undefined,
    };
  }

  // The engine part of a check with a database part: an engine that throws fails the check, and
  // the database part's findings stay in the report.
  async enginePart(problems, fn) {
    try {
      await fn();
    } catch (e) {
      if (!(e instanceof EngineError)) throw e;
      problems.push(e.message);
    }
  }

  scenario(name) {
    if (!this.adapters) throw new SkipError(this.adaptersError);
    if (!this.cache.scenarios.has(name)) this.cache.scenarios.set(name, SCENARIOS[name](this.adapters));
    return this.cache.scenarios.get(name);
  }

  expect(sc) {
    if (!this.cache.expect.has(sc)) this.cache.expect.set(sc, expectStates(sc.passes, this.adapters));
    return this.cache.expect.get(sc);
  }

  // Copy session_units, and nothing else, from one namespace into another (same server).
  async copyUnits(from, to, { exceptSha = [] } = {}) {
    const where = exceptSha.length ? ` WHERE NOT (enc = 'manifest' AND sha256 IN (${exceptSha.map((s) => `'${s.replace(/[^0-9a-f]/g, '')}'`).join(', ')}))` : '';
    await to.exec(`INSERT INTO ${to.t('session_units')} SELECT * FROM ${from.t('session_units')}${where}`);
  }

  async close() {
    for (const ns of this.opened) await ns.drop().catch(() => {});
  }
}

async function loadChecks(only) {
  const dir = path.join(HERE, 'checks');
  const files = fs.readdirSync(dir).filter((f) => /^\d\d-.*\.mjs$/.test(f)).sort();
  const checks = [];
  for (const f of files) {
    const c = (await import(pathToFileURL(path.join(dir, f)).href)).default;
    c.file = f;
    c.n = Number(f.slice(0, 2));
    if (!only || only.includes(c.id)) checks.push(c);
  }
  return checks;
}

async function loadEngine() {
  const spec = process.env.SSQL_ENGINE;
  if (!spec) return { module: await import(REFERENCE), reference: true };
  const url = spec.startsWith('.') || spec.startsWith('/') ? pathToFileURL(path.resolve(spec)).href : spec;
  const module = await import(url);
  if (typeof module.createEngine !== 'function') throw new Error(`SSQL_ENGINE ${spec} does not export createEngine()`);
  return { module, reference: url === REFERENCE };
}

async function runOne(check, ctx) {
  try {
    return await check.run(ctx);
  } catch (e) {
    if (e instanceof SkipError) return { status: 'skipped', details: [], notes: [e.message] };
    if (e instanceof EngineError) return { status: 'fail', details: [e.message], notes: [] };
    return { status: 'error', details: [`${e.message}`.split('\n')[0].slice(0, 400)], notes: [] };
  } finally {
    await ctx.close();
  }
}

// The profiles a check runs on: one column per profile, or one run over both (parity).
function plan(check, targets, only) {
  if (check.both) return [{ profile: 'both', column: 'both' }];
  return PROFILES.filter((p) => !only || p === only).map((p) => ({ profile: p, column: p, missing: !targets[p] }));
}

async function serverVersion(profile, target) {
  if (!target) return null;
  const c = clientFor(profile, target);
  try {
    const rows = profile === 'clickhouse' ? await c.query('SELECT version() AS v') : await c.query('SHOW server_version');
    return profile === 'clickhouse' ? rows[0].v : rows[0].server_version;
  } catch (e) {
    return `unreachable (${e.message.slice(0, 80)})`;
  } finally {
    await c.close();
  }
}

function kitCommit() {
  try {
    return execFileSync('git', ['-C', HERE, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return 'unknown';
  }
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i < 0 ? null : process.argv[i + 1];
}

async function main() {
  const selfTest = process.argv.includes('--self-test');
  const verbose = process.argv.includes('--verbose');
  const only = arg('--only')?.split(',');
  const onlyProfile = arg('--profile');
  const jsonOut = arg('--json');
  const targets = readTargets();
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
  console.log('');

  const results = [];
  if (!selfTest) {
    for (const check of checks) {
      for (const { profile, column, missing } of plan(check, targets, onlyProfile)) {
        let r;
        if (missing) r = { status: 'skipped', details: [], notes: [`no ${profile} target`] };
        else r = await runOne(check, new Context({ profile, targets, adapters, adaptersError, engineModule: engine.module, cache }));
        results.push({ n: check.n, id: check.id, title: check.title, kind: check.kind, column, ...r });
        process.stderr.write(`${check.n}. ${check.title} [${column}]: ${r.status}\n`);
      }
    }
    printReport(checks, results, verbose);
  } else {
    if (!engine.reference) throw new Error('the self-test runs the reference engine only: unset SSQL_ENGINE');
    for (const check of checks) {
      for (const fault of check.faults ?? []) {
        const [kind, name] = fault.split(':');
        for (const { profile, column, missing } of plan(check, targets, onlyProfile)) {
          if (missing) continue;
          if (kind === 'ddl' && profile === 'postgres' && ['partition-by-time', 'reorder-columns'].includes(name)) continue;
          if (check.profiles && profile !== 'both' && !check.profiles.includes(profile)) continue;
          const ctx = new Context({
            profile, targets, adapters, adaptersError, engineModule: engine.module, cache,
            ddlFaults: kind === 'ddl' ? [name] : [], engineFaults: kind === 'engine' ? [name] : [],
          });
          const r = await runOne(check, ctx);
          results.push({ n: check.n, id: check.id, title: check.title, fault, column, ...r });
          process.stderr.write(`${check.n}. ${check.title} with ${fault} [${column}]: ${r.status === 'fail' ? 'failed, as it must' : r.status}\n`);
        }
      }
    }
    printSelfTest(results, verbose);
  }
  if (jsonOut) fs.writeFileSync(jsonOut, `${JSON.stringify({ kit: KIT_VERSION, commit: kitCommit(), engine: engineInfo, selfTest, results }, null, 2)}\n`);
  const bad = selfTest ? results.filter((r) => r.status !== 'fail') : results.filter((r) => r.status === 'fail' || r.status === 'error');
  process.exitCode = bad.length ? 1 : 0;
}

function printReport(checks, results, verbose) {
  const cols = ['clickhouse', 'postgres'];
  console.log('| # | §8 item | kind | ClickHouse | PostgreSQL |');
  console.log('|---|---|---|---|---|');
  for (const c of checks) {
    const mine = results.filter((r) => r.id === c.id);
    const both = mine.find((r) => r.column === 'both');
    const cell = (col) => (both ? both.status : mine.find((r) => r.column === col)?.status ?? '-');
    console.log(`| ${c.n} | ${c.title} | ${c.kind} | ${cell(cols[0])} | ${cell(cols[1])} |`);
  }
  for (const r of results) {
    if (r.details.length || (verbose && r.notes.length)) {
      console.log(`\n${r.n}. ${r.title} [${r.column}]: ${r.status}`);
      for (const d of r.details) console.log(`  - ${d}`);
      if (verbose || r.status !== 'pass') for (const n of r.notes) console.log(`  · ${n}`);
    }
  }
  const tally = {};
  for (const r of results) tally[r.status] = (tally[r.status] ?? 0) + 1;
  console.log(`\n${Object.entries(tally).map(([k, v]) => `${v} ${k}`).join(', ')}`);
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
  console.error(`kit error: ${e.message}`);
  process.exitCode = 2;
});

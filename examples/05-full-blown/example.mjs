// Example 05: full-blown. A consumer reads three small synthetic harness stores (copies of fixture
// cases of the harness-session-adapters package) through the real session adapters, over two passes; the
// reference engine writes what it reads into a fresh namespace; the example reads the current
// state back; then the conformance kit (conformance/run.mjs) checks the reference engine against
// the same target. See README.md.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runExample, Skip, onInterrupt, table } from '../lib/example.mjs';
import { loadAdapters } from '../../conformance/lib/adapters.mjs';
import { FixtureStore, Reader, HOST_A } from '../../conformance/envelopes.mjs';
import { createEngine } from '../../conformance/reference/engine.mjs';
import { scrub } from '../../conformance/lib/secrets.mjs';

const KIT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'conformance', 'run.mjs');

// The harness stores: fixture cases of the harness-session-adapters package, each copied to a temporary
// folder first, as the kit copies them (conformance/envelopes.mjs).
const CASES = [['claude-code', 'basic'], ['codex', 'basic'], ['opencode', 'features']];

async function sessionAdapters() {
  const { source, error } = await loadAdapters();
  if (!source) throw new Skip(error);
  if (!source.fixtures) throw new Skip('SSQL_ADAPTERS names a harness-session-adapters package with no fixtures/ folder (a published package ships none): name a checkout of it');
  return source;
}

// Two passes of envelopes, all read before any database work, as a consumer reads them: one
// Reader per harness store keeps each source's position (the kit's Reader: the adapter's list,
// then read from where each source was left). Between the passes the OpenCode store deletes its
// latest message, as OpenCode deletes rows after a revert; the other stores do not change.
function readPasses(adapters) {
  const passes = [[], []];
  for (const [harness, caseName] of CASES) {
    const fx = new FixtureStore(adapters, harness, caseName);
    try {
      const reader = new Reader(adapters.adapterFor(harness), { host: HOST_A, harness, harness_path: fx.harnessPath });
      passes[0].push(...reader.pass());
      if (harness === 'opencode') {
        const db = path.relative(fx.dir, fx.harnessPath);
        const [latest] = fx.query(db, 'SELECT id FROM message ORDER BY time_created DESC, id DESC LIMIT 1');
        fx.sql(db, [['DELETE FROM part WHERE message_id = ?', [latest.id]], ['DELETE FROM message WHERE id = ?', [latest.id]]]);
      }
      passes[1].push(...reader.pass());
    } finally {
      fx.cleanup();
    }
  }
  return passes;
}

const count = (rows, f) => rows.filter(f).length;
const distinct = (rows, f) => new Set(rows.map(f)).size;

// The current state per harness (spec §6), read with the kit's own reads: current rows are those
// not deleted and not removed (ClickHouse with FINAL).
async function summary(ns) {
  const cur = {};
  for (const t of ['sessions', 'session_parts', 'session_usage', 'session_links']) cur[t] = await ns.current(t);
  const parts = await ns.present('session_parts');
  const units = await ns.present('session_units');
  console.log('the current state, per harness:');
  console.log(table(CASES.map(([h]) => {
    const mine = (r) => r.harness === h;
    const p = cur.session_parts.filter(mine);
    return {
      harness: h,
      sessions: count(cur.sessions, mine),
      messages: distinct(p, (r) => `${r.session_id}\u0000${r.message_id}`),
      part_rows: p.length,
      tool_calls: count(p, (r) => r.kind === 'tool_call'),
      usage_records: count(cur.session_usage, mine),
      link_statements: count(cur.session_links, (r) => mine(r) && r.owner === 'adapter'),
    };
  })));
  const removed = parts.filter((r) => Number(r.removed) === 1);
  const perHarness = CASES.map(([h]) => removed.filter((r) => r.harness === h))
    .filter((rows) => rows.length)
    .map((rows) => `${rows[0].harness} ${distinct(rows, (r) => `${r.session_id}\u0000${r.message_id}`)} message(s), ${rows.length} part row(s)`);
  console.log(`removed versions (session_parts, removed = 1): ${perHarness.join('; ') || 'none'}`);
  console.log('edges (session_links, owner = engine):');
  console.log(table(cur.session_links.filter((r) => r.owner === 'engine').map((r) => ({ harness: r.harness, kind: r.kind, stated_on: r.stated_on, evidence: r.evidence }))));
  console.log(`the archive: ${count(units, (r) => r.unit_key !== '')} unit row(s), ${count(units, (r) => r.unit_key === '')} read manifest(s)`);
}

// The kit, run as a separate process against this profile's target, with the reference engine
// (SSQL_ENGINE unset). Its report is read from --json; its own output is not printed.
async function runKit(profile) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-report-'));
  const json = path.join(dir, 'report.json');
  try {
    const env = { ...process.env };
    delete env.SSQL_ENGINE;
    const kit = spawn(process.execPath, [KIT, '--profile', profile, '--json', json], { env, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    kit.stdout.on('data', (d) => { out += d; });
    const exited = new Promise((resolve) => kit.on('exit', (code) => resolve(code)));
    // Interrupted: stop the kit first; it drops its own namespaces before it exits.
    const forget = onInterrupt(async () => {
      if (kit.exitCode === null) kit.kill('SIGTERM');
      await Promise.race([exited, new Promise((r) => setTimeout(r, 35000).unref())]);
    });
    const code = await exited;
    forget();
    if (!fs.existsSync(json)) throw new Error(`the kit wrote no report (exit ${code}): ${scrub(out.trim().split('\n').at(-1) ?? '')}`);
    return { code, report: JSON.parse(fs.readFileSync(json, 'utf8')) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// One line per §8 item, for this profile's column (and the parity item's, which needs both
// profiles in one run): its status when all its parts agree, else each part's.
function kitLines(report, profile) {
  const items = new Map();
  for (const r of report.results.filter((x) => x.column === profile || x.column === 'both')) {
    if (!items.has(r.n)) items.set(r.n, { title: r.title, rows: [] });
    items.get(r.n).rows.push(r);
  }
  const lines = [];
  for (const [n, { title, rows }] of items) {
    const statuses = [...new Set(rows.map((r) => r.status))];
    const status = statuses.length === 1 ? statuses[0] : rows.map((r) => `${r.part} ${r.status}`).join(', ');
    lines.push(`  ${n}. ${title}: ${status}`);
  }
  return lines;
}

await runExample({
  sessionAdapters: true,
  async run({ profile, namespace }) {
    const adapters = await sessionAdapters();
    const passes = readPasses(adapters);
    console.log(`pass 1: ${passes[0].length} reads of ${CASES.map(([h, c]) => `${h}/${c}`).join(', ')}`);
    console.log(`pass 2: ${passes[1].length} reads, after the OpenCode store deleted its latest message`);

    const ns = await namespace();
    const engine = createEngine({ profile, ns, adapters });
    for (const p of passes) await engine.pass(p);
    await summary(ns);

    console.log(`the conformance kit, the reference engine, --profile ${profile}:`);
    const { code, report } = await runKit(profile);
    for (const l of kitLines(report, profile)) console.log(l);
    console.log(`  the kit exited ${code}`);
    if (code !== 0) throw new Error(`the kit exited ${code}: ${scrub(report.verdict.line)}`);
  },
});

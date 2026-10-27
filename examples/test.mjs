#!/usr/bin/env node
// The examples' test: runs every example on every profile that has a target, and checks that it
// prints exactly the expected output its README gives.
//
//   node test.mjs                        every example, every profile with a target
//   node test.mjs --only 01,03           those examples, by number
//   node test.mjs --profile postgres     that profile only
//   node test.mjs --allow-skip           exit 0 although an example could not run here
//
// Targets come from the environment, the conformance kit's variables (conformance/README.md):
// SSQL_CH_URL, SSQL_CH_USER, SSQL_CH_PASSWORD and SSQL_PG_URL, and SSQL_ADAPTERS for example 05.
//
// A README gives its expected output as a fenced block on the line after a comment line
// `<!-- expected: <profile>[, <profile>] -->`, for each profile it names; the profiles it names
// must be those the example runs on (`node example.mjs --profiles`). Any line holding
// `<!-- expected` that does not parse so, in any case, or that names an unknown profile, fails the
// example. A README whose output depends on the session-adapters package's version says which in a
// line `<!-- session-adapters: <version> -->`; with another version in SSQL_ADAPTERS, its runs fail
// with that reason, unrun.
//
// The example runs once per profile, `node example.mjs --profile <profile>`, and its standard output
// must equal the block. Before and after every run the test lists the target's namespaces: one the
// run left behind fails it. It also interrupts one example per profile while it holds namespaces
// open, and checks that every one is gone: example 05 once the kit it runs opened one of its own,
// so the interrupt has to reach the kit too, or, when 05 did not run, example 04 once it opened its
// first.
//
// And it checks the examples' seal (lib/records.mjs) on records that leave out members a seal fills
// in: against known answers computed with session-adapters 1.0.0's seal, and, with SSQL_ADAPTERS,
// against the package's own src/records.js.
//
// Exit 0: every selected example ran and printed its expected output, and the seal check passed.
// Exit 1: one failed or printed something else, left a namespace behind, a check failed, (without
// --allow-skip) an example was skipped, or nothing ran; or the test itself failed. Exit 2: a usage
// error, or no target at all, as the kit.

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { targets as readTargets, clientFor, PROFILES } from '../conformance/lib/db.mjs';
import { loadAdapters } from '../conformance/lib/adapters.mjs';
import { scrub } from '../conformance/lib/secrets.mjs';
import { seal } from './lib/records.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENV = { clickhouse: 'SSQL_CH_URL', postgres: 'SSQL_PG_URL' };
const TIMEOUT_MS = 20 * 60 * 1000;

class Usage extends Error {}

function parseArgs(argv) {
  const out = { only: null, profile: null, allowSkip: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--allow-skip') out.allowSkip = true;
    else if (a === '--only' || a === '--profile') {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Usage(`${a} needs a value`);
      if (a === '--only') out.only = argv[++i].split(',').filter(Boolean);
      else out.profile = argv[++i];
    } else throw new Usage(`unknown argument ${a}`);
  }
  return out;
}

// ---- the READMEs --------------------------------------------------------------------------------

const EXPECTED = /^<!-- expected: ([a-z]+(?:, [a-z]+)*) -->$/;
const ADAPTERS_VERSION = /^<!-- session-adapters: (\d+\.\d+\.\d+) -->$/;

// A README's expected blocks ({ profile: text }), the adapters version it names (or null), and what
// is wrong with its markers.
function readmeOf(name) {
  const lines = fs.readFileSync(path.join(HERE, name, 'README.md'), 'utf8').split('\n');
  const expected = {};
  const problems = [];
  let adapters = null;
  lines.forEach((line, i) => {
    const at = `${name}/README.md:${i + 1}`;
    if (/<!--\s*session-adapters/i.test(line)) {
      const m = line.match(ADAPTERS_VERSION);
      if (!m) problems.push(`${at}: a session-adapters marker that does not parse`);
      else if (adapters) problems.push(`${at}: a second session-adapters marker`);
      else adapters = m[1];
    }
    if (!/<!--\s*expected/i.test(line)) return;
    const m = line.match(EXPECTED);
    if (!m) return problems.push(`${at}: an expected-output marker that does not parse (it must read \`<!-- expected: <profile>[, <profile>] -->\`)`);
    if (!/^```[a-z]*$/.test(lines[i + 1] ?? '')) return problems.push(`${at}: no fenced block on the line after the marker`);
    const end = lines.findIndex((l, k) => k > i + 1 && l === '```');
    if (end < 0) return problems.push(`${at}: the fenced block after the marker never closes`);
    for (const p of m[1].split(', ')) {
      if (!PROFILES.includes(p)) problems.push(`${at}: unknown profile ${p} (the profiles are ${PROFILES.join(', ')})`);
      else if (p in expected) problems.push(`${at}: a second expected block for ${p}`);
      else expected[p] = lines.slice(i + 2, end).join('\n');
    }
  });
  if (!Object.keys(expected).length && !problems.length) problems.push(`${name}/README.md: no expected output`);
  return { expected, adapters, problems };
}

// The profiles an example runs on, as it says itself.
function profilesOf(name) {
  const r = spawnSync(process.execPath, [path.join(HERE, name, 'example.mjs'), '--profiles'], { encoding: 'utf8', timeout: 60000 });
  if (r.status !== 0) return { error: `${name}: --profiles exited ${r.status}: ${scrub(String(r.stderr ?? '').trim().split('\n').at(-1) ?? '')}` };
  return { profiles: r.stdout.trim().split(',').filter(Boolean) };
}

function examples() {
  return fs.readdirSync(HERE, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d\d-/.test(d.name)).map((d) => d.name).sort()
    .map((name) => {
      const readme = readmeOf(name);
      const own = profilesOf(name);
      if (own.error) readme.problems.push(own.error);
      else {
        const named = Object.keys(readme.expected).sort().join(', ');
        const runs = [...own.profiles].sort().join(', ');
        if (named !== runs && !readme.problems.length) readme.problems.push(`${name}: the README gives output for ${named || 'no profile'}, the example runs on ${runs}`);
      }
      return { name, n: name.slice(0, 2), ...readme };
    });
}

// ---- the seal -----------------------------------------------------------------------------------

// Records that leave out the members a seal fills in (sessions-model §2.1, §2.3, §2.4), and their
// hashes as session-adapters 1.0.0's seal (src/records.js) computes them.
const K = { host: 'dd20281dfd2171973d41a8686efeb11e', harness: 'example-harness', harness_path: '/home/user/.example-harness', session_id: 'seal-check', incarnation: '' };
const SEAL_CASES = [
  {
    label: 'a tool_result part without exit_code',
    record: { type: 'message', ...K, message_id: 'm-1', role: 'tool', parts: [{ part_id: '0', kind: 'tool_result', call_id: 'call-1', is_error: null, status: 'completed', output: 'ok', output_len: 2, truncated: null }] },
    content_sha: '72fea99746f19e28d1dbbe32b3b0492e4b23e8be9440ef5bdcba35e9d4bfdd90',
    cmp_sha: '6e7f748c3b812bf8be259af7b0fd17e7d9465a6f048b29b43e7751727931262e',
  },
  {
    label: 'a session without setup',
    record: { type: 'session', ...K, title: 'Seal check', state: 'active', reuse: 'impossible', ts_source: 'event', aliases: [], fingerprint: { cmp_shas: [] } },
    content_sha: 'ab847cbc95e23991c28b15db0a256e747adb529b82c57a5904b76d032d28c95c',
  },
  {
    label: 'a usage record without tool_prompt',
    record: { type: 'usage', ...K, usage_id: 'response:r-1#1', anchor: { response_id: 'r-1' }, input: 1, output: 2, granularity: 'per_response' },
    content_sha: 'c246c437e8cc905b1523e6b0532ab9adeb296b86fde2f6bf8b145036d4c80ece',
  },
];

async function sealCheck() {
  const problems = [];
  const notes = [];
  let theirs = null;
  if (process.env.SSQL_ADAPTERS) {
    const { source, error } = await loadAdapters();
    const file = source?.root ? path.join(source.root, 'src', 'records.js') : null;
    if (!file || !fs.existsSync(file)) problems.push(`SSQL_ADAPTERS is set, but its package's src/records.js cannot be read${error ? `: ${error}` : ''}`);
    else {
      theirs = (await import(pathToFileURL(file).href)).seal;
      notes.push('against the package\'s own seal too');
    }
  }
  for (const c of SEAL_CASES) {
    const mine = seal(c.record);
    const want = { content_sha: c.content_sha, cmp_sha: c.cmp_sha };
    for (const k of ['content_sha', 'cmp_sha']) if (want[k] !== undefined && mine[k] !== want[k]) problems.push(`${c.label}: ${k} ${mine[k]}, the known answer ${want[k]}`);
    if (theirs) {
      const t = theirs(c.record);
      for (const k of ['content_sha', 'cmp_sha']) if ((mine[k] ?? null) !== (t[k] ?? null)) problems.push(`${c.label}: ${k} ${mine[k]}, the package's seal ${t[k]}`);
    }
  }
  return { ok: !problems.length, why: problems.length ? problems.join('\n') : `${SEAL_CASES.length} records sealed as session-adapters 1.0.0 seals them${notes.length ? `, ${notes.join(', ')}` : ''}` };
}

// The version of the session-adapters package SSQL_ADAPTERS names, or null when it is not set or
// does not load (the example then says why it skips).
async function adaptersVersion() {
  if (!process.env.SSQL_ADAPTERS) return null;
  const { source } = await loadAdapters();
  if (!source?.root) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(source.root, 'package.json'), 'utf8')).version;
  } catch {
    return 'unknown';
  }
}

// ---- running ------------------------------------------------------------------------------------

const normal = (s) => s.replace(/\r\n/g, '\n').split('\n').map((l) => l.trimEnd()).join('\n').replace(/\n+$/, '');

// The child running now, so an interrupt of the test reaches it.
let running = null;
function run(name, profile) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(HERE, name, 'example.mjs'), '--profile', profile], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    running = child;
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill('SIGTERM'), TIMEOUT_MS);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      running = null;
      resolve({ code: code ?? (signal ? 128 : 1), stdout, stderr });
    });
  });
}

for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  process.on(signal, () => {
    if (!running) process.exit(code);
    // The example drops its namespaces and exits; then so does the test.
    running.once('exit', () => process.exit(code));
    running.kill(signal);
  });
}

// What differs between the expected output and the output, as a few readable lines.
function difference(want, got) {
  const a = want.split('\n');
  const b = got.split('\n');
  const i = a.findIndex((l, k) => l !== b[k]);
  const at = i < 0 ? a.length : i;
  return [`first difference at line ${at + 1}:`, `    expected: ${a[at] ?? '(end of output)'}`, `    printed:  ${b[at] ?? '(end of output)'}`];
}

// The kit's namespaces and the examples' are named ssql_conf_<run>_<n> (conformance/lib/db.mjs).
async function namespaces(profile, target) {
  const c = clientFor(profile, target);
  try {
    const rows = profile === 'clickhouse'
      ? await c.query("SELECT name FROM system.databases WHERE startsWith(name, 'ssql_conf_')")
      : await c.query("SELECT schema_name AS name FROM information_schema.schemata WHERE schema_name LIKE 'ssql\\_conf\\_%'");
    return new Set(rows.map((r) => r.name));
  } finally {
    await c.close();
  }
}

const leftSince = async (before, profile, target) => [...await namespaces(profile, target)].filter((n) => !before.has(n));

// Interrupt the example once `want` namespaces of its own (or of its children) are open, then
// check that nothing it opened is left.
async function interruptCheck(name, profile, target, want) {
  const before = await namespaces(profile, target);
  const child = spawn(process.execPath, [path.join(HERE, name, 'example.mjs'), '--profile', profile], { env: process.env, stdio: 'ignore' });
  running = child;
  const exited = new Promise((resolve) => child.on('exit', (code) => { running = null; resolve(code); }));
  let open = 0;
  for (let i = 0; i < 2400 && open < want && child.exitCode === null; i++) {
    await new Promise((r) => setTimeout(r, 50));
    open = (await leftSince(before, profile, target)).length;
  }
  if (open < want) {
    if (child.exitCode === null) child.kill('SIGTERM');
    await exited;
    return { ok: false, why: `${name} ended before ${want} namespace(s) of its own were open, so the interrupt was not tested` };
  }
  child.kill('SIGINT');
  const code = await exited;
  const left = await leftSince(before, profile, target);
  if (code !== 130) return { ok: false, why: `${name} exited ${code} after SIGINT, not 130` };
  if (left.length) return { ok: false, why: `${name} left ${left.length} namespace(s) after SIGINT: ${left.join(', ')}` };
  return { ok: true, why: `${name} interrupted with ${open} namespace(s) of its own open: exit 130, none left` };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const targets = readTargets();
  if (args.profile !== null) {
    if (!PROFILES.includes(args.profile)) throw new Usage(`--profile ${args.profile}: the profiles are ${PROFILES.join(', ')}`);
    if (!targets[args.profile]) throw new Usage(`--profile ${args.profile}: no target (${ENV[args.profile]} is not set)`);
  }
  const selected = args.profile !== null ? [args.profile] : PROFILES.filter((p) => targets[p]);
  if (!selected.length) throw new Usage(`no target: set ${PROFILES.map((p) => ENV[p]).join(' and/or ')}`);
  const all = examples();
  const unknown = (args.only ?? []).filter((n) => !all.some((e) => e.n === n));
  if (unknown.length) throw new Usage(`unknown example(s): ${unknown.join(', ')}; the examples are ${all.map((e) => e.n).join(', ')}`);
  const chosen = all.filter((e) => !args.only || args.only.includes(e.n));
  const version = await adaptersVersion();
  const sealed = await sealCheck();

  const results = [];
  for (const ex of chosen) {
    for (const profile of PROFILES) {
      let r;
      if (ex.problems.length) r = { status: 'fail', why: ex.problems.join('\n') };
      else if (!(profile in ex.expected)) r = { status: '-' };
      else if (!selected.includes(profile)) r = { status: 'not run', why: targets[profile] ? 'not selected (--profile)' : `no target (${ENV[profile]})` };
      else if (ex.adapters && version !== null && version !== ex.adapters) {
        r = { status: 'fail', why: `not run: the README's output is session-adapters ${ex.adapters}'s, and SSQL_ADAPTERS names ${version}` };
      } else {
        const before = await namespaces(profile, targets[profile]);
        const out = await run(ex.name, profile);
        const left = await leftSince(before, profile, targets[profile]);
        if (left.length) r = { status: 'fail', why: `left ${left.length} namespace(s) behind: ${left.join(', ')}` };
        else if (out.code === 3) r = { status: 'skipped', why: normal(scrub(out.stderr)).split('\n').at(-1) };
        else if (out.code !== 0) r = { status: 'fail', why: `exit ${out.code}: ${normal(scrub(out.stderr)).split('\n').slice(-3).join(' / ')}` };
        else if (normal(out.stdout) !== normal(ex.expected[profile])) r = { status: 'fail', why: difference(normal(ex.expected[profile]), normal(scrub(out.stdout))).join('\n') };
        else r = { status: 'pass' };
      }
      results.push({ name: ex.name, profile, ...r });
      if (r.status !== '-') process.stderr.write(`${ex.name} [${profile}]: ${r.status}\n`);
    }
  }

  // The interrupt check: example 05 when it ran, interrupted while the kit it runs is running too;
  // else 04, interrupted once it opened its first namespace.
  const ran = (n) => results.some((r) => r.name.startsWith(`${n}-`) && r.status === 'pass');
  const [target, want] = ran('05') ? [all.find((e) => e.n === '05'), 2] : ran('04') ? [all.find((e) => e.n === '04'), 1] : [null, 0];
  const interrupts = [];
  if (target) {
    for (const profile of selected.filter((p) => results.some((r) => r.name === target.name && r.profile === p && r.status === 'pass'))) {
      interrupts.push({ profile, ...await interruptCheck(target.name, profile, targets[profile], want) });
    }
  }

  console.log('| example | ClickHouse | PostgreSQL |');
  console.log('|---|---|---|');
  for (const ex of chosen) {
    const cell = (p) => results.find((r) => r.name === ex.name && r.profile === p).status;
    console.log(`| ${ex.name} | ${cell('clickhouse')} | ${cell('postgres')} |`);
  }
  for (const r of results.filter((x) => x.why && x.status !== 'not run')) console.log(`\n${r.name} [${r.profile}]: ${r.status}\n  ${r.why.split('\n').join('\n  ')}`);
  for (const i of interrupts) console.log(`\ninterrupt [${i.profile}]: ${i.ok ? 'pass' : 'fail'}: ${i.why}`);
  console.log(`\nseal: ${sealed.ok ? 'pass' : 'fail'}: ${sealed.why.split('\n').join('\n  ')}`);

  const failed = results.filter((r) => r.status === 'fail').length + interrupts.filter((i) => !i.ok).length + (sealed.ok ? 0 : 1);
  const skipped = results.filter((r) => r.status === 'skipped').length;
  const passed = results.filter((r) => r.status === 'pass').length;
  const why = [];
  if (failed) why.push(`${failed} failed`);
  if (skipped && !args.allowSkip) why.push(`${skipped} skipped (--allow-skip accepts that)`);
  if (!passed && !failed) why.push('nothing ran');
  console.log(`\n${why.length ? `exit 1: ${why.join('; ')}` : `exit 0: ${passed} run(s) printed their expected output${skipped ? `, ${skipped} skipped (allowed)` : ''}${interrupts.length ? `, ${interrupts.length} interrupt check(s) passed` : ''}, the seal check passed`}`);
  process.exitCode = why.length ? 1 : 0;
}

main().catch((e) => {
  if (e instanceof Usage) {
    console.error(`usage: ${scrub(e.message)}`);
    process.exitCode = 2;
  } else {
    console.error(`error: ${scrub(e?.message ?? e)}`);
    process.exitCode = 1;
  }
});

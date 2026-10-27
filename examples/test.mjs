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
// A README gives its expected output as a fenced block right after a comment line
// `<!-- expected: <profile>[, <profile>] -->`, for each profile it names. The example runs once per
// profile, `node example.mjs --profile <profile>`, and its standard output must equal the block.
// Each example drops the namespaces it opens when it ends, fails or is interrupted. The test also
// interrupts one example per profile while it holds namespaces open, and checks that every one is
// gone: example 05 once the kit it runs opened one of its own, so the interrupt has to reach the
// kit too, or, when 05 did not run, example 04 once it opened its first.
//
// Exit 0: every selected example ran and printed its expected output. Exit 1: one failed or printed
// something else, the interrupt check failed, (without --allow-skip) an example was skipped, or
// nothing ran. Exit 2: a usage error, or no target at all, as the kit.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { targets as readTargets, clientFor, PROFILES } from '../conformance/lib/db.mjs';
import { scrub } from '../conformance/lib/secrets.mjs';

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

// Every example folder (NN-name), with the expected output blocks its README gives.
function examples() {
  return fs.readdirSync(HERE, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d\d-/.test(d.name)).map((d) => d.name).sort()
    .map((name) => {
      const readme = fs.readFileSync(path.join(HERE, name, 'README.md'), 'utf8');
      const expected = {};
      for (const m of readme.matchAll(/<!-- expected: ([a-z, ]+) -->\s*\n```[a-z]*\n([\s\S]*?)\n```/g)) {
        for (const p of m[1].split(',').map((x) => x.trim())) expected[p] = m[2];
      }
      if (!Object.keys(expected).length) throw new Error(`${name}/README.md gives no expected output`);
      return { name, n: name.slice(0, 2), expected };
    });
}

const lines = (s) => s.replace(/\r\n/g, '\n').split('\n').map((l) => l.trimEnd()).join('\n').replace(/\n+$/, '');

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

// Interrupt the example once `want` namespaces of its own (or of its children) are open, then
// check that nothing it opened is left. Example 05 has two open once the kit it runs opened its
// first: the interrupt then has to reach the kit too.
async function interruptCheck(name, profile, target, want) {
  const before = await namespaces(profile, target);
  const child = spawn(process.execPath, [path.join(HERE, name, 'example.mjs'), '--profile', profile], { env: process.env, stdio: 'ignore' });
  running = child;
  const exited = new Promise((resolve) => child.on('exit', (code) => { running = null; resolve(code); }));
  let open = 0;
  for (let i = 0; i < 2400 && open < want && child.exitCode === null; i++) {
    await new Promise((r) => setTimeout(r, 50));
    open = [...await namespaces(profile, target)].filter((n) => !before.has(n)).length;
  }
  if (open < want) {
    if (child.exitCode === null) child.kill('SIGTERM');
    await exited;
    return { ok: false, why: `${name} ended before ${want} namespace(s) of its own were open, so the interrupt was not tested` };
  }
  child.kill('SIGINT');
  const code = await exited;
  const left = [...await namespaces(profile, target)].filter((n) => !before.has(n));
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

  const results = [];
  for (const ex of chosen) {
    for (const profile of PROFILES) {
      let r;
      if (!(profile in ex.expected)) r = { status: '-' };
      else if (!selected.includes(profile)) r = { status: 'not run', why: targets[profile] ? 'not selected (--profile)' : `no target (${ENV[profile]})` };
      else {
        const out = await run(ex.name, profile);
        if (out.code === 3) r = { status: 'skipped', why: lines(scrub(out.stderr)).split('\n').at(-1) };
        else if (out.code !== 0) r = { status: 'fail', why: `exit ${out.code}: ${lines(scrub(out.stderr)).split('\n').slice(-3).join(' / ')}` };
        else if (lines(out.stdout) !== lines(ex.expected[profile])) r = { status: 'fail', why: difference(lines(ex.expected[profile]), lines(scrub(out.stdout))).join('\n') };
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

  const failed = results.filter((r) => r.status === 'fail').length + interrupts.filter((i) => !i.ok).length;
  const skipped = results.filter((r) => r.status === 'skipped').length;
  const passed = results.filter((r) => r.status === 'pass').length;
  const why = [];
  if (failed) why.push(`${failed} failed`);
  if (skipped && !args.allowSkip) why.push(`${skipped} skipped (--allow-skip accepts that)`);
  if (!passed && !failed) why.push('nothing ran');
  console.log(`\n${why.length ? `exit 1: ${why.join('; ')}` : `exit 0: ${passed} run(s) printed their expected output${skipped ? `, ${skipped} skipped (allowed)` : ''}${interrupts.length ? `, ${interrupts.length} interrupt check(s) passed` : ''}`}`);
  process.exitCode = why.length ? 1 : 0;
}

main().catch((e) => {
  console.error(`${e instanceof Usage ? 'usage' : 'error'}: ${scrub(e?.message ?? e)}`);
  process.exitCode = 2;
});

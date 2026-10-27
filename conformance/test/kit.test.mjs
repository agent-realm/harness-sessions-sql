// The kit's own tests. The first group needs nothing but Node; the last two run the kit and its
// self-test against the targets the environment names, and are skipped without them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { identities, knownAnswerVectors, fullRowVectors, ddlColumns, LEGACY_LINE_EXCLUDES } from '../lib/spec.mjs';
import { jcs, sha256, hostOf } from '../lib/jcs.mjs';
import { ddlStatements, describeTarget, norm } from '../lib/db.mjs';
import { rkOfLive, rkOfRow, recordKey } from '../lib/keys.mjs';
import { DDL_FAULTS, DDL_FAULT_PROFILES } from '../reference/faults.mjs';
import { keyElements } from '../checks/01-tables-and-keys.mjs';
import { encodeAdapterVer } from '../reference/rows.mjs';
import { bumpVersion } from '../lib/adapters.mjs';
import { scrub, registerUrl, registerSecret } from '../lib/secrets.mjs';
import { openNamespace, loadSchema, targets as readTargets } from '../lib/db.mjs';
import * as reference from '../reference/engine.mjs';
import { HOST_A } from '../envelopes.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

test('spec §3: seven tables, session_sources informative, every identity starting with the session key', () => {
  const { sessionKey, tables } = identities();
  assert.deepEqual(sessionKey, ['host', 'harness', 'harness_path', 'session_id', 'incarnation']);
  assert.deepEqual(Object.keys(tables).sort(), ['session_lifecycle', 'session_links', 'session_parts', 'session_sources', 'session_units', 'session_usage', 'sessions']);
  assert.equal(tables.session_sources.informative, true);
  for (const t of Object.values(tables)) assert.deepEqual(t.identity.slice(0, 5), sessionKey);
});

test('spec §4.8: every known-answer line hashes to its sha outside SQL', () => {
  const v = knownAnswerVectors();
  assert.ok(v.length >= 7);
  for (const x of v) assert.equal(sha256(Buffer.from(x.line, 'utf8')), x.sha256, x.exprs.join(', '));
});

test('spec §4.8: every full-row line hashes to its sha, with as many fields as its table has line columns', () => {
  const v = fullRowVectors();
  assert.ok(v.some((x) => x.table === 'sessions') && v.some((x) => x.table === 'session_parts'));
  for (const x of v) {
    assert.equal(sha256(Buffer.from(x.line, 'utf8')), x.sha256, x.label);
    const exclude = new Set([...LEGACY_LINE_EXCLUDES.common, ...(LEGACY_LINE_EXCLUDES[x.table] ?? [])]);
    assert.equal(x.line.split('\t').length, ddlColumns('clickhouse', x.table).filter((c) => !exclude.has(c)).length, x.label);
  }
});

test('DDL: every table gets the deployment prefix in its namespace, for both profiles', () => {
  for (const profile of ['clickhouse', 'postgres']) {
    const stmts = ddlStatements(profile, { qualify: (t) => `ns.pre_${t}` });
    assert.equal(stmts.length, 7);
    for (const s of stmts) assert.match(s, /^CREATE TABLE ns\.pre_[a-z_]+/);
  }
});

test('DDL faults: each finds its pattern in the profiles it applies to', () => {
  for (const [name, fault] of Object.entries(DDL_FAULTS)) {
    for (const profile of DDL_FAULT_PROFILES[name] ?? ['clickhouse', 'postgres']) {
      const before = ddlStatements(profile, { qualify: (t) => t }).join(';');
      const after = ddlStatements(profile, { qualify: (t) => t, transforms: [fault] }).join(';');
      assert.notEqual(after, before, `${name} on ${profile}`);
    }
  }
});

test('a ClickHouse key splits at its top-level commas only', () => {
  assert.deepEqual(keyElements("toDate(ts), host, toStartOfInterval(ts, INTERVAL 1 day), 'a,b', part_id"),
    ['toDate(ts)', 'host', 'toStartOfInterval(ts, INTERVAL 1 day)', "'a,b'", 'part_id']);
});

test('JCS and host/v0: canonical order, and the sessions-model known answer for a Linux machine id', () => {
  assert.equal(jcs({ b: 1, a: [true, null, 'x'] }), '{"a":[true,null,"x"],"b":1}');
  assert.equal(hostOf('0f1e2d3c4b5a69788796a5b4c3d2e1f0'), '0d0d3eefb2fba3434590abdc952a7ef7');
});

test('keys: a link live key maps to the same rk as its statement row', () => {
  const rec = { type: 'link', kind: 'subagent', stated_on: 'child', child: { harness: 'h', session_id: 'c' }, origin: { harness: 'h', session_id: 'o' }, at: '' };
  const row = { owner: 'adapter', kind: 'subagent', other_host: '', other_harness_path: '', other_harness: 'h', other_session_id: 'o', other_incarnation: '', at: '' };
  assert.equal(rkOfLive('link', recordKey(rec)), rkOfRow('session_links', row));
  assert.equal(rkOfRow('session_links', { ...row, owner: 'engine' }), null);
});

test('targets are printed without credentials; values compare alike across profiles', () => {
  const t = describeTarget('postgres', { url: 'postgres://fake-user:fake-pass@db.example:5432/db' });
  assert.ok(!t.includes('fake-pass') && !t.includes('fake-user'), t);
  assert.equal(t, 'postgres: postgres://db.example:5432/db');
  assert.equal(norm('2026-01-02 09:00:06.840'), norm('2026-01-02 09:00:06.84+00'));
  assert.equal(norm(true), 'true');
});

test('adapter_ver: a.b.c encoded as an integer, and the kit bumps the patch', () => {
  assert.equal(encodeAdapterVer('0.2.0'), 2000);
  assert.equal(bumpVersion('0.2.0'), '0.2.1');
  assert.ok(encodeAdapterVer(bumpVersion('1.9.9')) > encodeAdapterVer('1.9.9'));
});

test('secrets: a URL user and password, registered, leave no trace in a message', () => {
  registerUrl('postgres://unit-user-7:unit-p%40ss-7@db.example:5432/x');
  registerSecret('unit-key-7');
  const msg = 'password authentication failed for user "unit-user-7" (unit-p@ss-7, unit-p%40ss-7, unit-key-7) at http://fake-a:fake-b@host.invalid:1/';
  const out = scrub(msg);
  for (const v of ['unit-user-7', 'unit-p@ss-7', 'unit-p%40ss-7', 'unit-key-7', 'fake-a:fake-b']) assert.ok(!out.includes(v), `${v} in ${out}`);
  assert.ok(scrub('unit-user-70 and my-unit-user-7').includes('unit-user-70'), 'a user name is replaced only as a word');
});

// A password holding `@` (raw or as %40) or `/`, or given as a ?password= parameter. Its parts are
// what a cut at the wrong `@` would leave behind.
const AT_PASSWORD = 'p@ssW0rdX';
const AT_PARTS = ['ssW0rdX', 'p@ss', 'p%40ss', 'pa/ss'];

test('secrets: a URL whose password holds @ or /, registered or not, leaves no part of it in a message', () => {
  // Not registered: the URL net alone cuts the user info at the last `@` of the URL.
  for (const msg of [
    `connect to postgres://fake-u1:${AT_PASSWORD}@db.invalid:1/kit failed`,
    'connect to postgres://fake-u1:p%40ssW0rdX@db.invalid:1/kit failed',
    'connect to postgres://fake-u1:pa/ssW0rdX@db.invalid:1/kit failed',
    `connect to postgres://db.invalid:1/kit?user=fake-u1&password=${AT_PASSWORD} failed`,
    `connect to http://fake-u1:${AT_PASSWORD}@ch.invalid:8123/?database=x failed`,
  ]) {
    const out = scrub(msg);
    for (const v of [...AT_PARTS, 'fake-u1']) assert.ok(!out.includes(v), `${v} in ${out}`);
    assert.match(out, /\b(db|ch)\.invalid\b/, `the host is kept: ${out}`);
  }
  // Registered (as a target's URL registers it): wherever the value stands, and inside a URL.
  const pw = 'q@ssW0rdY';
  registerUrl(`postgres://fake-u8:${encodeURIComponent(pw)}@db.invalid:1/kit`);
  registerSecret('fake-pa/ss-7');
  for (const msg of [
    `connect to postgres://fake-u8:${pw}@db.invalid:1/kit failed`,
    `the password ${pw} (${encodeURIComponent(pw)}) was refused`,
    'connect to postgres://fake-u7:fake-pa/ss-7@db.invalid:1/kit failed (fake-pa%2Fss-7)',
  ]) {
    const out = scrub(msg);
    for (const v of ['ssW0rdY', 'q@ss', 'q%40ss', 'fake-u8', 'fake-u7', 'pa/ss', 'pa%2Fss']) assert.ok(!out.includes(v), `${v} in ${out}`);
  }
});

const KIT = path.join(HERE, '..', 'run.mjs');
const kitEnv = (over) => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('SSQL_')));
  return { ...env, ...over };
};
const runKit = (args, env, timeout = 120 * 1000) => {
  const json = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ssql-kit-test-')), 'report.json');
  const r = spawnSync(process.execPath, [KIT, ...args, '--json', json], { encoding: 'utf8', env, timeout });
  const report = fs.existsSync(json) ? fs.readFileSync(json, 'utf8') : '';
  fs.rmSync(path.dirname(json), { recursive: true, force: true });
  return { ...r, report };
};
const ENGINES = path.join(HERE, 'engines');
const withEngine = (file, over = {}) => ({ ...process.env, SSQL_ENGINE: path.join(ENGINES, file), ...over });
const rows = (r) => JSON.parse(r.report).results;

const FAKE = ['fakeuser', 'fake-chpass', 'fakepguser', 'fake-pgpass'];
const assertNoFake = (r) => {
  for (const [where, text] of [['stdout', r.stdout], ['stderr', r.stderr], ['--json', r.report]]) {
    for (const v of FAKE) assert.ok(!text.includes(v), `${v} printed in ${where}:\n${text}`);
  }
};

test('a failing connection prints no user or password of either profile, in stdout, stderr or --json', () => {
  const r = runKit(['--only', 'tables-and-keys,host-form'], kitEnv({
    SSQL_CH_URL: 'http://fakeuser:fake-chpass@127.0.0.1:1',
    SSQL_PG_URL: 'postgres://fakepguser:fake-pgpass@127.0.0.1:1/kit',
  }));
  assert.ok(/unreachable/.test(r.stdout + r.report), `the failing connection path did not run:\n${r.stdout}${r.stderr}`);
  assertNoFake(r);
  assert.notEqual(r.status, 0);
});

const assertNoParts = (r, parts) => {
  for (const [where, text] of [['stdout', r.stdout], ['stderr', r.stderr], ['--json', r.report]]) {
    for (const v of parts) assert.ok(!text.includes(v), `${v} printed in ${where}:\n${text}`);
  }
};

test('a target password holding @: no part of it is printed, in stdout, stderr or --json', () => {
  const r = runKit(['--only', 'tables-and-keys,host-form'], kitEnv({
    SSQL_CH_URL: `http://fake-u1:${AT_PASSWORD}@ch.invalid:1`,
    SSQL_PG_URL: `postgres://fake-u2:${AT_PASSWORD}@pg.invalid:1/kit`,
  }));
  assert.ok(/unreachable/.test(r.stdout + r.report), `the failing connection path did not run:\n${r.stdout}${r.stderr}`);
  assertNoParts(r, [...AT_PARTS, 'fake-u1', 'fake-u2']);
  assert.notEqual(r.status, 0);
});

test('an engine that fails to load, quoting a URL with a password holding @: no part of it is printed', () => {
  const r = runKit([], kitEnv({ SSQL_CH_URL: 'http://127.0.0.1:1', SSQL_ENGINE: path.join(ENGINES, 'leaky-load.mjs') }));
  assert.match(r.stderr, /kit error: could not reach the archive at postgres:\/\/archive\.invalid:5432\/sessions/, r.stderr);
  assertNoParts(r, [...AT_PARTS, 'fake-archive']);
  assert.equal(r.status, 2);
});

test('usage errors exit 2: an unknown check id, flag, profile or fault, a profile with no target, no target at all', () => {
  const ch = { SSQL_CH_URL: 'http://127.0.0.1:1' };
  for (const [args, env, want] of [
    [['--only', 'host-form,no-such-check'], ch, /unknown check id\(s\): no-such-check/],
    [['--profile', 'mysql'], ch, /--profile mysql/],
    [['--profile', 'postgres'], ch, /no target \(SSQL_PG_URL/],
    [[], {}, /no target: set SSQL_CH_URL/],
    [['--bogus'], ch, /unknown argument --bogus/],
    [['--fault', 'engine:regenerate'], ch, /--fault runs with --self-test only/],
    [['--self-test', '--fault', 'engine:no-such-fault'], ch, /unknown fault/],
  ]) {
    const r = runKit(args, kitEnv(env));
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, want, args.join(' '));
  }
});

const haveTargets = !!(process.env.SSQL_CH_URL || process.env.SSQL_PG_URL) && !!process.env.SSQL_ADAPTERS;
const anyTarget = !!(process.env.SSQL_CH_URL || process.env.SSQL_PG_URL);

test('a selected check that is skipped fails the run, unless --allow-skip; nothing checked never passes', { skip: !anyTarget && 'no SSQL_CH_URL or SSQL_PG_URL' }, () => {
  const env = { ...process.env, SSQL_ADAPTERS: '' };
  const r = runKit(['--only', 'tables-and-keys'], env, 10 * 60 * 1000);
  const res = rows(r);
  assert.ok(res.some((x) => x.part === 'engine' && x.status === 'skipped'), r.stdout);
  assert.ok(res.some((x) => x.part === 'database' && x.status === 'pass'), r.stdout);
  assert.equal(r.status, 1, r.stdout);
  assert.equal(runKit(['--only', 'tables-and-keys', '--allow-skip'], env, 10 * 60 * 1000).status, 0);
  const none = runKit(['--only', 'twice-is-once', '--allow-skip'], env, 10 * 60 * 1000);
  assert.equal(none.status, 1, 'a run where every row was skipped checked nothing');
  assert.match(none.stdout, /nothing was checked/);
});

test('one profile alone: parity is not run and is no part of the verdict', { skip: !haveTargets && 'no SSQL_CH_URL or SSQL_PG_URL, or no SSQL_ADAPTERS' }, () => {
  for (const profile of ['clickhouse', 'postgres'].filter((p) => process.env[p === 'clickhouse' ? 'SSQL_CH_URL' : 'SSQL_PG_URL'])) {
    const r = runKit(['--profile', profile, '--only', 'database-profile-parity,host-form'], process.env, 10 * 60 * 1000);
    const res = rows(r);
    assert.equal(res.find((x) => x.id === 'database-profile-parity').status, 'not run', r.stdout);
    assert.equal(res.find((x) => x.id === 'host-form' && x.column === profile).status, 'pass', r.stdout);
    assert.equal(r.status, 0, r.stdout + r.stderr);
  }
});
const kit = (args) => spawnSync(process.execPath, [KIT, ...args], { encoding: 'utf8', env: process.env, timeout: 30 * 60 * 1000 });

// The server's own refusal names the user it refused; the kit prints none of it.
const withUserInfo = (url, user, password) => {
  const u = new URL(url);
  u.username = user;
  u.password = password;
  return u.href.replace(/\/$/, '');
};
test('a server that refuses fake credentials: its message prints no user or password', { skip: !(process.env.SSQL_CH_URL || process.env.SSQL_PG_URL) && 'no SSQL_CH_URL or SSQL_PG_URL' }, () => {
  const over = {};
  if (process.env.SSQL_CH_URL) over.SSQL_CH_URL = withUserInfo(process.env.SSQL_CH_URL, 'fakeuser', 'fake-chpass');
  if (process.env.SSQL_PG_URL) over.SSQL_PG_URL = withUserInfo(process.env.SSQL_PG_URL, 'fakepguser', 'fake-pgpass');
  const r = runKit(['--only', 'tables-and-keys,host-form'], kitEnv(over));
  assert.ok(/authentication|password|AUTHENTICATION/i.test(r.stdout + r.report), `no authentication failure was reported:\n${r.stdout}${r.stderr}`);
  // The target line calls a refusal a refusal, not unreachable.
  for (const p of ['clickhouse', 'postgres'].filter((x) => over[x === 'clickhouse' ? 'SSQL_CH_URL' : 'SSQL_PG_URL'])) {
    assert.match(r.stdout, new RegExp(`^target ${p}: \\S+ \\(refused \\(`, 'm'), r.stdout);
  }
  assertNoFake(r);
  assert.notEqual(r.status, 0);
});

test('the reference engine passes every check on every target', { skip: !haveTargets && 'no SSQL_CH_URL or SSQL_PG_URL, or no SSQL_ADAPTERS', timeout: 30 * 60 * 1000 }, () => {
  const r = kit([]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('self-test: every check fails against each of its faults', { skip: !haveTargets && 'no SSQL_CH_URL or SSQL_PG_URL, or no SSQL_ADAPTERS', timeout: 30 * 60 * 1000 }, () => {
  const r = kit(['--self-test']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});


test('an engine that supplies no DDL: its database parts are a self-check of schema/, outside its verdict', { skip: !haveTargets && 'no SSQL_CH_URL or SSQL_PG_URL, or no SSQL_ADAPTERS' }, () => {
  const r = runKit(['--only', 'host-form,tables-and-keys'], withEngine('no-ddl.mjs'), 10 * 60 * 1000);
  const res = rows(r);
  assert.ok(res.some((x) => x.part === 'database'), r.stdout + r.stderr);
  for (const x of res) assert.equal(x.selfCheck, x.part === 'database', `${x.id} ${x.part}`);
  assert.match(r.stdout, /schema\/ self-check/);
  assert.match(r.stdout, /self-check of schema\/ \(not the engine's DDL, outside its verdict\)/);
  assert.equal(r.status, 1, 'self-check rows are not proven for the engine: exit 1 without --allow-skip');
  assert.equal(runKit(['--only', 'host-form,tables-and-keys', '--allow-skip'], withEngine('no-ddl.mjs'), 10 * 60 * 1000).status, 0);
});

test("an engine's own faulty DDL, supplied through createTables, fails the database checks", { skip: !haveTargets && 'no SSQL_CH_URL or SSQL_PG_URL, or no SSQL_ADAPTERS' }, () => {
  const r = runKit(['--only', 'host-form'], withEngine('faulty-ddl.mjs'), 10 * 60 * 1000);
  const res = rows(r).filter((x) => x.status !== 'not run');
  assert.ok(res.length, r.stdout + r.stderr);
  for (const x of res) {
    assert.equal(x.selfCheck, false);
    assert.equal(x.status, 'fail', `${x.column}: ${x.status}`);
  }
  assert.equal(r.status, 1);
});

test("an engine's error quoting a URL with a password holding @: no part of it is printed, in stdout, stderr or --json", { skip: !haveTargets && 'no SSQL_CH_URL or SSQL_PG_URL, or no SSQL_ADAPTERS' }, async () => {
  const { PASSWORD } = await import('./engines/leaky-errors.mjs');
  assert.equal(PASSWORD, AT_PASSWORD);
  const r = runKit(['--only', 'tables-and-keys'], withEngine('leaky-errors.mjs'), 10 * 60 * 1000);
  const failed = rows(r).filter((x) => x.part === 'engine' && x.status === 'fail');
  assert.ok(failed.length && failed.every((x) => /the engine's pass threw: the archive at postgres:\/\/archive\.invalid/.test(x.details.join(' '))), `the engine's error was not reported:\n${r.stdout}${r.stderr}`);
  assertNoParts(r, [...AT_PARTS, 'fake-archive']);
  assert.equal(r.status, 1);
});

test('an engine that keeps its cursor in a table of its own: Crash-safe reads it through cursor(), fails a stop the engine ignores, and without cursor() proves nothing', { skip: !haveTargets && 'no SSQL_CH_URL or SSQL_PG_URL, or no SSQL_ADAPTERS' }, () => {
  const ran = (r) => rows(r).filter((x) => x.status !== 'not run');
  const ok = runKit(['--only', 'crash-safe', '--verbose'], withEngine('cursor-own-table.mjs'), 10 * 60 * 1000);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /the cursor read through the engine's cursor\(\)/);
  const ignores = runKit(['--only', 'crash-safe'], withEngine('cursor-ignores-stops.mjs'), 10 * 60 * 1000);
  assert.ok(ran(ignores).length, ignores.stdout + ignores.stderr);
  for (const x of ran(ignores)) {
    assert.equal(x.status, 'fail', `${x.column}: ${x.status}`);
    assert.match(x.details.join(' '), /crashed after entities, pass 1: the cursor \(the engine's cursor\(\)\) changed/);
  }
  const hidden = runKit(['--only', 'crash-safe'], withEngine('cursor-hidden.mjs'), 10 * 60 * 1000);
  assert.ok(ran(hidden).length, hidden.stdout + hidden.stderr);
  for (const x of ran(hidden)) {
    assert.equal(x.status, 'skipped', `${x.column}: ${x.status}`);
    assert.match(x.notes.join(' '), /not proven: the kit cannot see the cursor/);
  }
  assert.equal(hidden.status, 1);
});

test("an engine whose ClickHouse DDL prefixes a sort key with toDate(ts), as §3 allows, passes Tables and keys", { skip: !haveTargets && 'no SSQL_CH_URL or SSQL_PG_URL, or no SSQL_ADAPTERS' }, () => {
  const r = runKit(['--only', 'tables-and-keys', '--verbose'], withEngine('sort-key-prefix.mjs'), 10 * 60 * 1000);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  if (process.env.SSQL_CH_URL) assert.match(r.stdout, /a sort-key prefix §3 allows: \w*session_parts \(toDate\(ts\)\)/);
});

test('an engine whose DDL adds a column of its own: Legacy content_sha, whole rows leaves it out of the line (§4.8)', { skip: !(haveTargets && process.env.SSQL_CH_URL) && 'no SSQL_CH_URL or no SSQL_ADAPTERS' }, () => {
  const r = runKit(['--profile', 'clickhouse', '--only', 'legacy-content-sha-whole-rows', '--verbose'], withEngine('added-column.mjs'), 10 * 60 * 1000);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /columns the deployment adds, left out of the line \(§4\.8\): session_parts\.tenant, sessions\.tenant/);
});

test("an engine with a table of the consumer's own whose ts is not Nullable: No time partition leaves it alone", { skip: !haveTargets && 'no SSQL_CH_URL or SSQL_PG_URL, or no SSQL_ADAPTERS' }, () => {
  const r = runKit(['--only', 'no-time-partition'], withEngine('extra-table.mjs'), 10 * 60 * 1000);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('an engine with no legacy SQL: both legacy checks skip their engine part, never passed', { skip: !(haveTargets && process.env.SSQL_CH_URL) && 'no SSQL_CH_URL or no SSQL_ADAPTERS' }, () => {
  const r = runKit(['--profile', 'clickhouse', '--only', 'legacy-content-sha-line-format,legacy-content-sha-whole-rows'], withEngine('no-legacy-sql.mjs'), 10 * 60 * 1000);
  const res = rows(r).filter((x) => x.column === 'clickhouse');
  const engineRows = res.filter((x) => x.part === 'engine');
  assert.equal(engineRows.length, 2, r.stdout);
  for (const x of engineRows) {
    assert.equal(x.status, 'skipped', `${x.id}: ${x.status}`);
    assert.match(x.notes.join(' '), /supplies no legacy SQL/);
  }
  // The deployed DDL is still checked, through §4.8's own expression.
  assert.equal(res.find((x) => x.id === 'legacy-content-sha-whole-rows' && x.part === 'database')?.status, 'pass', r.stdout);
  assert.equal(r.status, 1, 'the legacy SQL is not proven');
});

test("an engine with no DDL but a legacy SQL of its own: a wrong legacy SQL fails it, though its database rows are a self-check", { skip: !(haveTargets && process.env.SSQL_CH_URL) && 'no SSQL_CH_URL or no SSQL_ADAPTERS' }, () => {
  const r = runKit(['--profile', 'clickhouse', '--only', 'tables-and-keys,legacy-content-sha-whole-rows', '--allow-skip'], withEngine('no-ddl-bad-legacy.mjs'), 10 * 60 * 1000);
  const row = rows(r).find((x) => x.id === 'legacy-content-sha-whole-rows' && x.part === 'engine' && x.column === 'clickhouse');
  assert.equal(row?.status, 'fail', r.stdout);
  assert.equal(row.selfCheck, false);
  assert.match(row.details.join(' '), /through the engine's legacy SQL/);
  assert.equal(r.status, 1, r.stdout);
});

test('an engine that stores large units in several chunks passes Units only', { skip: !haveTargets && 'no SSQL_CH_URL or SSQL_PG_URL, or no SSQL_ADAPTERS' }, () => {
  const r = runKit(['--only', 'units-only', '--verbose'], withEngine('chunking.mjs'), 10 * 60 * 1000);
  assert.match(r.stdout, /units \([1-9]\d* in several chunks\)/, 'the engine chunked nothing: the test proves nothing');
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

// The reference engine alone, on a synthetic source, with an adapter that derives nothing.
const STUB = {
  describe: () => ({ adapter: 'kit-adapter', adapter_ver: '0.0.1', model_version: 'sessions-model/1', state_ver: 1 }),
  adapterFor: () => ({ describe: () => STUB.describe(), derive: () => ({ changed: [], live: {}, held: {} }) }),
};
const stubUnit = (k, body) => ({ source_key: 'kit.jsonl', unit_key: k, enc: 'utf8', bytes: Buffer.byteLength(body), sha256: sha256(Buffer.from(body, 'utf8')), redacted: false, body });
const stubRead = (from, continuity, units, position, sessionId = 'kit-s') => ({
  store: { host: HOST_A, harness: 'kit-harness', harness_path: '/home/user/.kit' }, session: { session_id: sessionId, incarnation: '' },
  source_key: 'kit.jsonl', role: 'main', mode: 'stream', position_kind: 'offset', from, read: { continuity, units, gone: [], position, held_back: [] },
});
const withEngineNs = async (fn) => {
  const t = readTargets();
  for (const profile of ['clickhouse', 'postgres'].filter((p) => t[p])) {
    const ns = await openNamespace(profile, t[profile], { prefix: t.prefix, create: (n) => loadSchema(n) });
    try {
      await fn(reference.createEngine({ profile, ns, adapters: STUB }), ns, profile);
    } finally {
      await ns.drop();
    }
  }
};
const unitRows = async (ns) => (await ns.present('session_units')).filter((r) => r.unit_key !== '').map((r) => `${r.generation}:${r.unit_key}`).sort();

test('reference engine: a source whose position stays null is read on, not stalled', { skip: !anyTarget && 'no SSQL_CH_URL or SSQL_PG_URL' }, async () => {
  await withEngineNs(async (engine, ns, profile) => {
    await engine.pass([stubRead(null, 'reset', [stubUnit('0', 'a')], null)]);
    await engine.pass([stubRead(null, 'appended', [stubUnit('2', 'b')], null)]);
    assert.deepEqual(await unitRows(ns), ['1:0', '1:2'], profile);
  });
});

test('reference engine: a read from scratch once a cursor exists moves the position, or opens a generation', { skip: !anyTarget && 'no SSQL_CH_URL or SSQL_PG_URL' }, async () => {
  await withEngineNs(async (engine, ns, profile) => {
    await engine.pass([stubRead(null, 'reset', [stubUnit('0', 'a')], { offset: 2 })]);
    await engine.pass([stubRead(null, 'reset', [stubUnit('0', 'a')], { offset: 2 })]);
    assert.deepEqual(await unitRows(ns), ['1:0'], `${profile}: the same units again added nothing`);
    await engine.pass([stubRead(null, 'reset', [stubUnit('0', 'c')], { offset: 2 })]);
    assert.deepEqual(await unitRows(ns), ['1:0', '2:0'], `${profile}: other units opened a generation`);
    await engine.pass([stubRead({ offset: 2 }, 'appended', [stubUnit('2', 'd')], { offset: 4 })]);
    assert.deepEqual(await unitRows(ns), ['1:0', '2:0', '2:2'], `${profile}: the next read follows on`);
  });
});

test('an interrupted run drops the namespaces it opened', { skip: !(haveTargets && process.env.SSQL_CH_URL) && 'no SSQL_CH_URL or no SSQL_ADAPTERS' }, async () => {
  const { ClickHouse } = await import('../lib/ch.mjs');
  const t = readTargets().clickhouse;
  const ch = new ClickHouse(t);
  const ours = async () => (await ch.query("SELECT name FROM system.databases WHERE startsWith(name, 'ssql_conf_')")).map((r) => r.name);
  const before = new Set(await ours());
  const child = spawn(process.execPath, [KIT, '--profile', 'clickhouse', '--only', 'crash-safe'], { env: process.env, stdio: 'ignore' });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  let opened = [];
  for (let i = 0; i < 600 && !opened.length; i++) {
    await new Promise((r) => setTimeout(r, 100));
    opened = (await ours()).filter((n) => !before.has(n));
  }
  assert.ok(opened.length, 'the run opened no namespace to interrupt');
  child.kill('SIGTERM');
  const { code } = await exited;
  assert.equal(code, 143);
  const left = (await ours()).filter((n) => !before.has(n));
  assert.deepEqual(left, [], 'namespaces left behind');
});

test('an interrupt while a namespace is being created leaves no namespace behind', { skip: !(haveTargets && process.env.SSQL_CH_URL) && 'no SSQL_CH_URL or no SSQL_ADAPTERS' }, async () => {
  const http = await import('node:http');
  const { ClickHouse } = await import('../lib/ch.mjs');
  const t = readTargets().clickhouse;
  const ch = new ClickHouse(t);
  const ours = async () => (await ch.query("SELECT name FROM system.databases WHERE startsWith(name, 'ssql_conf_')")).map((r) => r.name);
  const before = new Set(await ours());
  // A proxy in front of the target that holds each CREATE DATABASE for a while before it passes it
  // on, as a busy server would: the statement is in flight when the signal comes, and the server
  // runs it all the same.
  let seen;
  const createSeen = new Promise((r) => { seen = r; });
  const forwarded = [];
  const proxy = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => forwarded.push((async () => {
      const body = Buffer.concat(chunks);
      if (/^CREATE DATABASE ssql_conf_/.test(body.toString('utf8'))) {
        seen();
        await new Promise((r) => setTimeout(r, 1500));
      }
      const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !['host', 'connection', 'content-length'].includes(k)));
      try {
        const up = await fetch(`${t.url}${req.url}`, { method: req.method, headers, body });
        const text = Buffer.from(await up.arrayBuffer());
        res.writeHead(up.status, { 'content-type': up.headers.get('content-type') ?? 'text/plain' });
        res.end(text);
      } catch {
        res.writeHead(502);
        res.end('the proxy could not reach the target');
      }
    })()));
  });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  let left = [];
  let code;
  try {
    const child = spawn(process.execPath, [KIT, '--profile', 'clickhouse', '--only', 'host-form'], { env: { ...process.env, SSQL_CH_URL: `http://127.0.0.1:${proxy.address().port}` }, stdio: 'ignore' });
    const exited = new Promise((resolve) => child.on('exit', (c) => resolve(c)));
    await Promise.race([createSeen, new Promise((_, no) => setTimeout(() => no(new Error('the run sent no CREATE DATABASE')), 60000).unref())]);
    child.kill('SIGTERM');
    code = await exited;
    await Promise.allSettled(forwarded);
  } finally {
    proxy.close();
    left = (await ours()).filter((n) => !before.has(n));
    for (const n of left) await ch.exec(`DROP DATABASE IF EXISTS ${n} SYNC`);
  }
  assert.equal(code, 143);
  assert.deepEqual(left, [], 'a namespace whose CREATE was in flight at the interrupt was left behind');
});

test("reference engine: a session id with a quote and a backslash is bound, not spliced, and read back", { skip: !anyTarget && 'no SSQL_CH_URL or SSQL_PG_URL' }, async () => {
  const sid = "kit's \\ \\' session";
  await withEngineNs(async (engine, ns, profile) => {
    await engine.pass([stubRead(null, 'reset', [stubUnit('0', 'a')], { offset: 2 }, sid)]);
    await engine.pass([stubRead({ offset: 2 }, 'appended', [stubUnit('2', 'b')], { offset: 4 }, sid)]);
    const rows = (await ns.present('session_units')).filter((r) => r.unit_key !== '');
    assert.deepEqual(rows.map((r) => `${r.session_id}|${r.unit_key}`).sort(), [`${sid}|0`, `${sid}|2`], profile);
  });
});


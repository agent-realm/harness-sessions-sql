// The kit's own tests. The first group needs nothing but Node; the last two run the kit and its
// self-test against the targets the environment names, and are skipped without them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { identities, knownAnswerVectors, fullRowVectors, ddlColumns, LEGACY_LINE_EXCLUDES } from '../lib/spec.mjs';
import { jcs, sha256, hostOf } from '../lib/jcs.mjs';
import { ddlStatements, describeTarget, norm } from '../lib/db.mjs';
import { rkOfLive, rkOfRow, recordKey } from '../lib/keys.mjs';
import { DDL_FAULTS } from '../reference/faults.mjs';
import { encodeAdapterVer } from '../reference/rows.mjs';
import { bumpVersion } from '../lib/adapters.mjs';

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
  const only = { 'partition-by-time': ['clickhouse'], 'reorder-columns': ['clickhouse'] };
  for (const [name, fault] of Object.entries(DDL_FAULTS)) {
    for (const profile of only[name] ?? ['clickhouse', 'postgres']) {
      const before = ddlStatements(profile, { qualify: (t) => t }).join(';');
      const after = ddlStatements(profile, { qualify: (t) => t, transforms: [fault] }).join(';');
      assert.notEqual(after, before, `${name} on ${profile}`);
    }
  }
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
  const t = describeTarget('postgres', { url: 'postgres://someone:hunter2@localhost:5432/db' });
  assert.ok(!t.includes('hunter2') && !t.includes('someone'));
  assert.equal(norm('2026-01-02 09:00:06.840'), norm('2026-01-02 09:00:06.84+00'));
  assert.equal(norm(true), 'true');
});

test('adapter_ver: a.b.c encoded as an integer, and the kit bumps the patch', () => {
  assert.equal(encodeAdapterVer('0.2.0'), 2000);
  assert.equal(bumpVersion('0.2.0'), '0.2.1');
  assert.ok(encodeAdapterVer(bumpVersion('1.9.9')) > encodeAdapterVer('1.9.9'));
});

const haveTargets = !!(process.env.SSQL_CH_URL || process.env.SSQL_PG_URL) && !!process.env.SSQL_ADAPTERS;
const kit = (args) => spawnSync(process.execPath, [path.join(HERE, '..', 'run.mjs'), ...args], { encoding: 'utf8', env: process.env, timeout: 30 * 60 * 1000 });

test('the reference engine passes every check on every target', { skip: !haveTargets && 'no SSQL_CH_URL or SSQL_PG_URL, or no SSQL_ADAPTERS', timeout: 30 * 60 * 1000 }, () => {
  const r = kit([]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('self-test: every check fails against each of its faults', { skip: !haveTargets && 'no SSQL_CH_URL or SSQL_PG_URL, or no SSQL_ADAPTERS', timeout: 30 * 60 * 1000 }, () => {
  const r = kit(['--self-test']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

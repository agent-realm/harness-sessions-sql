// The kit's input: envelopes, made by the session adapters from their own synthetic fixtures.
//
// An envelope is one read of one source, as the `sessions` seam delivers it to an engine:
//
//   { store: {host, harness, harness_path}, session: {session_id, incarnation},
//     source_key, role, mode, position_kind,
//     from,                      the position the read started from (null: from scratch)
//     read: {continuity, units, gone, position, held_back} }
//
// or, for a source the harness store no longer has (list omits it), the consumer's decision:
//
//   { store, session, source_key, from, source_gone: true, policy: 'kept' | 'removed' }
//
// A pass is a list of envelopes; a scenario is a list of passes. The kit builds them by copying
// a fixture case to a temporary folder, reading it with the adapter as a consumer would (keeping
// each source's position and `known` between passes, like the package's own minimal engine), and
// changing the copy between passes the way a harness would: a file rewritten through a new inode,
// rows deleted, a line appended. Every envelope is built before any engine sees it, and the
// temporary folders are removed at once: an engine gets the envelopes, never the harness store.
//
// Each fixture this file names is one of the package's synthetic cases. The kit's own synthetic
// rows, for the database checks that need a shape no fixture has, are at the bottom.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { hostOf } from './lib/jcs.mjs';

// Synthetic machine ids, never a real machine's.
export const HOST_A = hostOf('0a0a0a0a0a0a4a0a8a0a0a0a0a0a0a01');
export const HOST_B = hostOf('0b0b0b0b0b0b4b0b8b0b0b0b0b0b0b02');

// ---- fixture stores -------------------------------------------------------------------------

function filesOf(root) {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push(path.relative(root, p));
    }
  };
  walk(root);
  return out.sort();
}

// A database fixture is text: `store-sql/<rel>.schema.sql` and `store-sql/<rel>.ops.jsonl` (one
// statement per line, `{"sql", "params"}`, a blob as `{"$b64"}`).
function sqlFilesOf(caseDir) {
  const root = path.join(caseDir, 'store-sql');
  if (!fs.existsSync(root)) return [];
  return filesOf(root).filter((f) => f.endsWith('.schema.sql')).map((f) => {
    const rel = f.slice(0, -'.schema.sql'.length);
    const opsFile = path.join(root, `${rel}.ops.jsonl`);
    const ops = fs.existsSync(opsFile) ? fs.readFileSync(opsFile, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)) : [];
    return { rel, schema: fs.readFileSync(path.join(root, f), 'utf8'), ops };
  });
}

const param = (v) => (v && typeof v === 'object' && typeof v.$b64 === 'string' ? Buffer.from(v.$b64, 'base64') : v);

export class FixtureStore {
  // `tree`: which folder of the case holds the harness store files (`store`, or `before` for a
  // case that keeps an earlier state beside it). `upto`: build each database from its first
  // `upto` statements only.
  constructor(adapters, harness, caseName, { tree = 'store', upto } = {}) {
    if (!adapters.fixtures) throw new Error('the session-adapters package has no fixtures/ folder');
    this.caseDir = path.join(adapters.fixtures, harness, caseName);
    if (!fs.existsSync(this.caseDir)) throw new Error(`no fixture case ${harness}/${caseName}`);
    this.harness = harness;
    this.dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ssql-kit-')));
    if (fs.existsSync(path.join(this.caseDir, tree))) fs.cpSync(path.join(this.caseDir, tree), this.dir, { recursive: true });
    this.dbs = sqlFilesOf(this.caseDir);
    for (const db of this.dbs) this.buildDb(db, upto ?? db.ops.length);
    const binding = path.join(this.caseDir, 'binding.json');
    this.harnessPath = fs.existsSync(binding) ? path.join(this.dir, JSON.parse(fs.readFileSync(binding, 'utf8')).harness_path) : this.dir;
  }

  // A database built aside and renamed into place, as a harness's own rewrite would be.
  buildDb(db, upto) {
    const file = path.join(this.dir, db.rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.building`;
    for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`]) fs.rmSync(f, { force: true });
    const conn = new DatabaseSync(tmp);
    try {
      conn.exec('PRAGMA synchronous = OFF');
      conn.exec(db.schema);
      conn.exec('BEGIN');
      for (const op of db.ops.slice(0, upto)) conn.prepare(op.sql).run(...(op.params ?? []).map(param));
      conn.exec('COMMIT');
    } finally {
      conn.close();
    }
    for (const f of [`${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true });
    fs.renameSync(tmp, file);
  }

  rebuild(upto) {
    for (const db of this.dbs) this.buildDb(db, upto ?? db.ops.length);
  }

  opsCount() {
    return this.dbs[0]?.ops.length ?? 0;
  }

  // The index of the first statement matching `re`, in the first database.
  opIndex(re) {
    return this.dbs[0].ops.findIndex((op) => re.test(JSON.stringify(op)));
  }

  file(rel) {
    return path.join(this.dir, rel);
  }

  // Replace a file through a new inode (write aside, rename), as a rewriting harness does.
  replaceFile(rel, bytes) {
    const f = this.file(rel);
    fs.writeFileSync(`${f}.rewrite`, bytes);
    fs.renameSync(`${f}.rewrite`, f);
  }

  // Take every file of another tree of the case (`store` after `before`), each through a new inode.
  replaceTree(tree) {
    const root = path.join(this.caseDir, tree);
    for (const rel of filesOf(root)) {
      fs.mkdirSync(path.dirname(this.file(rel)), { recursive: true });
      this.replaceFile(rel, fs.readFileSync(path.join(root, rel)));
    }
  }

  appendFile(rel, bytes) {
    fs.appendFileSync(this.file(rel), bytes);
  }

  deleteFile(rel) {
    fs.rmSync(this.file(rel));
  }

  // Run statements on one of the case's databases in place, as the harness writing to it.
  sql(dbRel, statements) {
    const conn = new DatabaseSync(this.file(dbRel));
    try {
      for (const [sql, params = []] of statements) conn.prepare(sql).run(...params);
    } finally {
      conn.close();
    }
  }

  query(dbRel, sql, params = []) {
    const conn = new DatabaseSync(this.file(dbRel), { readOnly: true });
    try {
      return conn.prepare(sql).all(...params);
    } finally {
      conn.close();
    }
  }

  // Every file under the case's inputs, as text, for a scan (the sentinel check).
  inputText() {
    return filesOf(this.caseDir).map((rel) => fs.readFileSync(path.join(this.caseDir, rel), 'latin1')).join('\n');
  }

  cleanup() {
    fs.rmSync(this.dir, { recursive: true, force: true });
  }
}

// ---- the reader: a consumer's cursor over one harness store -------------------------------------

export class Reader {
  constructor(adapter, store) {
    this.adapter = adapter;
    this.store = store;
    this.cursors = new Map(); // `${session_id}\0${incarnation}\0${source_key}` -> {position, known, session, src}
  }

  // One pass: every listed session (or those `only` accepts), every source, read from its
  // position with its `known`. A source read before and no longer listed gets a `source_gone`
  // envelope with the policy `gonePolicy` gives (a value, or a function of session_id and
  // source_key).
  pass({ only = null, gonePolicy = 'removed' } = {}) {
    const out = [];
    const seen = new Set();
    for (const s of this.adapter.list(this.store)) {
      if (only && !only(s.session_id)) continue;
      const session = { session_id: s.session_id, incarnation: s.incarnation ?? '' };
      const sk = { ...this.store, ...session };
      for (const src of s.sources) {
        const key = `${session.session_id}\u0000${session.incarnation}\u0000${src.source_key}`;
        seen.add(key);
        const cur = this.cursors.get(key) ?? { position: null, known: new Map(), session, src };
        const known = cur.known.size ? Object.fromEntries(cur.known) : null;
        const r = this.adapter.read(this.store, sk, src.source_key, cur.position, known);
        // A capped read says `more`: keep reading from the returned position in the same pass.
        while (r.more) {
          const next = this.adapter.read(this.store, sk, src.source_key, r.position, null);
          r.units = [...r.units, ...next.units];
          r.position = next.position;
          r.held_back = next.held_back;
          r.more = next.more;
          if (r.continuity === 'unchanged' && next.units.length) r.continuity = 'appended';
        }
        out.push({
          store: { ...this.store },
          session,
          source_key: src.source_key,
          role: src.role,
          mode: src.mode,
          position_kind: src.position_kind,
          from: cur.position,
          read: { continuity: r.continuity, units: r.units, gone: r.gone ?? [], position: r.position, held_back: r.held_back ?? [] },
        });
        switch (r.continuity) {
          case 'reset':
          case 'snapshot':
            cur.known = new Map(r.units.map((u) => [u.unit_key, u.sha256]));
            break;
          case 'appended':
          case 'delta':
            for (const u of r.units) cur.known.set(u.unit_key, u.sha256);
            for (const k of r.gone ?? []) cur.known.delete(k);
            break;
          default:
            break;
        }
        cur.position = r.position;
        this.cursors.set(key, cur);
      }
    }
    for (const [key, cur] of [...this.cursors]) {
      if (seen.has(key) || (only && !only(cur.session.session_id))) continue;
      const policy = typeof gonePolicy === 'function' ? gonePolicy(cur.session.session_id, cur.src.source_key) : gonePolicy;
      out.push({ store: { ...this.store }, session: cur.session, source_key: cur.src.source_key, role: cur.src.role, mode: cur.src.mode, position_kind: cur.src.position_kind, from: cur.position, source_gone: true, policy });
      this.cursors.delete(key);
    }
    return out;
  }
}

const storeOf = (fx, host) => ({ host, harness: fx.harness, harness_path: fx.harnessPath });

// Run `fn(fx)` over a fixture copy and remove the copy afterwards, whatever happens.
function withFixture(adapters, harness, caseName, opts, fn) {
  const fx = new FixtureStore(adapters, harness, caseName, opts);
  try {
    return fn(fx);
  } finally {
    fx.cleanup();
  }
}

// One pass over each of several cases, merged.
function onePass(adapters, cases, host = HOST_A) {
  const pass = [];
  for (const [harness, caseName] of cases) {
    withFixture(adapters, harness, caseName, {}, (fx) => {
      pass.push(...new Reader(adapters.adapterFor(harness), storeOf(fx, host)).pass());
    });
  }
  return [pass];
}

// Zip several multi-pass sequences into one: pass i holds every sequence's pass i.
function zipPasses(...seqs) {
  const n = Math.max(...seqs.map((s) => s.length));
  return Array.from({ length: n }, (_, i) => seqs.flatMap((s) => s[i] ?? []));
}

// ---- scenarios --------------------------------------------------------------------------------

// A broad single pass: links, lifecycle, a zero-part message, null ts, parts with their own
// source and state, many null counters.
export const BROAD_CASES = [
  ['claude-code', 'basic'],
  ['codex', 'features'],
  ['opencode', 'features'],
  ['opencode', 'edits'],
  ['gemini-cli', 'features'],
  ['goose', 'features'],
  ['copilot-cli', 'features'],
  ['zed', 'features'],
];

export function broad(adapters) {
  return { name: 'broad', passes: onePass(adapters, BROAD_CASES) };
}

// A session before and after a rewind, three ways:
// - Copilot CLI: events.jsonl rewritten shorter through a new inode (reset), plus the appended
//   session.info{rewind} (copilot-cli/rewind: before/, then store/);
// - OpenCode: a revert, then a prompt while reverted deletes the reverted rows (opencode/edits,
//   built up to the revert, then whole);
// - Gemini CLI: the append-only `$rewindTo` retraction (gemini-cli/features, each chat file cut
//   before its first `$rewindTo` line, then whole).
export function rewind(adapters) {
  const copilot = withFixture(adapters, 'copilot-cli', 'rewind', { tree: 'before' }, (fx) => {
    const r = new Reader(adapters.adapterFor('copilot-cli'), storeOf(fx, HOST_A));
    const p1 = r.pass();
    fx.replaceTree('store');
    return [p1, r.pass()];
  });
  const opencode = withFixture(adapters, 'opencode', 'edits', {}, (fx) => {
    const cut = fx.opIndex(/UPDATE session SET revert = \?.*"messageID/);
    if (cut <= 0) throw new Error('opencode/edits: no revert statement found');
    fx.rebuild(cut);
    const r = new Reader(adapters.adapterFor('opencode'), storeOf(fx, HOST_A));
    const p1 = r.pass();
    fx.rebuild();
    return [p1, r.pass()];
  });
  const gemini = withFixture(adapters, 'gemini-cli', 'features', {}, (fx) => {
    const whole = new Map();
    for (const rel of filesOf(fx.dir)) {
      const text = fs.readFileSync(fx.file(rel), 'utf8');
      if (!text.includes('"$rewindTo"')) continue;
      whole.set(rel, text);
      const lines = text.split('\n');
      const i = lines.findIndex((l) => l.includes('"$rewindTo"'));
      fx.replaceFile(rel, lines.slice(0, i).join('\n') + '\n');
    }
    if (!whole.size) throw new Error('gemini-cli/features: no $rewindTo line found');
    const r = new Reader(adapters.adapterFor('gemini-cli'), storeOf(fx, HOST_A));
    const p1 = r.pass();
    for (const [rel, text] of whole) fx.appendFile(rel, text.slice(fs.readFileSync(fx.file(rel), 'utf8').length));
    return [p1, r.pass()];
  });
  return { name: 'rewind', passes: zipPasses(copilot, opencode, gemini) };
}

// The OpenCode child/task pair (opencode/features): the child states its origin (`at: ''`) and
// the parent's `task` call states the child, so an engine merges one edge, `stated_on: both`.
// Pass 2 re-derives the child alone (its title changes). Pass 3 removes both statements: the
// child's parent_id is cleared and the parent's task part deleted.
export const EDGE_PAIR = { child: 'ses_15e9c81a20016kUmgT3Q5hrPYH', origin: 'ses_15e9c75ea001aF3AjM15syNKQ3', at: '01M5FA14606SC8K5NP9K6CTMED' };

export function edges(adapters) {
  const passes = withFixture(adapters, 'opencode', 'features', {}, (fx) => {
    const db = path.relative(fx.dir, fx.harnessPath);
    const r = new Reader(adapters.adapterFor('opencode'), storeOf(fx, HOST_A));
    const p1 = r.pass();
    fx.sql(db, [["UPDATE session SET title = title || ' (renamed)', time_updated = time_updated + 1 WHERE id = ?", [EDGE_PAIR.child]]]);
    const p2 = r.pass({ only: (sid) => sid === EDGE_PAIR.child });
    const task = fx.query(db, "SELECT id FROM part WHERE session_id = ? AND data LIKE '%\"tool\":\"task\"%'", [EDGE_PAIR.origin]);
    if (task.length !== 1) throw new Error(`opencode/features: expected one task part, found ${task.length}`);
    fx.sql(db, [
      ['UPDATE session SET parent_id = NULL, time_updated = time_updated + 1 WHERE id = ?', [EDGE_PAIR.child]],
      ['DELETE FROM part WHERE id = ?', [task[0].id]],
    ]);
    const p3 = r.pass({ only: (sid) => sid === EDGE_PAIR.child || sid === EDGE_PAIR.origin });
    return [p1, p2, p3];
  });
  return { name: 'edges', passes, pair: EDGE_PAIR };
}

// The four absences of spec §4.1, each in its own sessions, in pass 2:
// - reset: a still-listed source reset to empty (a Claude Code main file rewritten empty);
// - kept / removed: a vanished source, handled as "kept" and as "removed" (two Codex rollout
//   files deleted, so list omits their sessions);
// - gone: a delta read's gone keys (an OpenCode message row and its parts deleted).
export function absences(adapters) {
  const meta = {};
  const cc = withFixture(adapters, 'claude-code', 'basic', {}, (fx) => {
    const r = new Reader(adapters.adapterFor('claude-code'), storeOf(fx, HOST_A));
    const p1 = r.pass();
    const main = p1.find((e) => e.role === 'main');
    meta.reset = { session_id: main.session.session_id, source_key: main.source_key };
    fx.replaceFile(main.source_key, '');
    return [p1, r.pass()];
  });
  const codex = withFixture(adapters, 'codex', 'features', {}, (fx) => {
    const r = new Reader(adapters.adapterFor('codex'), storeOf(fx, HOST_A));
    const p1 = r.pass();
    const sessions = [...new Map(p1.map((e) => [e.session.session_id, e])).values()];
    if (sessions.length < 2) throw new Error('codex/features: fewer than two sessions');
    const [kept, removed] = sessions;
    meta.kept = { session_id: kept.session.session_id };
    meta.removed = { session_id: removed.session.session_id };
    for (const e of p1) if (e.session.session_id === kept.session.session_id || e.session.session_id === removed.session.session_id) fx.deleteFile(e.source_key);
    return [p1, r.pass({ gonePolicy: (sid) => (sid === kept.session.session_id ? 'kept' : 'removed') })];
  });
  const oc = withFixture(adapters, 'opencode', 'features', {}, (fx) => {
    const db = path.relative(fx.dir, fx.harnessPath);
    const r = new Reader(adapters.adapterFor('opencode'), storeOf(fx, HOST_A));
    const p1 = r.pass();
    // The last message of the parent of the edge pair: a delta read reports it gone.
    const msg = fx.query(db, 'SELECT id FROM message WHERE session_id = ? ORDER BY time_created DESC, id DESC LIMIT 1', [EDGE_PAIR.origin]);
    meta.gone = { session_id: EDGE_PAIR.origin, message_id: msg[0].id };
    fx.sql(db, [['DELETE FROM part WHERE message_id = ?', [msg[0].id]], ['DELETE FROM message WHERE id = ?', [msg[0].id]]]);
    return [p1, r.pass()];
  });
  return { name: 'absences', passes: zipPasses(cc, codex, oc), meta };
}

// No-op reads: pass 2 and pass 4 change nothing (every read `unchanged`); pass 3 appends a line
// (Claude Code re-appends records verbatim, sessions-model §1 rule 5).
export function noop(adapters) {
  const passes = withFixture(adapters, 'claude-code', 'basic', {}, (fx) => {
    const r = new Reader(adapters.adapterFor('claude-code'), storeOf(fx, HOST_A));
    const p1 = r.pass();
    const p2 = r.pass();
    const main = p1.find((e) => e.role === 'main');
    const lines = fs.readFileSync(fx.file(main.source_key), 'utf8').split('\n').filter(Boolean);
    fx.appendFile(main.source_key, `${lines.at(-1)}\n`);
    return [p1, p2, r.pass(), r.pass()];
  });
  return { name: 'noop', passes };
}

// A partial last line: pass 1 reads the main file with its last line cut in half (held back),
// pass 2 reads it whole.
export function partial(adapters) {
  const passes = withFixture(adapters, 'claude-code', 'basic', {}, (fx) => {
    const r = new Reader(adapters.adapterFor('claude-code'), storeOf(fx, HOST_A));
    const files = filesOf(fx.dir).filter((f) => f.endsWith('.jsonl') && !f.includes('/subagents/'));
    const rel = files[0];
    const whole = fs.readFileSync(fx.file(rel));
    const lastStart = whole.subarray(0, whole.length - 1).lastIndexOf(0x0a) + 1;
    fx.replaceFile(rel, whole.subarray(0, lastStart + Math.floor((whole.length - lastStart) / 2)));
    const p1 = r.pass();
    fx.appendFile(rel, whole.subarray(fs.statSync(fx.file(rel)).size));
    return [p1, r.pass()];
  });
  return { name: 'partial', passes };
}

// One harness store read under two hosts: a data folder copied to a second machine.
export function twoHosts(adapters) {
  const pass = [];
  for (const [harness, caseName] of [['claude-code', 'basic'], ['opencode', 'features']]) {
    withFixture(adapters, harness, caseName, {}, (fx) => {
      for (const host of [HOST_A, HOST_B]) pass.push(...new Reader(adapters.adapterFor(harness), storeOf(fx, host)).pass());
    });
  }
  return { name: 'two-hosts', passes: [pass], hosts: [HOST_A, HOST_B] };
}

// The sentinel-secret fixtures. Each plants a fake secret on declared redaction paths and the
// same or another fake value in free text, which no path covers (sessions-model §4 rule 6). The
// kit finds the planted values by their fixture spelling.
export const SENTINEL_CASES = [['goose', 'conformance-goose-sentinel'], ['zed', 'sentinel'], ['opencode', 'sentinel']];
const SENTINEL_RE = /sentinel-[0-9a-z]+-not-a-secret|OCSENTINEL-[A-Za-z0-9-]+/g;

export function sentinels(adapters) {
  const pass = [];
  const values = new Set();
  for (const [harness, caseName] of SENTINEL_CASES) {
    withFixture(adapters, harness, caseName, {}, (fx) => {
      for (const m of fx.inputText().matchAll(SENTINEL_RE)) values.add(m[0]);
      pass.push(...new Reader(adapters.adapterFor(harness), storeOf(fx, HOST_A)).pass());
    });
  }
  return { name: 'sentinels', passes: [pass], sentinels: [...values] };
}

// The zero-part assistant message of opencode/edits (an assistant row with no parts).
export function zeroPart(adapters) {
  return { name: 'zero-part', passes: onePass(adapters, [['opencode', 'edits']]) };
}

// Messages with a null `ts` (Zed keeps none: ts_source `none`).
export function nullTs(adapters) {
  return { name: 'null-ts', passes: onePass(adapters, [['zed', 'features']]) };
}

// ---- the kit's own synthetic rows (database checks) -------------------------------------------

// A minimal valid row per table, for the database checks that write SQL directly. Every value is
// synthetic; `host` is a host/v0 form of a synthetic machine id.
const SHA = (c) => c.repeat(64);
export function syntheticRows({ host = HOST_A, harness = 'kit-harness', ts_source = 'event', enc = 'utf8', adapter = 'kit-adapter' } = {}) {
  const S = { host, harness, harness_path: '/home/user/.kit', session_id: 'kit-session-1', incarnation: '' };
  const common = { adapter, adapter_ver: 1, model_version: 'sessions-model/1', rev: 1 };
  return {
    session_units: { ...S, source_key: 'kit.jsonl', generation: 1, unit_key: '0', chunk: 0, sha256: SHA('a'), enc, redacted: false, continuity: 'reset', raw: '{"kit":1}', adapter, adapter_ver: 1 },
    sessions: { ...S, state: 'active', reuse: 'impossible', ts_source, aliases: [], fingerprint: [], content_sha: SHA('b'), ...common },
    session_parts: { ...S, message_id: 'm-1', part_id: '0', part_index: 0, order_key: '1', role: 'assistant', status: 'complete', state: 'current', message_aliases: [], cmp_sha: SHA('c'), message_content_sha: SHA('d'), kind: 'text', text: 'synthetic', content_sha: SHA('e'), ...common },
    session_usage: { ...S, usage_id: 'message:m-1#1', anchor_kind: 'message', anchor_id: 'm-1', granularity: 'per_message', content_sha: SHA('f'), ...common },
    session_links: { ...S, owner: 'adapter', kind: 'fork', other_harness: harness, other_session_id: 'kit-session-0', stated_on: 'child', child_harness: harness, child_session_id: 'kit-session-1', origin_harness: harness, origin_session_id: 'kit-session-0', statements: [], content_sha: SHA('0'), ...common },
    session_lifecycle: { ...S, lifecycle_id: 'kit.jsonl@0#1', op: 'rewind', target_kind: 'session', content_sha: SHA('1'), ...common },
  };
}

// Example 06: turns, and a native field read through its units (v1.1). A consumer reads one
// synthetic Claude Code store (a fixture case of the harness-session-adapters package) through the real
// adapter; the reference engine writes it; the example loads the reading view of §6
// (schema/<profile>-views.sql), reads the session's turns through it, and follows one message's
// `native` field back to the raw line it came from, through the message's `units` (§4.3) and the
// archive (§4.1). It then times the view: an indicative time on standard error, never part of the
// checked output. See README.md.

import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { runExample, Skip, inNamespace, table } from '../lib/example.mjs';
import { loadAdapters } from '../../conformance/lib/adapters.mjs';
import { FixtureStore, Reader, HOST_A } from '../../conformance/envelopes.mjs';
import { createEngine } from '../../conformance/reference/engine.mjs';
import { jcs } from '../../conformance/lib/jcs.mjs';
import { chString } from '../../conformance/lib/ch.mjs';
import { pgString } from '../../conformance/lib/pg.mjs';

const SCHEMA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'schema');
const HARNESS = 'claude-code';
const CASE = 'features';
const SESSION = '0f5e1c2a-7b3d-4e8f-a9c1-2d3e4f5a6b7c';

async function sessionAdapters() {
  const { source, error } = await loadAdapters();
  if (!source) throw new Skip(error);
  if (!source.fixtures) throw new Skip('SSQL_ADAPTERS names a harness-session-adapters package with no fixtures/ folder (a published package ships none): name a checkout of it');
  return source;
}

// One pass over the store, read before any database work.
function readPass(adapters) {
  const fx = new FixtureStore(adapters, HARNESS, CASE);
  try {
    return new Reader(adapters.adapterFor(HARNESS), { host: HOST_A, harness: HARNESS, harness_path: fx.harnessPath }).pass();
  } finally {
    fx.cleanup();
  }
}

// The reading view (ClickHouse) or function (PostgreSQL), as one statement: the namespace holds the
// tables under their logical names, so the file loads as it would in clickhouse-client or psql.
async function loadViews(db, profile) {
  const text = fs.readFileSync(path.join(SCHEMA, `${profile}-views.sql`), 'utf8');
  const sql = text.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n').trim().replace(/;\s*$/, '');
  await db.exec(sql);
}

// A string literal of the profile's SQL.
const literal = (profile) => (profile === 'clickhouse' ? chString : pgString);
function turnsSql(profile, k) {
  const lit = literal(profile);
  return profile === 'clickhouse'
    ? `SELECT * FROM session_turns(host = ${lit(k.host)}, harness = ${lit(k.harness)}, harness_path = ${lit(k.harness_path)}, session_id = ${lit(k.session_id)}, incarnation = ${lit(k.incarnation)})`
    : `SELECT * FROM session_turns(${lit(k.host)}, ${lit(k.harness)}, ${lit(k.harness_path)}, ${lit(k.session_id)}, ${lit(k.incarnation)})`;
}

// One message's units, read back from the archive (§6): its `message_units` triples, each joined
// to the unit rows of the same session. A source that appends keeps one version of each unit; a
// snapshot or delta source may keep several of one triple, and a reader takes the latest archived
// version at or before the record's revision (sessions-model §2.7). This one appends.
function unitsSql(profile, k, messageId) {
  const lit = literal(profile);
  if (profile === 'clickhouse') {
    const key = `host = ${lit(k.host)} AND harness = ${lit(k.harness)} AND harness_path = ${lit(k.harness_path)} AND session_id = ${lit(k.session_id)} AND incarnation = ${lit(k.incarnation)}`;
    return `SELECT m.source_key AS source_key, m.generation AS generation, m.unit_key AS unit_key,
                   u.chunk AS chunk, u.enc AS enc, u.continuity AS continuity, u.raw AS raw
            FROM (SELECT DISTINCT tupleElement(t, 'source_key') AS source_key, tupleElement(t, 'generation') AS generation,
                                  tupleElement(t, 'unit_key') AS unit_key
                  FROM session_parts FINAL ARRAY JOIN message_units AS t
                  WHERE ${key} AND message_id = ${lit(messageId)} AND is_deleted = 0 AND removed = 0) AS m
            LEFT JOIN (SELECT * FROM session_units FINAL WHERE ${key}) AS u
              ON u.source_key = m.source_key AND u.generation = m.generation AND u.unit_key = m.unit_key
            ORDER BY source_key, generation, unit_key, chunk`;
  }
  const key = (a) => `${a}host = ${lit(k.host)} AND ${a}harness = ${lit(k.harness)} AND ${a}harness_path = ${lit(k.harness_path)} AND ${a}session_id = ${lit(k.session_id)} AND ${a}incarnation = ${lit(k.incarnation)}`;
  return `SELECT m.source_key, m.generation, m.unit_key, u.chunk, u.enc, u.continuity, u.raw
          FROM (SELECT DISTINCT t->>'source_key' AS source_key, (t->>'generation')::integer AS generation, t->>'unit_key' AS unit_key
                FROM session_parts AS p, jsonb_array_elements(p.message_units) AS t
                WHERE ${key('p.')} AND p.message_id = ${lit(messageId)} AND NOT p.is_deleted AND p.removed = 0) AS m
          LEFT JOIN session_units AS u
            ON ${key('u.')} AND u.source_key = m.source_key AND u.generation = m.generation AND u.unit_key = m.unit_key
          ORDER BY m.source_key, m.generation, m.unit_key, u.chunk`;
}

// A JSON column as an object: ClickHouse's canonical text, PostgreSQL's jsonb (which orders keys
// its own way, so the example prints canonical JSON).
const asObject = (v) => (v === null || v === undefined || v === '' ? null : typeof v === 'string' ? JSON.parse(v) : v);

await runExample({
  sessionAdapters: true,
  async run({ profile, target, namespace }) {
    const adapters = await sessionAdapters();
    const pass = readPass(adapters);
    console.log(`one pass: ${pass.length} read(s) of ${HARNESS}/${CASE}`);
    const ns = await namespace();
    await createEngine({ profile, ns, adapters }).pass(pass);
    const db = inNamespace(ns, target);
    try {
      await loadViews(db, profile);
      const [s] = (await ns.current('sessions')).filter((r) => r.session_id === SESSION);
      const k = { host: s.host, harness: s.harness, harness_path: s.harness_path, session_id: s.session_id, incarnation: s.incarnation ?? '' };

      // §6: the session's turns. Turn 0's prompt is '' in ClickHouse and null in PostgreSQL; both
      // print as NULL here.
      const turns = (await db.query(turnsSql(profile, k))).map((t) => ({ ...t, prompt_message_id: t.prompt_message_id || null }));
      console.log(`session ${SESSION}, its turns (session_turns, §6):`);
      console.log(table(turns, { columns: ['turn', 'prompt_message_id', 'started_at', 'ended_at', 'messages', 'tool_calls', 'tool_errors', 'served_models'] }));

      // §4.3 and §4.1: a native field, and the raw line it came from. The message whose response
      // stopped for a tool call; its `message_units` name the line; a LEFT JOIN reads the line from
      // the archive (a triple of a source removed under the `removed` policy names nothing, §6).
      const parts = (await ns.current('session_parts')).filter((r) => r.session_id === SESSION);
      const msg = parts.find((r) => asObject(r.message_native)?.['message.stop_reason'] === 'tool_use');
      console.log(`message ${msg.message_id}:`);
      console.log(`  message_native: ${jcs(asObject(msg.message_native))}`);
      const units = await db.query(unitsSql(profile, k, msg.message_id));
      for (const u of units) console.log(`  message_units: [${u.source_key}, ${u.generation}, ${u.unit_key}], chunk ${u.chunk}, enc ${u.enc}, continuity ${u.continuity}`);
      const raw = units.map((u) => u.raw).join('');
      const line = JSON.parse(units[0].enc === 'b64' ? Buffer.from(raw, 'base64').toString('utf8') : raw);
      console.log(`  the raw line: message.stop_reason ${line.message.stop_reason}, userType ${line.userType}`);

      // The view, timed: indicative only (a shared runner, a fixture-sized session), on stderr.
      const runs = [];
      for (let i = 0; i < 20; i++) {
        const t0 = performance.now();
        await db.query(turnsSql(profile, k));
        runs.push(performance.now() - t0);
      }
      runs.sort((a, b) => a - b);
      process.stderr.write(`indicative: session_turns on ${profile}, ${parts.length} part rows, median of 20 reads ${runs[10].toFixed(1)} ms\n`);
    } finally {
      await db.close();
    }
  },
});

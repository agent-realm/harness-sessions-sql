// The reference engine: spec §5's write protocol, for both database profiles. It is what the
// engine checks run when SSQL_ENGINE names no other engine, the second profile the parity check
// needs, and an example to read. It favours plain over fast:
//
// - Every pass re-derives each session it touches in full, from empty state over the current
//   units of every source (sessions §2: the full replay). It keeps no derive state, so a crash
//   loses nothing that the archive and the cursor do not hold.
// - It writes removed versions (principle 3), never tombstones.
// - It recomputes every edge after each pass, over the statements the database holds.
// - Its cursor (session_sources, informative) keeps each source's position, generation, pass
//   counter (`progress`) and current unit list. A read whose `from` is not the cursor's position
//   is stale (a re-delivery, or a read superseded by a later one) and is ignored, except a read
//   from scratch (`from` null): a consumer that starts over. When it delivers exactly the units
//   the source holds, it only moves the position; otherwise it opens a generation. A null
//   position and a null `from` are the same position (SPEC-QUESTIONS.md).
// - `progress` counts the passes that touched a session, so the manifests of one pass share it,
//   and replay folds them back pass by pass.
// - `rev` is one more than the highest `rev` of the session's rows, per pass (spec §7 leaves the
//   derivation to the engine; it requires only that `rev` never goes backwards).
// - A pass that crashed after its archive write leaves manifests the cursor never committed (at a
//   progress above the cursor's). When the re-run of a source reads something else from the same
//   position, its read opens a generation of its own, holding the whole source as that read
//   leaves it, so a replay never folds the crashed read and the re-run together (SPEC-QUESTIONS.md).
//
// Fault flags (`faults`) break one behaviour each. The kit's self-test runs every check against
// its fault, which must make it fail: the checks' positive controls. They exist for that only.

import { rowsOf, edgesOf, IDENTITY, JSON_COLUMNS, rowKey, encodeAdapterVer } from './rows.mjs';
import { jcs, jcsSha, sha256 } from '../lib/jcs.mjs';
import { unitFromArchive } from '../lib/adapters.mjs';
import { loadSchema } from '../lib/db.mjs';
import { DDL_FAULTS } from './faults.mjs';
import { SESSION_KEY, ENTITY_TABLES, sessionKeyOf, sessionKeyObject, rkOfRecord, rkOfRow, rksOf } from '../lib/keys.mjs';

export const name = 'sessions-sql reference engine';
export const version = '0.1.0';

// Engine faults (see reference/faults.mjs for what each breaks).
export const ENGINE_FAULTS = new Set([
  'regenerate', 'cursor-early', 'skip-removed', 'delete-removed', 'edges-from-pass', 'drop-empty', 'fill-ts',
  'archive-held-back', 'host-merge', 'no-manifest', 'ignore-policy', 'replay-last-manifest', 'rederive-keep-stale',
  'zero-nulls', 'unredact', 'pg-skew', 'sql-tsv-no-trim', 'policy-kept-as-removed', 'private-manifest',
  'ignore-crash', 'no-rerun-bump', 'part-sha-no-nulls', 'chunk-drop', 'pg-partial-upsert',
  'removed-rewrite', 'edge-needs-all', 'unredact-b64', 'host-merge-messages', 'fill-ts-lifecycle',
]);

export function createEngine(opts) {
  return new ReferenceEngine(opts);
}

// The engine's DDL hook: the reference's tables are this repository's schema/, under the
// namespace's physical names. `faults` names DDL faults (reference/faults.mjs): the self-test's
// faulty implementation DDL, supplied through this hook as any engine's would be.
export async function createTables({ ns, faults = [] }) {
  await loadSchema(ns, { transforms: faults.map((f) => {
    if (!DDL_FAULTS[f]) throw new Error(`unknown DDL fault ${f}`);
    return DDL_FAULTS[f];
  }) });
}

const SEP = '\u0000';
const unitKey = (sourceKey, uk, sha) => `${sourceKey}${SEP}${uk}${SEP}${sha}`;
const bySourceKey = ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0);
const num = (v) => Number(v ?? 0);

class ReferenceEngine {
  // `chunkBytes`, the reference's own option: store a unit whose raw is longer than that many
  // bytes in several chunks (§4.1 `chunk`), its raw split at character boundaries; 0, the
  // default, keeps every unit in one.
  constructor({ profile, ns, adapters, faults = [], faultData = {}, chunkBytes = 0 }) {
    this.profile = profile;
    this.ns = ns;
    this.adapters = adapters;
    this.faults = new Set(faults);
    for (const f of this.faults) if (!ENGINE_FAULTS.has(f)) throw new Error(`unknown engine fault ${f}`);
    this.faultData = faultData;
    this.name = name;
    this.version = version;
    this.removal = 'removed';
    this.crashPoints = ['archive', 'entities', 'removed', 'edges'];
    // Fault `chunk-drop`: chunked units lose their last chunk in the archive; the engine derives
    // from the reads it holds in memory, so only the archive is wrong.
    this.chunkBytes = this.faults.has('chunk-drop') ? (chunkBytes || 256) : chunkBytes;
    this.memo = new Map();
  }

  // ---- the pass (spec §5) ---------------------------------------------------------------------

  async pass(envelopes, { crashAfter } = {}) {
    const F = this.faults;
    // Fault `ignore-crash`: the engine runs every pass to its end, whatever the kit asks (and writes
    // no manifest for a read that changes nothing in the fold, which an engine may omit, so a pass
    // run twice leaves no trace of its second run).
    if (F.has('ignore-crash')) crashAfter = undefined;
    const groups = new Map();
    for (const e of envelopes) {
      const S = sessionKeyObject(e.store, e.session);
      const sk = sessionKeyOf(S);
      if (!groups.has(sk)) groups.set(sk, { S, store: e.store, envs: [] });
      groups.get(sk).envs.push(e);
    }
    if (!groups.size) return {};
    const list = [...groups.values()].map((g) => g.S);
    const cursors = await this.loadCursors(list);
    const archived = await this.present('session_units', this.sessionsWhere(list));
    const bodies = bodiesOf(archived);
    if (F.has('chunk-drop')) for (const [k, u] of this.memo) bodies.set(k, u);

    // 1. Archive: every unit the reads delivered, and each read's manifest (§4.1).
    const work = [];
    const archive = [];
    for (const [sk, g] of groups) {
      const cur = cursors.get(sk) ?? new Map();
      const progress = 1 + Math.max(0, ...[...cur.values()].map((c) => c.progress));
      const orphans = orphansOf(archived, sk, progress);
      const sources = new Map(cur);
      const delivered = new Map();
      const read = new Set();
      let applied = 0;
      for (const e of g.envs) {
        const c = sources.get(e.source_key);
        const from = positionOf(e.from);
        let restart = false;
        if (c && from !== c.position) {
          if (from === '' && !e.source_gone) {
            // A read from scratch once a cursor exists: a consumer that starts over. The same
            // units the source holds move only the position (a repeat adds nothing); other units
            // open a generation.
            if (sameUnits(e.read.units, c.units) && !(e.read.gone ?? []).length) {
              sources.set(e.source_key, { ...c, position: positionOf(e.read.position), progress });
              read.add(e.source_key);
              applied++;
              continue;
            }
            restart = true;
          } else if (!F.has('regenerate')) continue;
        }
        const meta = this.adapters.describe(e.store.harness);
        const f = this.fold(g.S, c, e, progress, { restart });
        // A read that changes nothing in the fold (§4.1 lets an engine omit its manifest).
        const held = new Map(c?.units ?? []);
        const noop = !f.opens && !e.source_gone && f.units.every((u) => held.get(u.unit_key) === u.sha256) && (e.read.gone ?? []).every((k) => !held.has(k));
        let rows = this.rowsOfRead(g.S, e, meta, f.state.generation, f.units, F.has('ignore-crash') && noop ? null : f.manifest);
        const o = orphans.get(e.source_key);
        const manifestRow = rows.find((r) => r.unit_key === '');
        if (o && !F.has('no-rerun-bump') && !o.manifests.some((m) => m.generation === f.state.generation && m.sha256 === manifestRow?.sha256)) {
          // A crashed pass archived a read of this source that the cursor never committed, and this
          // re-run reads something else: the read opens a generation of its own, which holds the
          // whole source as the read leaves it.
          const generation = Math.max(o.generation, f.state.generation) + 1;
          if (f.opens) rows = this.rowsOfRead(g.S, e, meta, generation, f.units, f.manifest);
          else {
            const units = f.state.units.map(([uk, sha]) => {
              const u = f.units.find((x) => x.unit_key === uk && x.sha256 === sha) ?? bodies.get(`${sk}${SEP}${unitKey(e.source_key, uk, sha)}`);
              if (!u) throw new Error(`reference engine: unit ${e.source_key}@${uk} is not in the archive`);
              return u;
            });
            rows = this.rowsOfRead(g.S, e, meta, generation, units, { progress, continuity: 'reset', units: f.state.units, gone: [], source_gone: false });
          }
          f.state.generation = generation;
        }
        sources.set(e.source_key, f.state);
        read.add(e.source_key);
        for (const u of f.units) {
          delivered.set(unitKey(e.source_key, u.unit_key, u.sha256), u);
          if (F.has('chunk-drop')) this.memo.set(`${sk}${SEP}${unitKey(e.source_key, u.unit_key, u.sha256)}`, u);
        }
        archive.push(...rows);
        applied++;
      }
      // A source the crashed pass read and this pass does not: its committed units again, in a
      // generation of their own, so the uncommitted read is not current in a replay.
      if (applied && !F.has('no-rerun-bump')) {
        for (const [sourceKey, o] of orphans) {
          const c = sources.get(sourceKey);
          if (read.has(sourceKey) || !c || c.gone) continue;
          const meta = this.adapters.describe(g.S.harness);
          const units = c.units.map(([uk, sha]) => bodies.get(`${sk}${SEP}${unitKey(sourceKey, uk, sha)}`));
          if (units.some((u) => !u)) continue;
          const generation = o.generation + 1;
          archive.push(...this.rowsOfRead(g.S, { source_key: sourceKey }, meta, generation, units, { progress, continuity: 'reset', units: c.units, gone: [], source_gone: false }));
          sources.set(sourceKey, { ...c, generation, progress });
        }
      }
      if (applied) work.push({ sk, S: g.S, store: g.store, sources, progress, delivered });
    }
    if (!work.length) return {};
    await this.write('session_units', archive);
    if (F.has('cursor-early')) await this.writeCursors(work);
    if (crashAfter === 'archive') return { crashed: 'archive' };

    // 2. Derive each touched session in full.
    for (const w of work) {
      for (const [k, u] of w.delivered) bodies.set(`${w.sk}${SEP}${k}`, u);
      this.derive(w, bodies);
    }
    if (F.has('host-merge')) await this.mergeHosts(work);
    if (F.has('host-merge-messages')) await this.mergeHosts(work, { sessionsToo: false });

    // 3. Upsert what changed at the pass's rev, then removed versions of keys absent from live
    //    and held.
    const existing = await this.loadEntities(work.map((w) => w.S));
    const clocks = await this.loadClocks();
    const changed = [];
    const removed = [];
    for (const w of work) {
      const rev = (clocks.get(w.sk) ?? 0) + 1;
      clocks.set(w.sk, rev);
      const plan = this.planSession(w.S, existing.get(w.sk) ?? new Map(), w.final, rev, w.meta);
      changed.push(...plan.writes);
      removed.push(...plan.removed);
    }
    await this.writeVersions(changed);
    if (crashAfter === 'entities') return { crashed: 'entities' };
    if (F.has('delete-removed')) await this.deleteRows(removed);
    else if (!F.has('skip-removed')) await this.writeVersions(removed);
    if (crashAfter === 'removed') return { crashed: 'removed' };

    // 4. Edges.
    await this.recomputeEdges(clocks, F.has('edges-from-pass') ? work : null);
    if (crashAfter === 'edges') return { crashed: 'edges' };

    // 5. The cursor.
    if (!F.has('cursor-early')) await this.writeCursors(work);
    return {};
  }

  // One envelope folded into its source's state: { state, manifest, units (the units it
  // delivered), opens (whether it opens a generation) }.
  fold(S, c, e, progress, { restart = false } = {}) {
    const F = this.faults;
    let state;
    let manifest;
    let units = [];
    let opens = true;
    if (e.source_gone) {
      const generation = (c?.generation ?? 0) + 1;
      // Fault `policy-kept-as-removed`: a vanished source the consumer keeps is removed, live and
      // in the manifest alike, so a replay agrees with the live state and both are wrong.
      const policy = F.has('policy-kept-as-removed') ? 'removed' : e.policy;
      state = { generation, units: policy === 'kept' ? (c?.units ?? []) : [], gone: true, policy, position: '', mode: c?.mode ?? e.mode ?? '', progress };
      // A vanished source opens a generation with no read: its manifest's continuity is `reset`.
      manifest = { progress, continuity: 'reset', units: [], gone: [], source_gone: true, policy };
    } else {
      const r = e.read;
      opens = restart || !c || c.gone || r.continuity === 'reset' || r.continuity === 'snapshot';
      units = r.units;
      let list;
      let generation;
      if (opens) {
        generation = (c?.generation ?? 0) + 1;
        list = r.units.map((u) => [u.unit_key, u.sha256]);
      } else {
        generation = c.generation;
        const m = new Map(c.units);
        for (const u of r.units) m.set(u.unit_key, u.sha256);
        for (const k of r.gone ?? []) m.delete(k);
        list = [...m];
      }
      state = { generation, units: list, gone: false, position: positionOf(r.position), mode: e.mode ?? '', progress };
      manifest = { progress, continuity: r.continuity, units: r.units.map((u) => [u.unit_key, u.sha256]), gone: r.gone ?? [], source_gone: false };
    }
    return { state, manifest, units, opens };
  }

  // The archive rows of one read in `generation`: its units, then its manifest (none when
  // `manifest` is null).
  rowsOfRead(S, e, meta, generation, units, manifest) {
    const F = this.faults;
    const base = { ...S, source_key: e.source_key, chunk: 0, adapter: meta.adapter, adapter_ver: encodeAdapterVer(meta.adapter_ver) };
    const rows = units.flatMap((u) => {
      let raw = this.unredact(u.body);
      let enc = u.enc;
      // Fault `unredact-b64`: a redacted unit's planted value put back, and the unit stored as
      // base64, so its text holds the value only once decoded.
      if (F.has('unredact-b64') && u.redacted && enc !== 'b64') {
        const values = this.faultData.sentinels ?? [];
        raw = Buffer.from(u.body.replace(/<redacted len=(\d+)>/g, (m, n) => values.find((v) => Buffer.byteLength(v, 'utf8') === Number(n)) ?? m), 'utf8').toString('base64');
        enc = 'b64';
      }
      let pieces = this.chunkBytes && Buffer.byteLength(raw, 'utf8') > this.chunkBytes ? chunksOf(raw, this.chunkBytes) : [raw];
      if (F.has('chunk-drop') && pieces.length > 1) pieces = pieces.slice(0, -1);
      return pieces.map((piece, chunk) => ({
        ...base, generation, unit_key: u.unit_key, chunk, sha256: u.sha256, enc,
        ...(u.orig_sha256 ? { orig_sha256: u.orig_sha256 } : {}),
        redacted: !!u.redacted, continuity: manifest?.continuity ?? e.read.continuity, raw: piece,
      }));
    });
    if (F.has('archive-held-back') && e.read) {
      for (const h of e.read.held_back ?? []) rows.push({ ...base, generation, unit_key: String(h.unit_key), sha256: sha256(''), enc: 'utf8', redacted: false, continuity: manifest?.continuity ?? e.read.continuity, raw: '' });
    }
    if (manifest && !F.has('no-manifest')) {
      const raw = jcs(F.has('private-manifest') ? toPrivate(manifest) : manifest);
      rows.push({ ...base, generation, unit_key: '', sha256: sha256(Buffer.from(raw, 'utf8')), enc: 'manifest', redacted: false, continuity: manifest.continuity, raw });
    }
    return rows;
  }

  unredact(body) {
    if (!this.faults.has('unredact')) return body;
    const values = this.faultData.sentinels ?? [];
    return body.replace(/<redacted len=(\d+)>/g, (m, n) => values.find((v) => Buffer.byteLength(v, 'utf8') === Number(n)) ?? m);
  }

  // A full derive over the session's current units. Sets w.final = { records, live, held }.
  derive(w, bodies) {
    const harness = w.S.harness;
    const adapter = this.adapters.adapterFor(harness);
    const d = this.adapters.describe(harness);
    const input = [...w.sources].sort(bySourceKey).map(([sourceKey, st]) => ({
      source_key: sourceKey,
      generation: st.generation,
      complete: true,
      units: st.units.map(([uk, sha]) => {
        const u = bodies.get(`${w.sk}${SEP}${unitKey(sourceKey, uk, sha)}`);
        if (!u) throw new Error(`reference engine: unit ${sourceKey}@${uk} is not in the archive`);
        return u;
      }),
      gone: [],
    }));
    const out = adapter.derive({ ...w.S }, input, null);
    w.meta = { adapter: d.adapter, adapter_ver: out.adapter_ver ?? d.adapter_ver, model_version: out.model_version ?? d.model_version, state_ver: out.state_ver ?? d.state_ver };
    w.final = { records: out.changed, live: rksOf(out.live), held: rksOf(out.held) };
  }

  // The rows of the session's records, each fault applied.
  rowsOfRecord(rec, meta) {
    const F = this.faults;
    let rows = rowsOf(rec, meta);
    if (F.has('drop-empty')) rows = rows.filter((r) => !(r.table === 'session_parts' && r.row.part_id === '' && r.row.kind === 'none'));
    for (const { table, row } of rows) {
      if (F.has('fill-ts') && (table === 'session_parts' || table === 'session_lifecycle') && row.ts === null) row.ts = new Date().toISOString();
      if (F.has('fill-ts-lifecycle') && table === 'session_lifecycle' && row.ts === null) row.ts = new Date().toISOString();
      if (F.has('zero-nulls')) {
        if (table === 'session_usage') for (const c of ['input', 'output', 'cache_read', 'cache_write', 'reasoning', 'tool_prompt', 'cost']) row[c] ??= 0;
        if (table === 'session_parts' && row.kind === 'tool_result') row.exit_code ??= 0;
      }
      // Faults `part-sha-no-nulls` (both profiles) and `pg-skew` (PostgreSQL only): a part's
      // content_sha over the part without its null members, not the part as emitted (§4).
      if ((F.has('part-sha-no-nulls') || (F.has('pg-skew') && this.profile === 'postgres')) && table === 'session_parts' && row.part_id !== '') {
        const part = (rec.parts ?? [])[row.part_index];
        row.content_sha = jcsSha(Object.fromEntries(Object.entries(part).filter(([, v]) => v !== null)));
      }
    }
    return rows;
  }

  // What one session's final state writes: rows that are new or differ (at `rev`), and removed
  // versions (copies at `rev`, removed = 1) of every current row whose record left live and held,
  // or whose part its message no longer has.
  planSession(S, existing, final, rev, meta, { replayed = null } = {}) {
    const byRk = new Map();
    for (const [table, rows] of existing) {
      for (const row of rows) {
        const rk = rkOfRow(table, row);
        if (rk === null) continue;
        if (!byRk.has(rk)) byRk.set(rk, new Map());
        byRk.get(rk).set(`${table}|${rowKey(table, row)}`, { table, row });
      }
    }
    const writes = [];
    const removed = [];
    const deletes = [];
    const emit = (rk, rec, isRemoved) => {
      const rows = this.rowsOfRecord(rec, meta);
      const keys = new Set();
      for (const { table, row } of rows) {
        const k = `${table}|${rowKey(table, row)}`;
        keys.add(k);
        const ex = byRk.get(rk)?.get(k)?.row;
        const want = isRemoved ? 1 : 0;
        if (!ex || num(ex.removed) !== want || ex.content_sha !== row.content_sha
          || (row.message_content_sha !== undefined && ex.message_content_sha !== row.message_content_sha)
          || num(ex.adapter_ver) !== row.adapter_ver) {
          writes.push({ table, row: { ...row, removed: want, rev } });
        }
      }
      for (const [k, { table, row }] of byRk.get(rk) ?? []) if (!keys.has(k) && num(row.removed) === 0) removed.push({ table, row: { ...row, removed: 1, rev } });
    };
    if (replayed) {
      // A replay's outcome: every key it produced, current or removed; keys it never produced are
      // ones this adapter version does not produce, and are deleted (principle 3).
      for (const [rk, ks] of replayed) emit(rk, ks.record, ks.removed);
      for (const [rk, rows] of byRk) if (!replayed.has(rk)) for (const { table, row } of rows.values()) deletes.push({ table, row: { ...row, rev } });
    } else {
      const derived = new Map(final.records.map((r) => [rkOfRecord(r), r]));
      for (const rk of final.live) if (derived.has(rk)) emit(rk, derived.get(rk), false);
      for (const [rk, rows] of byRk) {
        if (final.live.has(rk) || final.held.has(rk)) continue;
        for (const { table, row } of rows.values()) if (num(row.removed) === 0) removed.push({ table, row: this.removedVersion(table, row, rev) });
      }
    }
    return { writes, removed, deletes };
  }

  // A removed version: a full copy of the row at `rev`, removed = 1 (principle 3). Fault
  // `removed-rewrite`: the copy loses its text and its adapter-set state, its shas kept.
  removedVersion(table, row, rev) {
    const out = { ...row, removed: 1, rev };
    if (this.faults.has('removed-rewrite') && table === 'session_parts') Object.assign(out, { text: '', state: 'current' });
    if (this.faults.has('removed-rewrite') && table === 'sessions') out.title = '';
    return out;
  }

  // Fault `host-merge`: a session read under a second host is written under the host that
  // delivered it first, as if one session crossed hosts. Fault `host-merge-messages`: only its
  // records other than the session record are.
  async mergeHosts(work, { sessionsToo = true } = {}) {
    const rows = await this.present('sessions');
    const first = new Map();
    const id = (x) => [x.harness, x.harness_path, x.session_id, x.incarnation].join(SEP);
    for (const r of rows) if (!first.has(id(r))) first.set(id(r), r.host);
    for (const w of work) {
      const h = first.get(id(w.S));
      if (h === undefined) first.set(id(w.S), w.S.host);
      else if (h !== w.S.host) {
        if (!sessionsToo) {
          w.final.records = w.final.records.map((r) => (r.type === 'session' ? r : { ...r, host: h }));
          continue;
        }
        w.S = { ...w.S, host: h };
        w.sk = sessionKeyOf(w.S);
        w.final.records = w.final.records.map((r) => ({ ...r, host: h }));
      }
    }
  }

  // ---- edges (§4.5) ---------------------------------------------------------------------------

  async recomputeEdges(clocks, onlyThisPass) {
    const links = await this.present('session_links');
    let statements = links.filter((r) => r.owner === 'adapter' && num(r.removed) === 0);
    if (onlyThisPass) {
      // Fault `edges-from-pass`: only the statements this pass derived.
      statements = [];
      for (const w of onlyThisPass) {
        for (const r of w.final.records) {
          if (r.type === 'link' && w.final.live.has(rkOfRecord(r))) statements.push(...this.rowsOfRecord(r, w.meta).map((x) => x.row));
        }
      }
    }
    const held = (await this.present('sessions')).filter((r) => num(r.removed) === 0);
    const desired = new Map(edgesOf(statements, held).map((row) => [rowKey('session_links', row), row]));
    const existing = new Map(links.filter((r) => r.owner === 'engine').map((r) => [rowKey('session_links', r), r]));
    const writes = [];
    const bump = (row) => {
      const sk = sessionKeyOf(row);
      const rev = (clocks.get(sk) ?? 0) + 1;
      clocks.set(sk, rev);
      return rev;
    };
    // Fault `edge-needs-all`: an edge ends as soon as one of its supporting statements is
    // removed, not when the last one is.
    if (this.faults.has('edge-needs-all')) {
      for (const [k, row] of [...desired]) {
        const ex = existing.get(k);
        if (ex && num(ex.removed) === 0 && (ex.statements ?? []).length > row.statements.length) desired.delete(k);
      }
    }
    for (const [k, row] of desired) {
      const ex = existing.get(k);
      if (!ex || num(ex.removed) !== 0 || ex.content_sha !== row.content_sha) writes.push({ table: 'session_links', row: { ...row, rev: bump(row) } });
    }
    for (const [k, ex] of existing) if (!desired.has(k) && num(ex.removed) === 0) writes.push({ table: 'session_links', row: { ...ex, removed: 1, rev: bump(ex) } });
    await this.writeVersions(writes);
  }

  // ---- replay (§4.1) --------------------------------------------------------------------------

  // Re-derive every session from session_units alone. With `adapterVer` ({harness: version}),
  // derive with that adapter version: rows it writes take higher revs, and keys it no longer
  // produces are deleted.
  async replay({ adapterVer } = {}) {
    const F = this.faults;
    const all = await this.present('session_units');
    const sessions = new Map();
    for (const row of all) {
      const sk = sessionKeyOf(row);
      if (!sessions.has(sk)) sessions.set(sk, { S: Object.fromEntries(SESSION_KEY.map((k) => [k, row[k]])), manifests: [], units: [] });
      const s = sessions.get(sk);
      if (row.unit_key === '' && row.enc === 'manifest') s.manifests.push({ row, m: F.has('private-manifest') ? fromPrivate(JSON.parse(row.raw)) : JSON.parse(row.raw) });
      else s.units.push(row);
    }
    const existing = await this.loadEntities([...sessions.values()].map((s) => s.S));
    const clocks = await this.loadClocks();
    const writes = [];
    const deletes = [];
    for (const [sk, s] of sessions) {
      const harness = s.S.harness;
      const ver = adapterVer?.[harness];
      const adapter = this.adapters.adapterFor(harness, ver === undefined ? {} : { adapterVer: ver });
      const d = adapter.describe();
      // bodiesOf keys each unit by its session too: one session here, so its key prefix goes.
      const bodies = new Map([...bodiesOf(s.units)].map(([k, u]) => [k.slice(sk.length + SEP.length), u]));
      const steps = this.replaySteps(s);
      const keyState = new Map();
      let meta = { adapter: d.adapter, adapter_ver: d.adapter_ver, model_version: d.model_version };
      for (const sources of steps) {
        const input = [...sources].sort(bySourceKey).map(([sourceKey, st]) => ({
          source_key: sourceKey, generation: st.generation, complete: true, gone: [],
          units: [...st.units].map(([uk, sha]) => {
            const u = bodies.get(unitKey(sourceKey, uk, sha));
            if (!u) throw new Error(`reference engine replay: unit ${sourceKey}@${uk} is not in the archive`);
            return u;
          }),
        }));
        const out = adapter.derive({ ...s.S }, input, null);
        meta = { adapter: d.adapter, adapter_ver: out.adapter_ver ?? d.adapter_ver, model_version: out.model_version ?? d.model_version };
        const live = rksOf(out.live);
        const held = rksOf(out.held);
        for (const r of out.changed) {
          const rk = rkOfRecord(r);
          if (live.has(rk)) keyState.set(rk, { record: r, removed: false });
        }
        for (const [rk, ks] of keyState) if (!ks.removed && !live.has(rk) && !held.has(rk)) ks.removed = true;
      }
      const rev = (clocks.get(sk) ?? 0) + 1;
      clocks.set(sk, rev);
      const plan = this.planSession(s.S, existing.get(sk) ?? new Map(), null, rev, meta, { replayed: keyState });
      writes.push(...plan.writes, ...plan.removed);
      if (!F.has('rederive-keep-stale')) deletes.push(...plan.deletes);
    }
    await this.writeVersions(writes);
    await this.deleteRows(deletes);
    await this.recomputeEdges(clocks, null);
    return {};
  }

  // The steps of a session's replay: the manifests folded pass by pass (`progress` order), each
  // step the current units of every source. Without manifests, one step: each source's highest
  // generation, its units in key order (all a replay can do without them).
  replaySteps(s) {
    const F = this.faults;
    if (!s.manifests.length) {
      const top = new Map();
      for (const r of s.units) if ((top.get(r.source_key) ?? 0) < r.generation) top.set(r.source_key, r.generation);
      const sources = new Map();
      for (const [sourceKey, g] of top) {
        const units = s.units.filter((r) => r.source_key === sourceKey && r.generation === g)
          .sort((a, b) => (/^\d+$/.test(a.unit_key) && /^\d+$/.test(b.unit_key) ? Number(a.unit_key) - Number(b.unit_key) : a.unit_key < b.unit_key ? -1 : 1));
        sources.set(sourceKey, { generation: g, units: new Map(units.map((r) => [r.unit_key, r.sha256])) });
      }
      return [sources];
    }
    const byProgress = new Map();
    for (const x of s.manifests) {
      const p = Number(x.m.progress);
      if (!byProgress.has(p)) byProgress.set(p, []);
      byProgress.get(p).push(x);
    }
    const sources = new Map();
    const steps = [];
    for (const p of [...byProgress.keys()].sort((a, b) => a - b)) {
      // Within one pass, a source's higher generation comes last: a re-run that opened a
      // generation over a crashed read supersedes it (see the header).
      const group = byProgress.get(p).sort((a, b) => Number(a.row.generation) - Number(b.row.generation));
      for (const { row, m } of group) {
        const prev = sources.get(row.source_key);
        const generation = Number(row.generation);
        if (m.source_gone) {
          const policy = F.has('ignore-policy') ? 'removed' : (m.policy ?? 'removed');
          sources.set(row.source_key, { generation, units: policy === 'kept' ? new Map(prev?.units ?? []) : new Map() });
        } else if (!prev || prev.generation !== generation || F.has('replay-last-manifest')) {
          sources.set(row.source_key, { generation, units: new Map(m.units) });
        } else {
          for (const [uk, sha] of m.units) prev.units.set(uk, sha);
          for (const k of m.gone ?? []) prev.units.delete(k);
        }
      }
      steps.push(new Map([...sources].map(([k, v]) => [k, { generation: v.generation, units: new Map(v.units) }])));
    }
    return steps;
  }

  // ---- legacy content_sha (§4.8) ----------------------------------------------------------------

  // The SQL that hashes one TabSeparated line of `exprs`, and the settings that pin its bytes.
  legacySha(exprs) {
    const row = `formatRow('TabSeparated', ${exprs.join(', ')})`;
    const line = this.faults.has('sql-tsv-no-trim') ? row : `trimRight(${row}, '\\n')`;
    return {
      sql: `lower(hex(SHA256(${line})))`,
      line: line,
      settings: { format_tsv_null_representation: '\\N', bool_true_representation: 'true', bool_false_representation: 'false' },
    };
  }

  // ---- reads ------------------------------------------------------------------------------------

  // Rows as the engine keeps them in memory: PostgreSQL's jsonb `args` and `setup` back to JSON
  // text, so a row read and written back is unchanged.
  async present(table, where, params) {
    const rows = await this.ns.present(table, where?.where ?? where, where?.params ?? params);
    if (this.profile !== 'postgres') return rows;
    for (const r of rows) for (const c of ['args', 'setup']) if (r[c] !== undefined && r[c] !== null) r[c] = jcs(r[c]);
    return rows;
  }

  // The sessions' rows: a condition with bound values ({ where, params }), never literals.
  sessionsWhere(list) {
    const uniq = [...new Map(list.map((S) => [sessionKeyOf(S), S])).values()];
    return this.ns.tupleIn(SESSION_KEY, uniq.map((S) => SESSION_KEY.map((k) => S[k] ?? '')), { name: 's' });
  }

  async loadCursors(list) {
    const rows = await this.present('session_sources', this.sessionsWhere(list));
    const out = new Map();
    for (const r of rows) {
      const sk = sessionKeyOf(r);
      if (!out.has(sk)) out.set(sk, new Map());
      const st = JSON.parse(r.state || '{}');
      out.get(sk).set(r.source_key, { generation: Number(r.generation), progress: Number(r.progress), position: r.position, mode: r.mode, units: st.units ?? [], gone: !!st.gone, policy: st.policy });
    }
    return out;
  }


  // Every present row (current or removed) of the sessions, per session and table.
  async loadEntities(list) {
    const out = new Map();
    if (!list.length) return out;
    const where = this.sessionsWhere(list);
    for (const table of ENTITY_TABLES) {
      for (const r of await this.present(table, where)) {
        const sk = sessionKeyOf(r);
        if (!out.has(sk)) out.set(sk, new Map());
        const m = out.get(sk);
        if (!m.has(table)) m.set(table, []);
        m.get(table).push(r);
      }
    }
    return out;
  }

  // The highest rev of each session's rows, deleted versions included.
  async loadClocks() {
    const out = new Map();
    for (const table of ENTITY_TABLES) {
      const rows = await this.ns.query(`SELECT host, harness, harness_path, session_id, incarnation, max(rev) AS rev FROM ${this.ns.t(table)} GROUP BY host, harness, harness_path, session_id, incarnation`);
      for (const r of rows) {
        const sk = sessionKeyOf(r);
        out.set(sk, Math.max(out.get(sk) ?? 0, Number(r.rev)));
      }
    }
    return out;
  }

  // ---- writes -----------------------------------------------------------------------------------

  async writeCursors(work) {
    const rows = [];
    for (const w of work) {
      const d = this.adapters.describe(w.S.harness);
      for (const [sourceKey, st] of w.sources) {
        if (st.progress !== w.progress) continue;
        rows.push({
          ...w.S, source_key: sourceKey, mode: st.mode ?? '', position: st.position ?? '', generation: st.generation, progress: st.progress,
          state: jcs({ units: st.units, gone: st.gone, policy: st.policy ?? null }), state_ver: Number(d.state_ver ?? 0),
          adapter: d.adapter, adapter_ver: encodeAdapterVer(d.adapter_ver),
        });
      }
    }
    await this.write('session_sources', rows);
  }

  async writeVersions(items) {
    const byTable = new Map();
    for (const { table, row } of items) {
      if (!byTable.has(table)) byTable.set(table, []);
      byTable.get(table).push(row);
    }
    for (const [table, rows] of byTable) await this.write(table, rows);
  }

  // Physical deletion: in ClickHouse a version with is_deleted = 1 at a higher rev; in
  // PostgreSQL a DELETE.
  async deleteRows(items) {
    if (!items.length) return;
    if (this.profile === 'clickhouse') {
      await this.writeVersions(items.map(({ table, row }) => ({ table, row: { ...row, is_deleted: 1 } })));
      return;
    }
    for (const { table, row } of items) {
      const cols = IDENTITY[table];
      await this.ns.query(`DELETE FROM ${this.ns.t(table)} WHERE ${cols.map((c, i) => `${c} = $${i + 1}`).join(' AND ')}`, cols.map((c) => row[c]));
    }
  }

  async write(table, rows) {
    if (!rows.length) return;
    if (this.profile === 'clickhouse') {
      await this.ns.client.insert(this.ns.t(table), rows.map((r) => encodeClickHouse(table, r)));
      return;
    }
    // PostgreSQL: every row writes the table's whole column list, a column the row does not set
    // as its DEFAULT, so an upsert replaces every non-key column (schema/postgres.sql's write
    // rule) and a column a newer version no longer sets does not keep the older value. The last
    // row of a key in a batch wins. Fault `pg-partial-upsert`: only the columns the row sets.
    const dedup = new Map();
    for (const r of rows) dedup.set(rowKey(table, r), encodePostgres(table, r));
    const groups = new Map();
    const all = this.faults.has('pg-partial-upsert') ? null : await this.columnsOf(table);
    for (const r of dedup.values()) {
      const cols = all ?? Object.keys(r).filter((k) => r[k] !== undefined).sort();
      const sig = cols.join(',');
      if (!groups.has(sig)) groups.set(sig, { cols, rows: [] });
      groups.get(sig).rows.push(r);
    }
    for (const { cols, rows: grp } of groups.values()) {
      for (let i = 0; i < grp.length; i += 200) {
        const chunk = grp.slice(i, i + 200);
        const params = [];
        const values = chunk.map((r) => `(${cols.map((c) => {
          if (r[c] === undefined) return 'DEFAULT';
          params.push(r[c]);
          return `$${params.length}`;
        }).join(', ')})`).join(', ');
        const pk = IDENTITY[table];
        let conflict;
        if (table === 'session_units') conflict = `ON CONFLICT (${pk.join(', ')}) DO NOTHING`;
        else {
          const set = cols.filter((c) => !pk.includes(c)).map((c) => `${c} = EXCLUDED.${c}`).join(', ');
          const t = this.ns.t(table).split('.').pop();
          const cond = table === 'session_sources'
            ? `(EXCLUDED.generation, EXCLUDED.progress) > (${t}.generation, ${t}.progress)`
            : `EXCLUDED.rev > ${t}.rev`;
          conflict = `ON CONFLICT (${pk.join(', ')}) DO UPDATE SET ${set} WHERE ${cond}`;
        }
        await this.ns.query(`INSERT INTO ${this.ns.t(table)} AS ${this.ns.t(table).split('.').pop()} (${cols.join(', ')}) VALUES ${values} ${conflict}`, params);
      }
    }
  }

  // A PostgreSQL table's columns, from the catalogue, once per engine.
  async columnsOf(table) {
    this.columnCache ??= new Map();
    if (!this.columnCache.has(table)) {
      const [schema, name] = this.ns.t(table).split('.');
      const rows = await this.ns.query('SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position', [schema, name]);
      this.columnCache.set(table, rows.map((r) => r.column_name));
    }
    return this.columnCache.get(table);
  }
}

// A position as the cursor keeps it: canonical JSON, and '' for none (a null `from`, a null
// position and a fresh cursor are one position).
const positionOf = (p) => (p === null || p === undefined ? '' : jcs(p));

// Whether a read's units are exactly a source's [unit_key, sha256] list (as sets).
function sameUnits(units, list) {
  if (units.length !== list.length) return false;
  const held = new Map(list);
  return units.every((u) => held.get(u.unit_key) === u.sha256);
}

// Every archived unit of the rows, as `read` emitted it, its chunks put back together in chunk
// order: `${sk}\0${source}\0${unit_key}\0${sha256}` -> unit.
function bodiesOf(rows) {
  const parts = new Map();
  for (const r of rows) {
    if (r.unit_key === '') continue;
    const k = `${sessionKeyOf(r)}${SEP}${unitKey(r.source_key, r.unit_key, r.sha256)}`;
    if (!parts.has(k)) parts.set(k, []);
    parts.get(k).push(r);
  }
  const out = new Map();
  for (const [k, rs] of parts) {
    // A unit archived in two generations has its chunks in each: take one generation's.
    const g = Math.max(...rs.map((r) => Number(r.generation)));
    const chunks = rs.filter((r) => Number(r.generation) === g).sort((a, b) => Number(a.chunk) - Number(b.chunk));
    out.set(k, unitFromArchive({ ...chunks[0], raw: chunks.map((r) => r.raw).join('') }));
  }
  return out;
}

// A raw split at character boundaries into pieces of at most `max` UTF-8 bytes.
function chunksOf(text, max) {
  const out = [];
  let cur = '';
  let n = 0;
  for (const ch of text) {
    const b = Buffer.byteLength(ch, 'utf8');
    if (n + b > max && cur) {
      out.push(cur);
      cur = '';
      n = 0;
    }
    cur += ch;
    n += b;
  }
  out.push(cur);
  return out;
}

// The manifests of session `sk` a pass at `progress` finds above its cursor (written by a pass
// that crashed before its cursor write), per source: { generation (the source's highest in the
// archive), manifests: [{generation, sha256}] }.
function orphansOf(rows, sk, progress) {
  const out = new Map();
  const top = new Map();
  for (const r of rows) {
    if (sessionKeyOf(r) !== sk) continue;
    top.set(r.source_key, Math.max(top.get(r.source_key) ?? 0, Number(r.generation)));
    if (r.unit_key !== '' || r.enc !== 'manifest') continue;
    let m;
    try {
      m = JSON.parse(r.raw);
    } catch {
      continue;
    }
    const p = Number(m.progress ?? m.p);
    if (!(p >= progress)) continue;
    if (!out.has(r.source_key)) out.set(r.source_key, { generation: 0, manifests: [] });
    out.get(r.source_key).manifests.push({ generation: Number(r.generation), sha256: r.sha256 });
  }
  for (const [k, o] of out) o.generation = top.get(k);
  return out;
}

// Fault `private-manifest`: manifests in a layout of the engine's own, which only its replay
// reads.
const toPrivate = (m) => ({ layout: 'private', p: m.progress, c: m.continuity, u: m.units, g: m.gone, sg: m.source_gone, ...(m.policy ? { pol: m.policy } : {}) });
const fromPrivate = (x) => ({ progress: x.p, continuity: x.c, units: x.u, gone: x.g, source_gone: x.sg, ...(x.pol ? { policy: x.pol } : {}) });

const DROP = ['writer', 'ingested_at', 'captured_at', 'committed_at', 'ver'];

function encodeClickHouse(table, row) {
  const r = { ...row };
  for (const c of DROP) delete r[c];
  // `args` is a String with '' for none; `setup` a Nullable(String).
  if (table === 'session_parts' && r.args === null) r.args = '';
  if (r.is_deleted !== undefined) r.is_deleted = num(r.is_deleted === true ? 1 : r.is_deleted === false ? 0 : r.is_deleted);
  if (r.orig_sha256 === null) delete r.orig_sha256;
  return r;
}

function encodePostgres(table, row) {
  const r = { ...row };
  for (const c of DROP) delete r[c];
  // jsonb: `args` and `setup` arrive as JSON text (or null, or '' from a ClickHouse-shaped row),
  // the array columns as arrays.
  for (const c of JSON_COLUMNS[table] ?? []) {
    if (r[c] === undefined) continue;
    if (r[c] === null || r[c] === '') r[c] = c === 'args' || c === 'setup' ? null : '[]';
    else if (typeof r[c] !== 'string') r[c] = JSON.stringify(r[c]);
  }
  if (r.is_deleted !== undefined) r.is_deleted = r.is_deleted === true || r.is_deleted === 1 || r.is_deleted === '1';
  if (r.removed !== undefined) r.removed = num(r.removed);
  if (r.redacted !== undefined) r.redacted = r.redacted === true || r.redacted === 1;
  if (r.orig_sha256 === '' || r.orig_sha256 === undefined) delete r.orig_sha256;
  return r;
}

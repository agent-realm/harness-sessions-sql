// §8: "Crash-safe: killing the pass at the minimum crash point, right after the archive write
// and before the cursor write, then re-running it, gives equal row counts and equal current
// state. An engine may declare further crash points (after its entity writes, its removed
// versions, its edges), and the item holds at each of them too."
//
// 1. Every crash point, every pass. A clean run of the rewind scenario is the reference. For each
//    crash point (`archive`, right after the archive write, always; and every later point the
//    engine declares in `crashPoints`), every pass is first stopped there and then, in the same
//    namespace, run again by a fresh engine instance (a restarted process). The kit does not take
//    the stop on trust; right after the stopped call:
//    - every unit the pass's reads delivered is in session_units (the archive write happened);
//    - the cursor is as it was: every crash point lies before the cursor write;
//    - at `archive`, the entity tables are as they were, every row at its rev: nothing after the
//      archive write ran.
//    The re-run's logical row counts and current state (identity and shas, rev left out) must
//    equal the clean run's.
//    The cursor is read through the engine's `cursor()` when it has one, else from session_sources.
//    Either must change over the clean run, or the kit cannot see the cursor (an engine may keep it
//    elsewhere, §4.6): then the stops are not proven, and the check is reported skipped with the
//    reason, never passed.
// 2. A crash, then other content (the crashRerun scenario): the crashed pass's reads are archived
//    and never committed, and before the re-run the harness store changes, so the re-run reads
//    other content from the same positions. The result must equal a clean run of what was
//    committed (pass 1, then the re-run), removed versions included; and the archive must still
//    replay to it (spec §1, re-derivable; §4.1): the kit's fold of session_units gives each source
//    the units the committed reads left current, and the engine's replay from session_units alone
//    gives the clean run's state.

import { snapshot, diffSnapshots, counts } from '../lib/state.mjs';
import { ENTITY_TABLES, sessionKeyOf, sessionKeyObject } from '../lib/keys.mjs';
import { expectSources } from '../lib/oracle.mjs';
import { foldArchive, diffSources } from '../lib/archive.mjs';
import { jcs } from '../lib/jcs.mjs';
import { verdict, skip } from '../lib/result.mjs';

const CURSOR_VOLATILE = new Set(['committed_at', 'writer', 'ver']);

// session_sources, whole, as one string; null when it cannot be read (an engine's own DDL may not
// have it: it is informative, §4.6).
async function cursorRows(ns) {
  let rows;
  try {
    rows = await ns.present('session_sources');
  } catch {
    return null;
  }
  return JSON.stringify(rows.map((r) => JSON.stringify(Object.entries(r).filter(([k]) => !CURSOR_VOLATILE.has(k)).sort(([a], [b]) => (a < b ? -1 : 1)))).sort());
}

// How the kit reads a namespace's cursor: the engine's own `cursor()` (its committed cursor, as
// stored, read by a fresh instance), or session_sources.
const cursorReader = (ctx, engine) => (typeof engine.cursor === 'function'
  ? { how: "the engine's cursor()", read: async (ns) => jcs((await (await ctx.engine(ns)).cursor()) ?? null) }
  : { how: 'session_sources', read: cursorRows });

const archivedKeys = async (ns) => new Set((await ns.present('session_units')).filter((r) => r.unit_key !== '').map((r) => `${sessionKeyOf(r)}\u0000${r.source_key}\u0000${r.unit_key}\u0000${r.sha256}`));
const deliveredKeys = (pass) => pass.flatMap((e) => (e.source_gone ? [] : e.read.units.map((u) => `${sessionKeyOf(sessionKeyObject(e.store, e.session))}\u0000${e.source_key}\u0000${u.unit_key}\u0000${u.sha256}`)));

export default {
  id: 'crash-safe',
  title: 'Crash-safe',
  faults: ['engine:cursor-early', 'engine:ignore-crash', 'engine:no-rerun-bump'],

  async engine(ctx) {
    const problems = [];
    const notes = [];
    const sc = ctx.scenario('rewind');
    const clean = await ctx.namespace();
    const e0 = await ctx.engine(clean);
    const cursor = cursorReader(ctx, e0);
    const cursorsSeen = new Set([await cursor.read(clean)]);
    let changing = 0;
    for (const p of sc.passes) {
      const before = await snapshot(clean, { tables: ENTITY_TABLES, rev: true });
      await e0.pass(p);
      if (diffSnapshots(before, await snapshot(clean, { tables: ENTITY_TABLES, rev: true })).length) changing++;
      cursorsSeen.add(await cursor.read(clean));
    }
    if (!changing) problems.push('no pass of the scenario changes the entity tables: the stop after the archive write cannot be told from a whole pass');
    // A cursor the kit cannot see change over a clean run proves nothing about a stop.
    const cursorSeen = cursorsSeen.size > 1 && !cursorsSeen.has(null);
    const want = await snapshot(clean, { removed: false });
    const wantCounts = await counts(clean);
    const points = [...new Set(['archive', ...(e0.crashPoints ?? [])])];
    for (const point of points) {
      const ns = await ctx.namespace();
      for (let i = 0; i < sc.passes.length; i++) {
        const p = sc.passes[i];
        const at = `crashed after ${point}, pass ${i + 1}`;
        const entities = await snapshot(ns, { tables: ENTITY_TABLES, rev: true });
        const before = cursorSeen ? await cursor.read(ns) : null;
        await (await ctx.engine(ns)).pass(p, { crashAfter: point });
        const archived = await archivedKeys(ns);
        const missing = deliveredKeys(p).filter((k) => !archived.has(k));
        if (missing.length) problems.push(`${at}: ${missing.length} unit(s) the pass delivered are not archived: the stop came before the archive write`);
        if (cursorSeen && await cursor.read(ns) !== before) problems.push(`${at}: the cursor (${cursor.how}) changed: the stop came after the cursor write, or the cursor was written early`);
        if (point === 'archive') {
          const d = diffSnapshots(entities, await snapshot(ns, { tables: ENTITY_TABLES, rev: true }), { left: 'before the call', right: 'after the stop' });
          if (d.length) problems.push(`${at}: the entity tables changed, so more than the archive write ran: ${d[0]}`);
        }
        await (await ctx.engine(ns)).pass(p);
      }
      const got = await snapshot(ns, { removed: false });
      for (const d of diffSnapshots(want, got, { left: 'clean', right: `crashed after ${point}` })) problems.push(d);
      const gotCounts = await counts(ns);
      for (const [t, n] of Object.entries(wantCounts)) if (gotCounts[t] !== n) problems.push(`crashed after ${point}: ${t} holds ${gotCounts[t]} logical rows, the clean run ${n}`);
    }
    notes.push(`crash points: ${points.join(', ')}; ${sc.passes.length} passes, each stopped (and the stop checked${cursorSeen ? `, the cursor read through ${cursor.how}` : ''}) then re-run`);

    // 2. A crash, then other content.
    const cr = ctx.scenario('crashRerun');
    const cleanCr = await ctx.namespace();
    const ec = await ctx.engine(cleanCr);
    for (const p of cr.passes) await ec.pass(p);
    const crashed = await ctx.namespace();
    await (await ctx.engine(crashed)).pass(cr.passes[0]);
    await (await ctx.engine(crashed)).pass(cr.crashed, { crashAfter: 'archive' });
    await (await ctx.engine(crashed)).pass(cr.passes[1]);
    const wantCr = await snapshot(cleanCr, { tables: ENTITY_TABLES, edgeHistory: false });
    for (const d of diffSnapshots(wantCr, await snapshot(crashed, { tables: ENTITY_TABLES, edgeHistory: false }), { left: 'clean', right: 'crashed, then re-run on other content' })) problems.push(`crash then other content: ${d}`);
    const f = foldArchive(await crashed.present('session_units'));
    problems.push(...f.problems.map((d) => `crash then other content, the archive: ${d}`));
    problems.push(...diffSources(f.sources, expectSources(cr.passes).at(-1), { label: 'crash then other content, the archive' }));
    const replayed = await ctx.namespace();
    await ctx.copyUnits(crashed, replayed);
    await (await ctx.engine(replayed)).replay();
    for (const d of diffSnapshots(wantCr, await snapshot(replayed, { tables: ENTITY_TABLES, edgeHistory: false }), { left: 'clean', right: 'replayed from the crashed archive' })) problems.push(`crash then other content: ${d}`);
    notes.push(`crash then other content: ${cr.crashed.filter((e) => e.read?.units.length).length} read(s) archived and never committed, then re-read with other content; compared with a clean run, folded and replayed`);
    if (!problems.length && !cursorSeen) {
      const r = skip(`not proven: the kit cannot see the cursor (${cursor.how} did not change over a clean run), so no stop was shown to come before the cursor write, and a crash point the engine ignores would pass. An engine that keeps its cursor outside session_sources exposes it as cursor()`);
      return { ...r, notes: [...r.notes, ...notes] };
    }
    return verdict(problems, notes);
  },
};

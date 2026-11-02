// §8 (v1.1): "Units resolve: every `units` triple of a current row (sessions.units,
// session_parts.message_units) names a unit of its own session in session_units, by source_key,
// generation and unit_key, unless that source was removed under the `removed` vanish policy
// (§4.1). The column holds the `units` of a derivation of the content the row holds: the current
// record's, or, because `units` is outside `content_sha` (§4.2), an earlier derivation's with the
// same `content_sha`."
//
// Two cases, each through the engine (sessions-model v1.4: every adapter emits `units`):
// - broad: after its pass, every current session and part row;
// - kept vanish: a source that vanishes in pass 2 under the `kept` policy (the absences scenario),
//   judged live and again after a replay from session_units alone into a fresh namespace. The
//   vanishing opens a generation that archives only its manifest, while the kept units stay in
//   the generation before it, which replay takes as current (§4.1): a triple names that one. A live
//   pass writes no new version for a change of `units` alone, so the replay, which writes every
//   key it derives, is where a triple naming the wrong generation shows. The case runs when the
//   engine implements `kept` (its `vanishPolicies` names it, or it declares none, as Absences
//   replay reads the declaration).
// For each row, each triple must name a unit of the session's archive (any chunk of it), and the
// column must equal, in order, the `units` of a record the kit expects for that key after some
// pass with the row's content_sha (message_content_sha for a part row). Generations compare by
// rank, not by number: the engine numbers a source's generations, and only their order is
// significant (sessions v1.4.4, spec §4.1). The kit's expectation numbers them 1, 2, … in the
// order the reads open them, which is their rank; an engine's generation ranks among the distinct
// generations its archive holds for that source, manifests included, since every generation a read
// opens archives at least its manifest (§4.1): an engine that starts at 0 passes, and one that
// names another generation of the source than the one its units are in fails. So the triples must
// resolve in the archive, as a reader's LEFT JOIN reads them (§6), and need not be the latest
// derivation's: `units` is outside `content_sha` (sessions-model §2.7), and a triple of an earlier
// generation still names the unit that produced the row's content. An engine that writes a new
// version when only `units` move holds the latest; one that writes only when `content_sha` moves
// may hold an earlier one; both pass. Neither case removes a source, so no triple is exempt. Over
// the run, at least one row holds a triple, so the check proves something.

import { verdict } from '../lib/result.mjs';
import { sessionKeyOf } from '../lib/keys.mjs';

// A units column as stored: ClickHouse's named tuples, PostgreSQL's jsonb objects, or arrays.
function triples(v) {
  const list = typeof v === 'string' ? JSON.parse(v || '[]') : v ?? [];
  return list.map((t) => (Array.isArray(t) ? [String(t[0]), Number(t[1]), String(t[2])] : [String(t.source_key), Number(t.generation), String(t.unit_key)]));
}
const asText = (units) => JSON.stringify((units ?? []).map(([s, g, u]) => [s, g, u]));
const recordKey = (sk, r) => (r.type === 'session' ? `${sk}|session` : `${sk}|message|${r.message_id}`);

// Whether the engine implements the `kept` vanish policy (Absences replay's reading of the
// declaration: none declared means both).
const keepsVanished = (engine) => engine.vanishPolicies === undefined || engine.vanishPolicies === null
  || (Array.isArray(engine.vanishPolicies) && engine.vanishPolicies.includes('kept'));

// One namespace's current rows against the kit's expectation (`states`, one per pass): the problems
// found, each prefixed with `at`, and the number of triples judged.
async function resolve(ns, states, at) {
  const problems = [];
  let named = 0;
  const archived = await ns.present('session_units');
  const archive = new Set(archived.filter((u) => u.unit_key !== '').map((u) => `${sessionKeyOf(u)}|${u.source_key}|${Number(u.generation)}|${u.unit_key}`));
  // Each source's generations in its archive, in order: session key|source_key -> sorted numbers.
  const byOrder = new Map();
  for (const u of archived) {
    const k = `${sessionKeyOf(u)}|${u.source_key}`;
    if (!byOrder.has(k)) byOrder.set(k, new Set());
    byOrder.get(k).add(Number(u.generation));
  }
  const ranks = new Map([...byOrder].map(([k, gs]) => [k, new Map([...gs].sort((a, b) => a - b).map((g, i) => [g, i + 1]))]));
  // A triple with its generation as its rank in the source's archive; null where the archive has no
  // such generation (that triple also names no unit, below).
  const ranked = (sk, [s, g, u]) => [s, ranks.get(`${sk}|${s}`)?.get(g) ?? null, u];
  const sessions = new Map((await ns.current('sessions')).map((r) => [sessionKeyOf(r), r]));
  const parts = new Map((await ns.current('session_parts')).map((r) => [`${sessionKeyOf(r)}|${r.message_id}|${r.part_id}`, r]));

  // The units each content of each record had, over every pass: key|content_sha -> units texts.
  const derived = new Map();
  for (const snap of states) {
    for (const [sk, st] of snap) {
      for (const r of st.current.values()) {
        if (r.type !== 'session' && r.type !== 'message') continue;
        const k = `${recordKey(sk, r)}|${r.content_sha}`;
        if (!derived.has(k)) derived.set(k, new Set());
        derived.get(k).add(asText(r.units));
      }
    }
  }

  const judge = (where, sk, rk, sha, column) => {
    const got = triples(column);
    for (const [s, g, u] of got) {
      named++;
      if (!archive.has(`${sk}|${s}|${g}|${u}`)) problems.push(`${at}, ${where}: [${s}, ${g}, ${u}] names no unit of the session's archive`);
    }
    const want = derived.get(`${rk}|${sha}`);
    if (!want) problems.push(`${at}, ${where}: its content_sha is no derivation's of that record`);
    else if (!want.has(JSON.stringify(got.map((t) => ranked(sk, t))))) problems.push(`${at}, ${where}: holds ${got.length} triples, which no derivation of its content had${[...want].some((w) => JSON.parse(w).length === got.length) ? ' (another order or other values)' : ''}`);
  };
  for (const [sk, st] of states.at(-1)) {
    for (const r of st.current.values()) {
      if (r.type === 'session') {
        const row = sessions.get(sk);
        if (!row) problems.push(`${at}, session ${r.session_id}: no current row`);
        else judge(`session ${r.session_id}: units`, sk, recordKey(sk, r), row.content_sha, row.units);
      }
      if (r.type !== 'message') continue;
      for (const p of r.parts?.length ? r.parts : [{ part_id: '' }]) {
        const row = parts.get(`${sk}|${r.message_id}|${p.part_id}`);
        if (!row) problems.push(`${at}, part ${r.message_id}/${p.part_id}: no current row`);
        else judge(`part ${r.message_id}/${p.part_id}: message_units`, sk, recordKey(sk, r), row.message_content_sha, row.message_units);
      }
    }
  }
  return { problems, named };
}

export default {
  id: 'units-resolve',
  title: 'Units resolve',
  faults: ['engine:units-shifted', 'engine:units-dropped', 'engine:kept-units-gone-generation'],

  async engine(ctx) {
    const problems = [];
    const notes = [];
    let named = 0;
    const add = (r) => { problems.push(...r.problems); named += r.named; return r.named; };

    const broad = ctx.scenario('broad');
    const ns = await ctx.namespace();
    const engine = await ctx.engine(ns);
    for (const p of broad.passes) await engine.pass(p);
    notes.push(`broad: ${add(await resolve(ns, ctx.expect(broad), 'broad'))} triples`);

    if (keepsVanished(engine)) {
      const sc = ctx.scenario('absences', { vanish: ['kept'], resetAndGone: false });
      const states = ctx.expect(sc);
      const live = await ctx.namespace();
      const liveEngine = await ctx.engine(live);
      for (const p of sc.passes) await liveEngine.pass(p);
      const n = add(await resolve(live, states, 'kept vanish, live'));
      const replayed = await ctx.namespace();
      await ctx.copyUnits(live, replayed);
      await (await ctx.engine(replayed)).replay();
      notes.push(`kept vanish (${Object.values(sc.meta).map((v) => v.session_id).join(', ')}): ${n} triples live, ${add(await resolve(replayed, states, 'kept vanish, replayed'))} after a replay from session_units alone`);
    } else notes.push(`kept vanish: not run, the engine declares vanishPolicies ${JSON.stringify(engine.vanishPolicies)}`);

    if (!named) problems.push('no row holds a units triple: the scenario proves nothing (are the adapters older than sessions-model v1.4?)');
    return verdict(problems, [`${named} triples, each naming a unit of its session's archive, each column the units of a derivation of its content`, ...notes]);
  },
};

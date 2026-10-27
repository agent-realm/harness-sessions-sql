// §8: "Absences replay: a still-listed source reset to empty, a delta read's gone keys, and a
// vanished source handled under each vanish policy the engine implements ("policy": "kept",
// "policy": "removed"), each replayed from session_units alone (no entity table, no cursor), give
// the same current state as the live pass, with the adapter-owned rows' removed versions. Replay
// rebuilds the current edges, not the removed versions of edges that ended: it folds each session
// alone, and the order of passes across sessions is not archived.
// - Vanish policies are declared, not assumed. Which policy handles a vanished source is the
//   consumer's choice (§4.1), so an engine declares the policies it implements: kept, removed, or
//   both. Each declared policy is checked, and an undeclared one does not apply; an engine that
//   declares none is checked against both. A consumer that only ever keeps conforms if it keeps
//   correctly: both policies are needed only by an engine that offers both.
// - Replay follows the recorded policy. A source_gone manifest records the policy the consumer
//   applied (§4.1), and replay follows that record, never the engine's current setting. For an
//   engine that offers both, a policy that changes between passes leaves every earlier event
//   replaying as it was handled."
//
// An engine declares its vanish policies as `vanishPolicies` (['kept'], ['removed'] or both); with
// no declaration it is checked against both. The item has four parts, each its own row:
// - reset and gone keys: a source reset to empty and a delta read's gone keys, in pass 2;
// - vanished, kept / vanished, removed: a source that vanishes in pass 2, handled under that
//   policy; n/a, with the declaration as the reason, for a policy the engine does not declare;
// - policy changed: for an engine that offers both, two sources vanish in two passes under two
//   policies, in both orders (kept then removed, removed then kept): each event replays under the
//   policy its manifest records, not the one the engine applied last.
// An engine's live state and its own replay can agree and both be wrong (a "kept" source handled
// as removed in both), and a replay can read manifests that only that engine understands, so each
// part holds both to what does not depend on the engine:
// 1. after each live pass, the adapter-owned records are what the contract says (the oracle:
//    current with their derived shas, each key that left live a removed version);
// 2. after each pass, session_units folded as §4.1 says (by the kit, lib/archive.mjs) gives each
//    source exactly the units its reads left current;
// 3. every manifest has §4.1's shape, and records the read it stands for, in order (a vanished
//    source's manifest, the policy the envelope gave);
// 4. only session_units is copied into a fresh namespace (no entity table, no cursor), the engine
//    replays from it, and the replay holds the live namespace's adapter-owned rows, current and
//    removed (identity, shas, removed flag), and the same current edges.

import { snapshot, diffSnapshots, records } from '../lib/state.mjs';
import { ENTITY_TABLES } from '../lib/keys.mjs';
import { expectSources } from '../lib/oracle.mjs';
import { foldArchive, diffSources, manifestProblems, readProblems } from '../lib/archive.mjs';
import { recordProblems } from '../lib/compare.mjs';
import { verdict, fail, na } from '../lib/result.mjs';

const POLICIES = ['kept', 'removed'];

// The engine's declared vanish policies: { policies, note } or { error }.
function declared(engine) {
  const d = engine.vanishPolicies;
  if (d === undefined || d === null) return { policies: POLICIES, note: 'the engine declares no vanishPolicies: checked against both (§8)' };
  if (!Array.isArray(d) || !d.length || d.some((p) => !POLICIES.includes(p))) {
    return { error: `the engine's vanishPolicies ${JSON.stringify(d)} does not name at least one of "kept" and "removed", and nothing else` };
  }
  return { policies: POLICIES.filter((p) => d.includes(p)), note: `the engine declares vanishPolicies ${JSON.stringify(d)}` };
}

// One part: the engine's declaration decides whether it applies (`needs`, the policies the part
// exercises), then each scenario variant runs live and is replayed.
function part(name, needs, variants) {
  return {
    part: name,
    async run(ctx) {
      const live = await ctx.namespace();
      const engine = await ctx.engine(live);
      const decl = declared(engine);
      if (decl.error) return fail(decl.error);
      const missing = needs.filter((p) => !decl.policies.includes(p));
      if (missing.length) return na(`${decl.note}: it does not implement ${missing.map((p) => `"${p}"`).join(' or ')}, so this part does not apply (§8: the vanish policy is the consumer's choice, §4.1)`);
      const problems = [];
      const notes = needs.length ? [decl.note] : [];
      for (const [i, opts] of variants.entries()) {
        const r = await absences(ctx, opts, i === 0 ? { live, engine } : {});
        problems.push(...r.problems.map((d) => (variants.length > 1 ? `${r.label}: ${d}` : d)));
        notes.push(r.note);
      }
      return verdict(problems, notes);
    },
  };
}

export default {
  id: 'absences-replay',
  title: 'Absences replay',
  faults: ['engine:no-manifest', 'engine:ignore-policy', 'engine:policy-kept-as-removed', 'engine:private-manifest', 'engine:manifest-whole-generation', 'engine:replay-current-policy'],
  parts: [
    part('engine: reset and gone keys', [], [{ resetAndGone: true }]),
    part('engine: vanished, kept', ['kept'], [{ resetAndGone: false, vanish: ['kept'] }]),
    part('engine: vanished, removed', ['removed'], [{ resetAndGone: false, vanish: ['removed'] }]),
    part('engine: policy changed', POLICIES, [{ resetAndGone: false, vanish: ['kept', 'removed'] }, { resetAndGone: false, vanish: ['removed', 'kept'] }]),
  ],
};

// One scenario variant, live pass by pass, then replayed from the archive alone.
async function absences(ctx, opts, given = {}) {
  const problems = [];
  const sc = ctx.scenario('absences', opts);
  const exp = ctx.expect(sc);
  const units = expectSources(sc.passes);
  const cases = Object.fromEntries(Object.entries(sc.meta).map(([k, v]) => [v.session_id, k]));
  const tag = (d) => {
    const which = Object.entries(cases).find(([sid]) => d.includes(sid));
    return which ? `${d} [case: ${which[1]}]` : d;
  };
  const live = given.live ?? await ctx.namespace();
  const engine = given.engine ?? await ctx.engine(live);
  const tomb = (engine.removal ?? 'removed') === 'tombstone';
  let rows = [];
  for (let i = 0; i < sc.passes.length; i++) {
    await engine.pass(sc.passes[i]);
    const at = `live, pass ${i + 1}`;
    problems.push(...recordProblems(await records(live), exp[i], { tomb, at }).problems.map(tag));
    rows = await live.present('session_units');
    const f = foldArchive(rows);
    problems.push(...f.problems.map((d) => tag(`archive after pass ${i + 1}: ${d}`)));
    problems.push(...diffSources(f.sources, units[i], { label: `archive after pass ${i + 1}` }).map(tag));
  }
  problems.push(...manifestProblems(rows).map(tag), ...readProblems(sc.passes, rows).map(tag));

  const replayed = await ctx.namespace();
  await ctx.copyUnits(live, replayed);
  await (await ctx.engine(replayed)).replay();
  const a = await snapshot(live, { tables: ENTITY_TABLES, edgeHistory: false });
  const b = await snapshot(replayed, { tables: ENTITY_TABLES, edgeHistory: false });
  for (const d of diffSnapshots(a, b, { left: 'live', right: 'replayed' })) problems.push(tag(d));
  const manifests = rows.filter((r) => r.unit_key === '').length;
  const label = Object.keys(sc.meta).filter((k) => k !== 'reset' && k !== 'gone').join(' then ') || 'reset and gone keys';
  return { problems, label, note: `${label}: cases ${Object.entries(sc.meta).map(([k, v]) => `${k} (${v.session_id})`).join(', ')}; ${sc.passes.length} passes; live state and the archive's fold checked against the reads after each pass; ${manifests} manifest(s) checked; then replayed` };
}

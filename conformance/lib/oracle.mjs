// The kit's expectation: what the sessions contract says the current state is after each pass,
// computed in memory from the envelopes alone, with no database and no engine.
//
// Per source, the fold of sessions §3 (reset and snapshot replace the units, appended and delta
// add and replace, delta drops `gone`, unchanged does nothing; a vanished source keeps its last
// units under "kept" and has none under "removed"). Per session touched by a pass, one derive in
// full over every source's current units (sessions §2: the full replay equals every incremental
// path). Then sessions §4: a key in `live` is current with its derived record; a key absent from
// both `live` and `held` that was current is removed; a held key keeps its last written version.

import { sessionKeyOf, sessionKeyObject, rkOfRecord, rksOf } from './keys.mjs';

const bySourceKey = ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0);

// One envelope folded into its source (sessions §3): reset and snapshot replace the units,
// appended and delta add and replace, delta drops `gone`, unchanged does nothing; a vanished
// source keeps its last units under "kept" and has none under "removed".
function foldEnvelope(m, e) {
  const cur = m.get(e.source_key);
  if (e.source_gone) {
    m.set(e.source_key, { generation: (cur?.generation ?? 0) + 1, units: e.policy === 'kept' ? new Map(cur?.units ?? []) : new Map() });
    return;
  }
  const c = e.read.continuity;
  if (!cur || c === 'reset' || c === 'snapshot') {
    m.set(e.source_key, { generation: (cur?.generation ?? 0) + 1, units: new Map(e.read.units.map((u) => [u.unit_key, u])) });
  } else if (c === 'appended' || c === 'delta') {
    for (const u of e.read.units) cur.units.set(u.unit_key, u);
    for (const k of e.read.gone ?? []) cur.units.delete(k);
  }
}

// For each pass: Map(sk -> Map(source_key -> Map(unit_key -> sha256))), the units each source
// holds after it: what the archive must fold to (spec §4.1, lib/archive.mjs).
export function expectSources(passes) {
  const sources = new Map();
  const out = [];
  for (const pass of passes) {
    for (const e of pass) {
      const sk = sessionKeyOf(sessionKeyObject(e.store, e.session));
      if (!sources.has(sk)) sources.set(sk, new Map());
      foldEnvelope(sources.get(sk), e);
    }
    out.push(new Map([...sources].map(([sk, m]) => [sk, new Map([...m].map(([src, s]) => [src, new Map([...s.units].map(([uk, u]) => [uk, u.sha256]))]))])));
  }
  return out;
}

// For each pass: Map(sk -> { S, current: Map(rk -> record), removed: Map(rk -> record), live,
// held }), covering every session seen so far.
export function expectStates(passes, adapters) {
  const sources = new Map();
  const state = new Map();
  const out = [];
  for (const pass of passes) {
    const touched = new Map();
    for (const e of pass) {
      const S = sessionKeyObject(e.store, e.session);
      const sk = sessionKeyOf(S);
      touched.set(sk, S);
      if (!sources.has(sk)) sources.set(sk, new Map());
      foldEnvelope(sources.get(sk), e);
    }
    for (const [sk, S] of touched) {
      const adapter = adapters.adapterFor(S.harness);
      const input = [...sources.get(sk)].sort(bySourceKey).map(([source_key, s]) => ({ source_key, generation: s.generation, complete: true, units: [...s.units.values()], gone: [] }));
      const d = adapter.derive({ ...S }, input, null);
      const st = state.get(sk) ?? { S, written: new Map(), current: new Set(), removed: new Set() };
      const live = rksOf(d.live);
      const held = rksOf(d.held);
      for (const r of d.changed) {
        const rk = rkOfRecord(r);
        if (!live.has(rk)) continue;
        st.written.set(rk, r);
        st.current.add(rk);
        st.removed.delete(rk);
      }
      for (const rk of [...st.current]) {
        if (live.has(rk) || held.has(rk)) continue;
        st.current.delete(rk);
        st.removed.add(rk);
      }
      st.live = live;
      st.held = held;
      state.set(sk, st);
    }
    const snap = new Map();
    for (const [sk, st] of state) {
      snap.set(sk, {
        S: st.S,
        current: new Map([...st.current].map((rk) => [rk, st.written.get(rk)])),
        removed: new Map([...st.removed].map((rk) => [rk, st.written.get(rk)])),
        live: new Set(st.live),
        held: new Set(st.held),
      });
    }
    out.push(snap);
  }
  return out;
}

// Every unit the envelopes delivered, by session, source, unit_key and sha256; and the held-back
// partial lines.
export function emittedUnits(passes) {
  const units = new Map();
  const heldBack = [];
  for (const pass of passes) {
    for (const e of pass) {
      if (e.source_gone) continue;
      const sk = sessionKeyOf(sessionKeyObject(e.store, e.session));
      for (const u of e.read.units) units.set(`${sk}\u0000${e.source_key}\u0000${u.unit_key}\u0000${u.sha256}`, u);
      for (const h of e.read.held_back ?? []) heldBack.push({ sk, source_key: e.source_key, unit_key: String(h.unit_key) });
    }
  }
  return { units, heldBack };
}

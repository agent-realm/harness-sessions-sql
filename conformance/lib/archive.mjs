// The archive, read as spec §4.1 says a replay reads it, with no engine: the kit's own fold of
// session_units, the shape of every read manifest, and the manifests matched against the reads
// that the envelopes delivered.
//
// - foldArchive: for each source, the highest generation is current; a `source_gone` generation
//   replays as its policy says (`kept`: the last generation before it; `removed`, or no policy:
//   empty); within the current generation, the manifests folded in `progress` order, each adding
//   its `units` (in array order) and dropping its `gone`. What it gives is compared with the
//   oracle's units per source (lib/oracle.mjs, expectSources).
// - manifestProblems: every manifest row against §4.1's shape.
// - readProblems: every read that must leave a manifest (one that opens a generation, delivers a
//   unit or a gone key, or reports source_gone) has one with its content, in its order, in a new
//   generation when it opens one and in the same generation when it does not; a manifest no read
//   accounts for records nothing (no units, no gone keys, not source_gone).
//
// Rows whose `adapter` names an exemption of §4.8 are outside all three. A unit stored in several
// chunks (§4.1 `chunk`) is one unit here: its chunks are grouped by (unit_key, sha256).

import { sha256 } from './jcs.mjs';
import { sessionKeyOf, sessionKeyObject } from './keys.mjs';

export const EXEMPT = new Set(['memhouse-bridge', 'memhouse-log', 'legacy']);
// §4.1's list, plus `unchanged`, which the seam returns for a read with nothing new and which the
// kit accepts pending §4.1 (SPEC-QUESTIONS.md).
export const CONTINUITIES = new Set(['appended', 'delta', 'reset', 'snapshot', 'unchanged']);
const KEYS = ['progress', 'continuity', 'units', 'gone', 'source_gone'];
const SHA = /^[0-9a-f]{64}$/;
const SEP = '\u0000';

const isManifest = (r) => r.unit_key === '';
const sourceOf = (r) => `${sessionKeyOf(r)}${SEP}${r.source_key}`;
const show = (k) => k.replace(/\u0000/g, '/').slice(0, 200);
export const progressOf = (m) => (typeof m.progress === 'string' ? Number(m.progress) : m.progress);

// A manifest's raw, parsed; null when it is not a JSON object.
export function parseManifest(raw) {
  try {
    const m = JSON.parse(raw);
    return m && typeof m === 'object' && !Array.isArray(m) ? m : null;
  } catch {
    return null;
  }
}

// What is wrong with one manifest row (§4.1), as readable lines.
export function manifestProblems(rows) {
  const out = [];
  for (const r of rows) {
    if (!isManifest(r) || EXEMPT.has(r.adapter)) continue;
    const at = `manifest of ${show(sourceOf(r))} (generation ${r.generation})`;
    if (r.enc !== 'manifest') {
      out.push(`${at}: a row with unit_key '' whose enc is ${r.enc}, not manifest`);
      continue;
    }
    if (Number(r.chunk) !== 0) out.push(`${at}: chunk ${r.chunk}, not 0`);
    if (sha256(Buffer.from(String(r.raw), 'utf8')) !== r.sha256) out.push(`${at}: sha256 is not the sha256 of raw`);
    const m = parseManifest(r.raw);
    if (!m) {
      out.push(`${at}: raw is not a JSON object`);
      continue;
    }
    const missing = KEYS.filter((k) => !(k in m));
    if (missing.length) {
      out.push(`${at}: raw lacks ${missing.join(', ')}`);
      continue;
    }
    const p = progressOf(m);
    if (!Number.isSafeInteger(p) || p < 0 || (typeof m.progress === 'string' && !/^\d+$/.test(m.progress))) out.push(`${at}: progress ${JSON.stringify(m.progress)} is not a non-negative integer`);
    if (!CONTINUITIES.has(m.continuity)) out.push(`${at}: continuity ${JSON.stringify(m.continuity)} is not one of ${[...CONTINUITIES].join(', ')}`);
    if (r.continuity !== m.continuity) out.push(`${at}: the row's continuity ${r.continuity} differs from raw's ${m.continuity}`);
    if (!Array.isArray(m.units) || !m.units.every((u) => Array.isArray(u) && u.length === 2 && typeof u[0] === 'string' && u[0] !== '' && SHA.test(u[1]))) out.push(`${at}: units is not a list of [unit_key, sha256]`);
    if (!Array.isArray(m.gone) || !m.gone.every((k) => typeof k === 'string' && k !== '')) out.push(`${at}: gone is not a list of unit_keys`);
    if (typeof m.source_gone !== 'boolean') out.push(`${at}: source_gone is not a boolean`);
    if (m.source_gone === true) {
      if ('policy' in m && m.policy !== 'kept' && m.policy !== 'removed') out.push(`${at}: policy ${JSON.stringify(m.policy)} is not kept or removed`);
      if (m.units?.length || m.gone?.length) out.push(`${at}: a source_gone manifest lists units or gone keys`);
    } else if ('policy' in m) out.push(`${at}: policy appears without source_gone`);
    if (m.continuity === 'unchanged' && (m.units?.length || m.gone?.length)) out.push(`${at}: an unchanged read lists units or gone keys`);
  }
  return out;
}

// The archive folded as §4.1's replay: { sources: Map(sk -> Map(source_key -> Map(unit_key ->
// sha256))), problems }.
export function foldArchive(rows) {
  const problems = [];
  const bySource = new Map();
  for (const r of rows) {
    if (EXEMPT.has(r.adapter)) continue;
    const k = sourceOf(r);
    if (!bySource.has(k)) bySource.set(k, { sk: sessionKeyOf(r), source_key: r.source_key, gens: new Map() });
    const gens = bySource.get(k).gens;
    const g = Number(r.generation);
    if (!gens.has(g)) gens.set(g, { manifests: [], units: new Set() });
    if (!isManifest(r)) gens.get(g).units.add(`${r.unit_key}${SEP}${r.sha256}`);
    else if (r.enc === 'manifest') {
      const m = parseManifest(r.raw);
      if (m && Array.isArray(m.units) && Number.isFinite(progressOf(m))) gens.get(g).manifests.push({ m, sha: r.sha256 });
    }
  }
  const sources = new Map();
  for (const [k, { sk, source_key, gens }] of bySource) {
    const order = [...gens.keys()].sort((a, b) => a - b);
    const resolve = (g) => {
      const gen = gens.get(g);
      if (!gen.manifests.length) {
        problems.push(`${show(k)}: generation ${g} has units and no manifest, so a replay cannot tell what it holds`);
        return new Map();
      }
      const gone = gen.manifests.find(({ m }) => m.source_gone === true);
      if (gone) {
        if ((gone.m.policy ?? 'removed') !== 'kept') return new Map();
        const prev = order.filter((x) => x < g).at(-1);
        return prev === undefined ? new Map() : resolve(prev);
      }
      const ms = [...gen.manifests].sort((a, b) => progressOf(a.m) - progressOf(b.m));
      for (let i = 1; i < ms.length; i++) {
        if (progressOf(ms[i].m) === progressOf(ms[i - 1].m) && ms[i].sha !== ms[i - 1].sha) {
          problems.push(`${show(k)}: generation ${g} holds two different manifests at progress ${progressOf(ms[i].m)}, so their fold order is undefined`);
        }
      }
      const units = new Map();
      for (const { m } of ms) {
        for (const [uk, sha] of m.units) {
          units.set(uk, sha);
          if (!gen.units.has(`${uk}${SEP}${sha}`)) problems.push(`${show(k)}: a manifest of generation ${g} lists ${uk} (sha ${String(sha).slice(0, 12)}…), which that generation does not archive`);
        }
        for (const uk of m.gone ?? []) units.delete(uk);
      }
      return units;
    };
    if (!sources.has(sk)) sources.set(sk, new Map());
    sources.get(sk).set(source_key, resolve(order.at(-1)));
    // Every unit archived in a generation was delivered by a read of it, so a manifest lists it.
    for (const g of order) {
      const gen = gens.get(g);
      if (!gen.manifests.length) continue;
      const listed = new Set(gen.manifests.flatMap(({ m }) => m.units.map(([uk, sha]) => `${uk}${SEP}${sha}`)));
      for (const u of gen.units) if (!listed.has(u)) problems.push(`${show(k)}: generation ${g} archives ${u.split(SEP)[0]}, which no manifest of it lists`);
    }
  }
  return { sources, problems };
}

// The fold against the oracle's units per source (expectSources): readable differences.
export function diffSources(folded, expected, { label = '' } = {}) {
  const out = [];
  const pre = label ? `${label}: ` : '';
  for (const [sk, srcs] of expected) {
    for (const [source, want] of srcs) {
      const got = folded.get(sk)?.get(source);
      const where = `${pre}${show(`${sk}${SEP}${source}`)}`;
      if (!got) {
        out.push(`${where}: the archive holds no fold of this source`);
        continue;
      }
      const missing = [...want].filter(([uk, sha]) => got.get(uk) !== sha);
      const extra = [...got].filter(([uk]) => !want.has(uk));
      if (missing.length || extra.length) {
        out.push(`${where}: the archive folds to ${got.size} unit(s), the reads to ${want.size}: ${missing.length} missing or with another sha (e.g. ${missing[0]?.[0] ?? '-'}), ${extra.length} extra (e.g. ${extra[0]?.[0] ?? '-'})`);
      }
    }
  }
  for (const [sk, srcs] of folded) {
    for (const source of srcs.keys()) if (!expected.get(sk)?.has(source)) out.push(`${pre}${show(`${sk}${SEP}${source}`)}: archived, but no read delivered this source`);
  }
  return out;
}

const sameList = (a, b) => a.length === b.length && a.every(([k, s], i) => b[i][0] === k && b[i][1] === s);
const sameSet = (a, b) => a.length === b.length && new Set(a).size === new Set([...a, ...b]).size;

// Every read's manifest, matched in order: see the header.
export function readProblems(passes, rows) {
  const out = [];
  const manifests = new Map();
  for (const r of rows) {
    if (!isManifest(r) || r.enc !== 'manifest' || EXEMPT.has(r.adapter)) continue;
    const m = parseManifest(r.raw);
    if (!m || !Array.isArray(m.units)) continue;
    const k = sourceOf(r);
    if (!manifests.has(k)) manifests.set(k, []);
    manifests.get(k).push({ g: Number(r.generation), p: progressOf(m), m });
  }
  for (const list of manifests.values()) list.sort((a, b) => a.g - b.g || a.p - b.p);
  const reads = new Map();
  passes.forEach((pass, i) => {
    for (const e of pass) {
      const k = `${sessionKeyOf(sessionKeyObject(e.store, e.session))}${SEP}${e.source_key}`;
      if (!reads.has(k)) reads.set(k, []);
      reads.get(k).push({ e, pass: i + 1 });
    }
  });
  for (const [k, list] of reads) {
    const ms = manifests.get(k) ?? [];
    let at = 0;
    let lastG = null;
    let first = true;
    for (const { e, pass } of list) {
      const units = e.source_gone ? [] : e.read.units.map((u) => [u.unit_key, u.sha256]);
      const gone = e.source_gone ? [] : (e.read.gone ?? []);
      const c = e.source_gone ? null : e.read.continuity;
      // As the oracle folds a source (lib/oracle.mjs): its first read, a reset, a snapshot and a
      // vanished source each open a generation.
      const opens = first || !!e.source_gone || c === 'reset' || c === 'snapshot';
      first = false;
      const required = opens || units.length || gone.length;
      const matches = ({ m }) => (e.source_gone
        ? m.source_gone === true && (m.policy ?? 'removed') === e.policy
        : m.source_gone === false && m.continuity === c && sameList(m.units, units) && sameSet(m.gone ?? [], gone));
      let j = at;
      while (j < ms.length && !matches(ms[j])) j++;
      if (j >= ms.length) {
        if (required) out.push(`${show(k)}: pass ${pass}'s read (${e.source_gone ? `source_gone, policy ${e.policy}` : `${c}, ${units.length} unit(s), ${gone.length} gone`}) has no manifest that records it`);
        continue;
      }
      for (const skipped of ms.slice(at, j)) {
        if (skipped.m.units.length || skipped.m.gone?.length || skipped.m.source_gone) out.push(`${show(k)}: a manifest at generation ${skipped.g}, progress ${skipped.p} records a read no envelope delivered`);
      }
      const { g } = ms[j];
      if (lastG !== null && opens && !(g > lastG)) out.push(`${show(k)}: pass ${pass}'s read opens a generation, but its manifest is in generation ${g}, not after ${lastG}`);
      if (lastG !== null && !opens && g !== lastG) out.push(`${show(k)}: pass ${pass}'s read opens no generation, but its manifest is in generation ${g}, not ${lastG}`);
      lastG = g;
      at = j + 1;
    }
    for (const rest of ms.slice(at)) {
      if (rest.m.units.length || rest.m.gone?.length || rest.m.source_gone) out.push(`${show(k)}: a manifest at generation ${rest.g}, progress ${rest.p} records a read no envelope delivered`);
    }
  }
  for (const k of manifests.keys()) if (!reads.has(k)) out.push(`${show(k)}: manifests of a source no envelope delivered`);
  return out;
}

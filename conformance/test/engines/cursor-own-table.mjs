// A test engine that keeps its cursor outside session_sources (§4.6 allows it): the reference
// engine with its cursor in a table of its own, `<prefix>engine_cursor`. Its DDL still has an
// empty session_sources. It exposes the cursor as `cursor()`, so Crash-safe can check every stop,
// and must pass. A pass it has already applied (every read's position and units already in its
// cursor) it recognises and leaves alone, so running a pass again leaves no row behind.
// `variant` makes the other test engines: one that hides its cursor, and one that ignores every
// crash point after the archive write, which then only the cursor shows.
import * as reference from '../../reference/engine.mjs';
import { ddlStatements } from '../../lib/db.mjs';
import { jcs } from '../../lib/jcs.mjs';
import { sessionKeyOf, sessionKeyObject } from '../../lib/keys.mjs';

const CURSOR = 'engine_cursor';
const VOLATILE = new Set(['committed_at', 'writer', 'ver']);

// The namespace as the engine sees it: its session_sources is the table of its own.
function own(ns) {
  const name = `${ns.name}.${ns.prefix}${CURSOR}`;
  const view = Object.create(ns);
  view.qualify = (t) => (t === 'session_sources' ? name : ns.qualify(t));
  view.t = (t) => (t === 'session_sources' ? name : ns.t(t));
  view.tables = { ...ns.tables, session_sources: name };
  return view;
}

// Whether the cursor already holds every read of the pass: its position, its units, none of its
// gone keys.
async function applied(view, envelopes) {
  if (!envelopes.length || envelopes.some((e) => e.source_gone)) return false;
  const at = new Map((await view.present('session_sources')).map((r) => [`${sessionKeyOf(r)}\u0000${r.source_key}`, r]));
  return envelopes.every((e) => {
    const c = at.get(`${sessionKeyOf(sessionKeyObject(e.store, e.session))}\u0000${e.source_key}`);
    if (!c || c.position !== (e.read.position == null ? '' : jcs(e.read.position))) return false;
    const held = new Map(JSON.parse(c.state || '{}').units ?? []);
    return e.read.units.every((u) => held.get(u.unit_key) === u.sha256) && (e.read.gone ?? []).every((k) => !held.has(k));
  });
}

export function variant({ exposeCursor = true, honourStops = true } = {}) {
  return {
    name: 'cursor in a table of its own',
    version: reference.version,
    async createTables(opts) {
      await reference.createTables(opts);
      const view = own(opts.ns);
      const mine = ddlStatements(opts.ns.profile, { qualify: (t) => view.qualify(t) }).filter((s) => s.startsWith(`CREATE TABLE ${view.t('session_sources')}`));
      for (const s of mine) await opts.ns.exec(s);
    },
    createEngine(opts) {
      const view = own(opts.ns);
      const engine = reference.createEngine({ ...opts, ns: view });
      const pass = engine.pass.bind(engine);
      engine.pass = async (envelopes, o = {}) => {
        if (await applied(view, envelopes)) return {};
        return pass(envelopes, honourStops || o.crashAfter === 'archive' ? o : {});
      };
      if (exposeCursor) {
        engine.cursor = async () => (await view.present('session_sources'))
          .map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !VOLATILE.has(k))))
          .sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
      }
      return engine;
    },
  };
}

export const { name, version, createTables, createEngine } = variant();

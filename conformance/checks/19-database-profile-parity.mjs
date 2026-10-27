// §8: "Database profile parity: ClickHouse and PostgreSQL, fed the same envelopes, give the same
// current state, compared as sets of (key, content_sha), with message_content_sha added for
// session_parts. legacy rows are left out: they exist only in a ClickHouse database profile
// (§4.8)."
//
// The broad and rewind scenarios, each into one namespace per profile. Current state of every
// entity table, engine edges included, as (identity, content_sha[, message_content_sha]);
// identities compared as text, rows whose adapter is `legacy` left out.

import { idOf } from '../lib/state.mjs';
import { ENTITY_TABLES } from '../lib/keys.mjs';
import { verdict, skip } from '../lib/result.mjs';

export default {
  id: 'database-profile-parity',
  title: 'Database profile parity',
  both: true,
  faults: ['engine:pg-skew'],

  async engine(ctx) {
    if (!ctx.targets.clickhouse || !ctx.targets.postgres) return skip('needs both a ClickHouse and a PostgreSQL target');
    const problems = [];
    const notes = [];
    for (const name of ['broad', 'rewind']) {
      const sc = ctx.scenario(name);
      const sets = {};
      for (const profile of ['clickhouse', 'postgres']) {
        const ns = await ctx.namespace(profile);
        const engine = await ctx.engine(ns);
        for (const p of sc.passes) await engine.pass(p);
        sets[profile] = new Map();
        for (const t of ENTITY_TABLES) {
          const s = new Set();
          for (const r of await ns.current(t)) if (r.adapter !== 'legacy') s.add(`${idOf(t, r)}\u0001${r.content_sha}${t === 'session_parts' ? `\u0001${r.message_content_sha}` : ''}`);
          sets[profile].set(t, s);
        }
      }
      let n = 0;
      for (const t of ENTITY_TABLES) {
        const a = sets.clickhouse.get(t);
        const b = sets.postgres.get(t);
        n += a.size;
        const onlyA = [...a].filter((x) => !b.has(x));
        const onlyB = [...b].filter((x) => !a.has(x));
        if (onlyA.length || onlyB.length) problems.push(`${name}, ${t}: ${onlyA.length} only in ClickHouse, ${onlyB.length} only in PostgreSQL${onlyA[0] ? `; e.g. ${onlyA[0].replace(/[\u0000\u0001]/g, '/').slice(0, 160)}` : ''}`);
      }
      notes.push(`${name}: ${n} current rows compared`);
    }
    return verdict(problems, notes);
  },
};

// §8: "Host form: a row whose key host is not the sessions-model/host/v0 form (32 lowercase hex,
// or r- + 32 lowercase hex), such as a hostname, is rejected by both database profiles, unless its
// adapter is legacy (§4.8)."
//
// Database check, with plain SQL and synthetic rows, in every table with a key `host`:
// - accepted: 32 lowercase hex, and r- + 32 lowercase hex;
// - rejected: a hostname (my-laptop), uppercase hex, 31 hex digits;
// - in the entity tables, a hostname row whose adapter is `legacy` is accepted (§4.8);
// - session_links' reference hosts (other_host, child_host, origin_host) follow the same rule,
//   with '' (the stating session's own harness store) accepted.

import { insertRows } from '../lib/db.mjs';
import { syntheticRows, HOST_A } from '../envelopes.mjs';
import { verdict } from '../lib/result.mjs';

const ENTITY = ['sessions', 'session_parts', 'session_usage', 'session_links', 'session_lifecycle'];

export default {
  id: 'host-form',
  title: 'Host form',
  kind: 'database',
  faults: ['ddl:no-host-check'],

  async run(ctx) {
    const problems = [];
    const ns = await ctx.namespace();
    let n = 0;
    const attempt = async (table, row, wantAccepted, label) => {
      n++;
      let accepted = true;
      try {
        await insertRows(ns, table, [row]);
      } catch {
        accepted = false;
      }
      if (accepted !== wantAccepted) problems.push(`${table}: ${label} was ${accepted ? 'accepted' : 'rejected'}`);
    };
    const tables = ['session_units', 'session_sources', ...ENTITY];
    let i = 0;
    for (const table of tables) {
      const base = (host, extra = {}) => {
        if (table === 'session_sources') return { host, harness: 'kit-harness', harness_path: '/home/user/.kit', session_id: `kit-s${++i}`, incarnation: '', source_key: 'kit.jsonl', mode: 'stream', generation: 1, progress: 1, state_ver: 1, adapter: 'kit-adapter', adapter_ver: 1, ...extra };
        return { ...syntheticRows({ host })[table], session_id: `kit-s${++i}`, ...extra };
      };
      await attempt(table, base(HOST_A), true, 'a host/v0 value');
      await attempt(table, base(`r-${'0123456789abcdef'.repeat(2)}`), true, 'an r- value');
      await attempt(table, base('my-laptop'), false, "the hostname 'my-laptop'");
      await attempt(table, base(HOST_A.toUpperCase()), false, 'uppercase hex');
      await attempt(table, base(HOST_A.slice(1)), false, '31 hex digits');
      if (ENTITY.includes(table)) await attempt(table, base('my-laptop', { adapter: 'legacy' }), true, "a legacy row keyed by 'my-laptop'");
    }
    for (const c of ['other_host', 'child_host', 'origin_host']) {
      const row = (v, extra = {}) => ({ ...syntheticRows({ host: HOST_A }).session_links, session_id: `kit-l${++i}`, [c]: v, ...extra });
      await attempt('session_links', row(''), true, `${c} ''`);
      await attempt('session_links', row(HOST_A), true, `${c} a host/v0 value`);
      await attempt('session_links', row('my-laptop'), false, `${c} 'my-laptop'`);
      await attempt('session_links', row('my-laptop', { adapter: 'legacy' }), true, `${c} 'my-laptop' on a legacy row`);
    }
    return verdict(problems, [`${n} inserts across ${tables.length} tables`]);
  },
};

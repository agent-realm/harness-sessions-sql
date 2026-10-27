// §8: "Registries take new values: a row whose harness, ts_source or enc is a value neither
// database profile has seen is accepted by both, and kept as given."
//
// Database check: synthetic rows with registry values no adapter emits are inserted with plain
// SQL into sessions (harness, ts_source) and session_units (harness, enc), and read back.

import { insertRows } from '../lib/db.mjs';
import { syntheticRows } from '../envelopes.mjs';
import { verdict } from '../lib/result.mjs';

const NEW = { harness: 'kit-new-harness-9', ts_source: 'kit-new-ts-source', enc: 'kit-new-enc' };

export default {
  id: 'registries-take-new-values',
  title: 'Registries take new values',
  faults: ['ddl:registry-enum'],

  async database(ctx) {
    const problems = [];
    const ns = await ctx.namespace();
    const rows = syntheticRows(NEW);
    for (const table of ['sessions', 'session_units']) {
      try {
        await insertRows(ns, table, [rows[table]]);
      } catch (e) {
        problems.push(`${table}: the row was refused: ${e.message.slice(0, 200)}`);
        continue;
      }
      const got = await ns.present(table, `session_id = 'kit-session-1'`);
      if (got.length !== 1) problems.push(`${table}: ${got.length} rows read back`);
      for (const c of table === 'sessions' ? ['harness', 'ts_source'] : ['harness', 'enc']) {
        if (got[0] && got[0][c] !== NEW[c]) problems.push(`${table}.${c}: read back '${got[0][c]}', written '${NEW[c]}'`);
      }
    }
    return verdict(problems, [`harness '${NEW.harness}', ts_source '${NEW.ts_source}', enc '${NEW.enc}'`]);
  },
};

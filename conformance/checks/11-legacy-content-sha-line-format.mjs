// §8: "Legacy content_sha, line format (ClickHouse database profile): each of §4.8's known-answer
// vectors (column values, their TabSeparated line, its sha) gives the same sha through the
// implementation's SQL."
//
// The vectors are read from §4.8 itself. Each line's bytes are hashed outside SQL first (a vector
// that disagrees with itself fails), then the implementation's SQL (the engine's `legacySha`) is
// run with the settings §4.8 pins, for the line and its sha. An engine with no legacySha has
// proved nothing here, so the check is skipped for it. Legacy conversion exists only for
// ClickHouse houses (§4.8), so the item is a ClickHouse database profile item: on PostgreSQL it
// does not apply.

import { knownAnswerVectors } from '../lib/spec.mjs';
import { sha256 } from '../lib/jcs.mjs';
import { verdict, na, skip } from '../lib/result.mjs';
import { NO_LEGACY_SQL } from './12-legacy-content-sha-whole-rows.mjs';

export default {
  id: 'legacy-content-sha-line-format',
  title: 'Legacy content_sha, line format',
  faults: ['engine:sql-tsv-no-trim'],
  profiles: ['clickhouse'],

  // An engine part: what it proves is the implementation's SQL, not its DDL.
  async engine(ctx) {
    if (ctx.profile !== 'clickhouse') return na('a ClickHouse database profile item (§8): legacy conversion exists only for ClickHouse houses (§4.8)');
    const problems = [];
    const ns = await ctx.namespace();
    const engine = await ctx.engine(ns);
    if (typeof engine.legacySha !== 'function') return skip(NO_LEGACY_SQL);
    const vectors = knownAnswerVectors();
    for (const v of vectors) {
      if (sha256(Buffer.from(v.line, 'utf8')) !== v.sha256) problems.push(`vector ${v.exprs.join(', ')}: its line does not hash to its sha outside SQL`);
      const q = engine.legacySha(v.exprs);
      const [row] = await ns.query(`SELECT ${q.line} AS line, ${q.sql} AS sha`, { settings: q.settings });
      if (row.line !== v.line) problems.push(`vector ${v.exprs.join(', ')}: the line is ${JSON.stringify(row.line)}, §4.8 says ${JSON.stringify(v.line)}`);
      if (row.sha !== v.sha256) problems.push(`vector ${v.exprs.join(', ')}: sha ${row.sha}, §4.8 says ${v.sha256}`);
    }
    return verdict(problems, [`${vectors.length} known-answer vectors from §4.8`]);
  },
};

// PostgreSQL through `pg`, the kit's one dependency.

import pg from 'pg';
import { DbError } from './ch.mjs';

// timestamptz and timestamp come back as their text, not as a Date in the local zone, so a row
// read and written back is unchanged; int8 and numeric stay strings (exact).
pg.types.setTypeParser(1184, (v) => v);
pg.types.setTypeParser(1114, (v) => v);

export class Postgres {
  constructor({ url }) {
    this.pool = new pg.Pool({ connectionString: url, max: 2, idleTimeoutMillis: 2000 });
    this.pool.on('error', () => {});
  }

  async query(sql, params = []) {
    try {
      const r = await this.pool.query(sql, params);
      return r.rows;
    } catch (e) {
      if (e.code === 'ECONNREFUSED' || e.code === 'ENOTFOUND') throw new DbError(`PostgreSQL unreachable: ${e.code}`, { sql });
      throw new DbError(e.message, { sql, status: e.code });
    }
  }

  async exec(sql, params = []) {
    await this.query(sql, params);
  }

  async close() {
    await this.pool.end();
  }
}

export function pgString(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

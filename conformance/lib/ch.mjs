// ClickHouse over its HTTP interface, with fetch: no driver. Credentials travel in the
// X-ClickHouse-User / X-ClickHouse-Key headers and are never logged.

export class DbError extends Error {
  constructor(message, { status, sql } = {}) {
    super(message);
    this.status = status;
    this.sql = sql;
  }
}

// Read settings: 64-bit integers as strings (exact), named tuples as objects.
const READ = { output_format_json_quote_64bit_integers: 1, output_format_json_named_tuples_as_objects: 1 };
// Write settings: named tuples from objects, ISO timestamps accepted, and no silent default for
// a null sent to a column that is not Nullable (a writer bug must fail, not turn into a zero).
const WRITE = { input_format_json_named_tuples_as_objects: 1, date_time_input_format: 'best_effort', input_format_null_as_default: 0 };

export class ClickHouse {
  constructor({ url, user = '', password = '' }) {
    this.url = url.replace(/\/+$/, '');
    this.user = user;
    this.password = password;
  }

  headers() {
    const h = { 'Content-Type': 'text/plain; charset=utf-8' };
    if (this.user) h['X-ClickHouse-User'] = this.user;
    if (this.password) h['X-ClickHouse-Key'] = this.password;
    return h;
  }

  // One statement. With `body`, the statement goes in the URL and `body` is its data (INSERT).
  async request(sql, { body, settings = {}, database } = {}) {
    const params = new URLSearchParams();
    if (database) params.set('database', database);
    for (const [k, v] of Object.entries(settings)) params.set(k, String(v));
    let payload = sql;
    if (body !== undefined) {
      params.set('query', sql);
      payload = body;
    }
    let res;
    try {
      res = await fetch(`${this.url}/?${params}`, { method: 'POST', headers: this.headers(), body: payload });
    } catch (e) {
      throw new DbError(`ClickHouse unreachable: ${e.cause?.code ?? e.message}`, { sql });
    }
    const text = await res.text();
    if (!res.ok) throw new DbError(text.trim().split('\n')[0].slice(0, 2000), { status: res.status, sql });
    return text;
  }

  async exec(sql, opts = {}) {
    await this.request(sql, opts);
  }

  async query(sql, opts = {}) {
    const text = await this.request(`${sql}\nFORMAT JSONEachRow`, { ...opts, settings: { ...READ, ...opts.settings } });
    return text.split('\n').filter((l) => l !== '').map((l) => JSON.parse(l));
  }

  async insert(table, rows, { settings = {} } = {}) {
    if (!rows.length) return;
    const body = rows.map((r) => JSON.stringify(r)).join('\n');
    await this.request(`INSERT INTO ${table} FORMAT JSONEachRow`, { body, settings: { ...WRITE, ...settings } });
  }

  // Raw INSERT data in another format (TabSeparated, for the legacy line vectors).
  async insertFormat(table, columns, format, data, { settings = {} } = {}) {
    await this.request(`INSERT INTO ${table} (${columns.join(', ')}) FORMAT ${format}`, { body: data, settings });
  }

  async close() {}
}

// A ClickHouse string literal.
export function chString(s) {
  return `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

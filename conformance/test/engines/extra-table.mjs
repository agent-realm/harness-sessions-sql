// A test engine whose own DDL also makes a table of the consumer's own beside the §3 tables (a
// table of tool calls, §3: "a consumer's own tables beside these … are its own business"), with a
// `ts` that is not Nullable, partitioned by month in ClickHouse. No time partition must leave it
// alone and pass.
import * as reference from '../../reference/engine.mjs';

export const { name, version, createEngine } = reference;

export async function createTables(opts) {
  await reference.createTables(opts);
  const { ns } = opts;
  const t = `${ns.name}.${ns.prefix}tool_calls`;
  await ns.exec(ns.profile === 'clickhouse'
    ? `CREATE TABLE ${t} (host String, call_id String, ts DateTime64(3, 'UTC')) ENGINE = MergeTree PARTITION BY toYYYYMM(ts) ORDER BY (host, call_id)`
    : `CREATE TABLE ${t} (host text, call_id text, ts timestamptz NOT NULL, PRIMARY KEY (host, call_id))`);
}

// Example 02: runs clickhouse.sql or postgres.sql in a fresh namespace holding schema/'s tables.
// See README.md.
import { runSqlExample } from '../lib/sql.mjs';

await runSqlExample(import.meta.url, { clickhouse: 'clickhouse.sql', postgres: 'postgres.sql' });

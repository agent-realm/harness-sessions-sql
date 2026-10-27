// Example 01: runs clickhouse.sql in a fresh ClickHouse database holding schema/clickhouse.sql's
// tables. See README.md.
import { runSqlExample } from '../lib/sql.mjs';

await runSqlExample(import.meta.url, { clickhouse: 'clickhouse.sql' });

# 02. Revisions and removals

SQL only, in both database profiles. One session record goes through a revision, a late re-send
of an older version, a removal, and, beside it, a true duplicate that is deleted physically. After
each step the example reads what a reader sees. [`clickhouse.sql`](clickhouse.sql) and
[`postgres.sql`](postgres.sql) tell the same story, each in its profile's own SQL, and print the
same output.

## What it shows

- **Every version is a whole row with a `rev`.** A changed row takes a strictly higher `rev`, and a
  row with a lower or equal `rev` never replaces a higher one ([§2], principle 4). In ClickHouse
  each version is a plain `INSERT`, and `ReplacingMergeTree(rev, is_deleted)` keeps the highest
  `rev` per key. In PostgreSQL each is the profile's upsert, `INSERT … ON CONFLICT (primary key) DO
  UPDATE SET <every non-key column> = EXCLUDED.<column> WHERE EXCLUDED.rev > sessions.rev`, which
  refuses the late re-send ([§3]).
- **A key that left `live` is not deleted: it gets a removed version**, a full copy of its last row
  at a higher `rev` with `removed = 1` and `is_deleted = 0`. It leaves the current state and stays
  readable as history ([§2], principle 3; [§6]).
- **Physical deletion is only for true duplicates** (and keys an upgraded adapter no longer
  produces): `is_deleted = 1` at a higher `rev` in ClickHouse, which `FINAL` drops, and `DELETE` in
  PostgreSQL. A deleted row is in neither the current state nor the history ([§2], principle 3).
- **What a reader filters on** ([§6]): the current state is `is_deleted = 0 AND removed = 0` (with
  `FINAL` in ClickHouse; `NOT is_deleted AND removed = 0` in PostgreSQL), the history of removed
  content `removed = 1`.

Without `FINAL`, a ClickHouse reader can see several versions of one key until a merge collapses
them, so the example always reads with it. As in [example 01](../01-one-message/), the host is the
host/v0 value of a synthetic machine id, and the shas are stand-ins of the right length.

## Spec sections

- [§2 Core principles][§2]: principle 3 (removed content is kept) and principle 4 (revisions only
  go forward).
- [§3 Keys and versioning][§3]: the ClickHouse engine and the PostgreSQL write rule.
- [§6 Reading][§6]: current state and removed content.

## What it needs

- A ClickHouse target (`SSQL_CH_URL`, with `SSQL_CH_USER` and `SSQL_CH_PASSWORD`), a PostgreSQL
  target (`SSQL_PG_URL`), or both, from the environment as the conformance kit takes them. Point
  them only at a disposable deployment.
- Node.js 24, and the kit's one dependency (`npm ci` in `conformance/`).

The example creates a database (ClickHouse) or schema (PostgreSQL) of its own, loads `schema/` in
it, and drops it when it ends, fails or is interrupted.

## Run it

From the repository root:

```sh
(cd conformance && npm ci)
SSQL_CH_URL=http://localhost:8123 SSQL_CH_USER=kit SSQL_CH_PASSWORD=… \
  node examples/02-revisions-and-removals/example.mjs --profile clickhouse
SSQL_PG_URL=postgres://kit:…@localhost:5432/kit \
  node examples/02-revisions-and-removals/example.mjs --profile postgres
```

By hand, against an empty database or schema of your own:

```sh
clickhouse-client --database my_db --multiquery < schema/clickhouse.sql
clickhouse-client --database my_db --multiquery < examples/02-revisions-and-removals/clickhouse.sql

psql "$MY_PG_URL" -c 'CREATE SCHEMA my_schema'
PGOPTIONS='-c search_path=my_schema' psql "$MY_PG_URL" -f schema/postgres.sql
PGOPTIONS='-c search_path=my_schema' psql "$MY_PG_URL" -f examples/02-revisions-and-removals/postgres.sql
```

## Expected output

Both profiles print the same lines.

<!-- expected: clickhouse, postgres -->
```text
after the revision, the current state:
  session_id         title         rev
  example-session-1  Release plan  2
after the late re-send of rev 1, the current state:
  session_id         title         rev
  example-session-1  Release plan  2
after the removal, the current state:
  (no rows)
after the removal, the removed versions (history: removed = 1):
  session_id         title         rev  removed
  example-session-1  Release plan  3    1
with the duplicate written, every row a reader can see (current and removed):
  session_id         title         rev  removed
  example-session-1  Release plan  3    1
  example-session-2  Duplicate     1    0
after the duplicate's physical deletion, every row a reader can see:
  session_id         title         rev  removed
  example-session-1  Release plan  3    1
```

[§2]: ../../01-SESSIONS-SQL-SPEC.md#2-core-principles
[§3]: ../../01-SESSIONS-SQL-SPEC.md#3-keys-and-versioning
[§6]: ../../01-SESSIONS-SQL-SPEC.md#6-reading-extraction

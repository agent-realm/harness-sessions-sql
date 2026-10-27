# 01. One session, one message

The smallest example: SQL only, in the ClickHouse database profile. It writes one session and one
message by hand into the tables of [`schema/clickhouse.sql`](../../schema/clickhouse.sql), reads
them back as a reader reads the current state, removes the message, and shows the DDL refusing a
hostname as `host`.

## What it shows

- Every row carries the session key `(host, harness, harness_path, session_id, incarnation)`, and
  every table's key starts with it ([§3]).
- A message is one row of `session_parts` per part, and each row carries its message's columns
  (`role`, `status`, `ts`, …) beside the part's (`kind`, `text`) ([§3], [§4.3]).
- The current state is read with `FINAL`, keeping `is_deleted = 0` and `removed = 0` ([§6]).
  `argMax(…, rev)` reads the same state without `FINAL` ([§3], ClickHouse).
- **With `argMax`, the filter goes in `HAVING`.** `argMax(removed, rev)` is the flag of the
  latest version of a key, which is the one that decides. Once the message leaves `live` and gets
  a removed version (a full copy of its last row at a higher `rev`, `removed = 1`: [§2],
  principle 3), the `HAVING` read shows no message, while the same filter in `WHERE` drops the
  removed version before `argMax` picks one and brings the older version back as if it were
  current.
- `host` is a host/v0 value (here of the synthetic machine id `0e0e0e0e0e0e4e0e8e0e0e0e0e0e0e01`),
  never a hostname: the DDL's `host_form` constraint refuses `my-laptop` ([§2], principle 2). The
  example checks that the refusal is the constraint's (ClickHouse code 469), and writes the same
  row with a host/v0 value as a control, which is accepted.

The rows' shas are stand-ins of the right length (`repeat('a', 64)`): a writer computes each
`content_sha` from its record ([§4]), as [example 03](../03-records-to-rows/) does.

The statements are in [`clickhouse.sql`](clickhouse.sql); [`example.mjs`](example.mjs) runs them in
a fresh database through [`../lib/sql.mjs`](../lib/sql.mjs).

## Spec sections

- [§2 Core principles][§2]: principle 2 (keys from the contract, and the host form) and
  principle 3 (a removed version).
- [§3 Keys and versioning][§3]: the session key, one table for messages and parts, `FINAL` or
  `argMax` in ClickHouse.
- [§4.3 `session_parts`][§4.3]: a part row and its message's columns.
- [§6 Reading][§6]: the current state.

## What it needs

- A ClickHouse target, from the environment, as the conformance kit takes it: `SSQL_CH_URL`, with
  `SSQL_CH_USER` and `SSQL_CH_PASSWORD`. Point it only at a disposable deployment, such as the one
  [`conformance/compose.yml`](../../conformance/compose.yml) starts.
- Node.js 24, and the kit's one dependency (`npm ci` in `conformance/`).

The example creates a database of its own, loads `schema/clickhouse.sql` in it, and drops it when
it ends, fails or is interrupted.

## Run it

From the repository root:

```sh
(cd conformance && npm ci)
SSQL_CH_URL=http://localhost:8123 SSQL_CH_USER=kit SSQL_CH_PASSWORD=… \
  node examples/01-one-message/example.mjs --profile clickhouse
```

The same SQL runs by hand in `clickhouse-client`, against an empty database of your own: load the
DDL, then the file. The client prints the rows in its own format. It stops at the statement the
database refuses on purpose, unless `--ignore-error` lets it go on to the control.

```sh
clickhouse-client --database my_db --multiquery < schema/clickhouse.sql
clickhouse-client --database my_db --multiquery --ignore-error < examples/01-one-message/clickhouse.sql
```

## Expected output

<!-- expected: clickhouse -->
```text
the session, current state:
  session_id         title        state   rev
  example-session-1  Hello world  active  1
its message, current state, in order:
  message_id  part_id  role  kind  text        ts
  m-1         0        user  text  Say hello.  2026-01-02T09:00:00.000Z
its message, current state, read with argMax:
  message_id  part_id  current_text  current_rev
  m-1         0        Say hello.    1
after the removal, read with argMax and the filter in HAVING (no message is current):
  (no rows)
after the removal, the filter in WHERE instead (wrong, rev 1 comes back):
  message_id  part_id  current_text  current_rev
  m-1         0        Say hello.    1
a session whose host is a hostname: refused
the same row with a host/v0 value is accepted, the sessions now:
  session_id         title        host
  example-session-1  Hello world  dd20281dfd2171973d41a8686efeb11e
  example-session-2  Hello again  dd20281dfd2171973d41a8686efeb11e
```

[§2]: ../../01-SESSIONS-SQL-SPEC.md#2-core-principles
[§3]: ../../01-SESSIONS-SQL-SPEC.md#3-keys-and-versioning
[§4]: ../../01-SESSIONS-SQL-SPEC.md#4-schema
[§4.3]: ../../01-SESSIONS-SQL-SPEC.md#43-session_parts
[§6]: ../../01-SESSIONS-SQL-SPEC.md#6-reading-extraction

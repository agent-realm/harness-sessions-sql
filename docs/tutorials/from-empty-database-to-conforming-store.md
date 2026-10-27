# From an empty database to a conforming store

One path through sessions-sql, in six steps: start a disposable database, load the DDL, write and
read rows by the read rules, archive raw units and rebuild from them, run an engine, and check it
with the conformance kit. Each step runs one of the [examples](../../examples/README.md) and says
what to look for. The examples' READMEs hold the full output, and the
[specification](../../01-SESSIONS-SQL-SPEC.md) holds the rules: read the linked section beside each
step.

Run every command from the repository root, with Node.js 24.

## 1. A disposable database pair

The kit's [`compose.yml`](../../conformance/compose.yml) starts a ClickHouse and a PostgreSQL on
this machine, on `127.0.0.1` only ([conformance/README.md, A disposable pair][pair]). Every step
below creates and drops namespaces of its own there, so point it at nothing you want to keep.

```sh
export SSQL_KIT_PASSWORD=…    # a password of your own, with no character a URL must encode
(cd conformance && npm ci && docker compose up -d)
export SSQL_CH_URL=http://localhost:8123 SSQL_CH_USER=kit SSQL_CH_PASSWORD="$SSQL_KIT_PASSWORD"
export SSQL_PG_URL="postgres://kit:$SSQL_KIT_PASSWORD@localhost:5432/kit"
```

The servers take a few seconds to start. Wait until both answer before step 2:

```sh
until curl -sf http://localhost:8123/ping; do sleep 1; done
until (cd conformance && docker compose exec postgres pg_isready -U kit -d kit); do sleep 1; done
```

ClickHouse answers `Ok.`, and `pg_isready` reports that PostgreSQL is accepting connections.

When you are done, with `SSQL_KIT_PASSWORD` still set: `(cd conformance && docker compose down -v)`.

## 2. Load the DDL, write one session, read it back

[Example 01](../../examples/01-one-message/) loads [`schema/clickhouse.sql`](../../schema/clickhouse.sql)
into an empty database and writes one session and one message by hand.

```sh
node examples/01-one-message/example.mjs --profile clickhouse
```

Look for: the session and its message read back with `FINAL`; no message current after its
removal; the `WHERE` placement bringing rev 1 back on the inline versions; and
`a session whose host is a hostname: refused`. Read [§3 Keys and versioning][s3] (the session key,
one table for messages and parts) and [§6 Reading][s6]. The read rules have a guide of their own:
[Read the current state](../guides/read-the-current-state.md).

## 3. Revisions and removals, in both profiles

[Example 02](../../examples/02-revisions-and-removals/) takes one session through a revision, a
late re-send, a removal and a physical deletion, in each profile's SQL.

```sh
node examples/02-revisions-and-removals/example.mjs --profile postgres
```

Look for: rev 2 still current after the late re-send of rev 1; `(no rows)` in the current state
after the removal, and the removed version (`removed = 1`, rev 3) in the history; the same lines
with `--profile clickhouse`. Read [§2 Core principles][s2], principles 3 and 4.

## 4. Records in, rows out

[Example 03](../../examples/03-records-to-rows/) maps a few synthetic sessions-model records to rows
with the reference mapping and runs the common reads: a session whole, its parts in order, a tool
call with its result, the usage totals.

```sh
node examples/03-records-to-rows/example.mjs --profile clickhouse
```

Look for: `rows written: sessions 1, session_parts 5, session_usage 2` (a message with two parts
is two rows), and the shas of a message's two rows, checked against its records. Read
[§4 Schema][s4] (`content_sha` and `message_content_sha`) and [§4.3][s43].

## 5. Archive the raw units, rebuild from them

[Example 04](../../examples/04-raw-and-derived/) runs the reference engine over a toy harness store:
it archives every raw unit and a read manifest per read, then rebuilds the entity tables in a fresh
namespace from `session_units` alone.

```sh
node examples/04-raw-and-derived/example.mjs --profile postgres
```

Look for: generation 2 opening at the rewind, the removed versions of `m-3` and `m-4`, and
`the replayed tables match the live ones, removed versions included`. Read
[§2 Core principles][s2], principle 1, and [§4.1 `session_units`][s41].

## 6. Run an engine, then the kit

[Example 05](../../examples/05-full-blown/) reads three fixture harness stores through the real
session adapters, writes them with the reference engine, reads the current state back, and runs
the conformance kit against the same target. It needs a checkout of the session-adapters package
at 1.0.0, named by `SSQL_ADAPTERS` (its README gives both ways to get the package); here, cloned
beside this repository:

```sh
git clone https://github.com/agent-realm/harness-skeleton ../harness-skeleton
git -C ../harness-skeleton checkout 5ab0659
export SSQL_ADAPTERS=$PWD/../harness-skeleton/packages/session-adapters
node examples/05-full-blown/example.mjs --profile clickhouse
```

Look for: one OpenCode subagent edge, `stated_on` both; one line per §8 item, each `pass` (the
parity item `not run` under `--profile`); `the kit exited 0`. Then run the kit itself, on both
profiles at once, so that database profile parity runs too:

```sh
node conformance/run.mjs
```

Look for the verdict on the last line, `exit 0: … row(s) checked`. Read [§5 Writing][s5] and
[§8 Conformance][s8]. To check an engine of your own, see
[Run the conformance kit against your engine](../guides/run-the-conformance-kit-against-your-engine.md).

[pair]: ../../conformance/README.md#a-disposable-pair
[s2]: ../../01-SESSIONS-SQL-SPEC.md#2-core-principles
[s3]: ../../01-SESSIONS-SQL-SPEC.md#3-keys-and-versioning
[s4]: ../../01-SESSIONS-SQL-SPEC.md#4-schema
[s41]: ../../01-SESSIONS-SQL-SPEC.md#41-session_units--the-archive
[s43]: ../../01-SESSIONS-SQL-SPEC.md#43-session_parts
[s5]: ../../01-SESSIONS-SQL-SPEC.md#5-writing-the-engines-side-of-the-seam
[s6]: ../../01-SESSIONS-SQL-SPEC.md#6-reading-extraction
[s8]: ../../01-SESSIONS-SQL-SPEC.md#8-conformance

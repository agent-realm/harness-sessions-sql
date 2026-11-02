# Changelog

All notable changes to harness-sessions-sql are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Version numbers match the
specification's: the first release, 1.0.0, is its v1.

## [Unreleased]

- **v1.1: native fields, unit pointers and a turns view**, from the proposal in
  [`docs/design/v1.1-native-fields-unit-pointers-turns.md`](docs/design/v1.1-native-fields-unit-pointers-turns.md).
  Additive: a v1 reader is unaffected.
  - **Five columns** hold sessions-model v1.4.3's `native` and `units` (§2.7): `native` and
    `units` in `sessions` (§4.2), `message_native`, `message_units` and `part_native` in
    `session_parts` (§4.3). `native` is canonical JSON text in ClickHouse (`''` when absent) and
    `jsonb` in PostgreSQL (null when absent); `units` is an array of named tuples in ClickHouse and
    a `jsonb` array in PostgreSQL, `[]` when absent. `units` stays outside `content_sha`.
  - **The legacy line** (§4.8) leaves the five columns out, so the known-answer vectors and every
    row converted under v1 keep their sha.
  - **Reading** (§6): a record's units join `session_units` with a `LEFT JOIN`; `session_turns`,
    one row per turn of a session, is a parameterized view in ClickHouse
    (`schema/clickhouse-views.sql`) and a SQL function in PostgreSQL
    (`schema/postgres-views.sql`), (plan) until measured on a house of realistic size.
  - **Two §8 items, two kit checks:** Native is declared (`20-native-is-declared`) and Units
    resolve (`21-units-resolve`), each with two reference-engine faults for the self-test.
  - **Example 06**, turns and a native field read through its units, on both database profiles.
  - **The examples and the kit read harness-session-adapters 1.1.0** (harness-skeleton
    `e1e5900`), in CI as well; example 05's expected output is 1.1.0's, with the two new items.
  - **CI prints each example's whole output when the examples fail**, to compare with its README.
- **CI runs the conformance kit and the examples** against a disposable ClickHouse 26.8 and
  PostgreSQL 16 on every pull request and push to `main` (`.github/workflows/conformance.yml`,
  checks `kit` and `examples`), on GitHub-hosted runners, with no secrets. No table, column, key or
  check changes.

## [1.0.1] - 2026-10-28

- **The specification is renamed harness-sessions-sql**, with its repository, and cites the
  session adapters by their package name, `@agent-realm/harness-session-adapters`
  (`packages/harness-session-adapters` in harness-skeleton). Text only: no table, column, key or
  check changes. The SQL identifiers, the specification's file name (`01-SESSIONS-SQL-SPEC.md`), the
  conformance environment variables (`SSQL_*`) and the kit's database prefix (`ssql_conf_`) keep
  their names.

## [1.0.0] - 2026-10-27

The first release.

**Status.** The specification is v1, accepted. It consumes sessions-model v1.3 (the records) and
sessions v1.3 (the seam), or any later v1.x. Its conformance state, that of the reference engine and
of memhouse, the first production implementation, is in [§9](01-SESSIONS-SQL-SPEC.md#9-status).

### Added

- **The specification v1**, [`01-SESSIONS-SQL-SPEC.md`](01-SESSIONS-SQL-SPEC.md): the tables of
  sessions-model v1.3's records and their keys, revisions and removed versions, the raw archive and
  replay from it, writing and reading, and the conformance items of §8.
- **Two database profiles**: [`schema/clickhouse.sql`](schema/clickhouse.sql), the normative one,
  and [`schema/postgres.sql`](schema/postgres.sql), over the same logical tables.
- **The conformance kit**, [`conformance/`](conformance/README.md): the 19 items of §8, run against
  a ClickHouse or PostgreSQL target taken from the environment, with a self-test that holds each
  check to the faults it exists to catch, and the [reference engine](conformance/reference/engine.mjs).
- **Examples**, [`examples/`](examples/README.md): five, from one session written by hand in SQL to
  the reference engine checked by the kit, each with its expected output, and one test that runs
  them all.
- **Documentation**, [`docs/`](docs/README.md): a tutorial, from an empty database to a conforming
  store, and guides to running the kit against your engine, reading the current state, and adding
  a column without breaking conformance.
- **Open questions**, [`conformance/SPEC-QUESTIONS.md`](conformance/SPEC-QUESTIONS.md): the points
  the kit and the reviews raised against the specification, each with what the kit does about it;
  19 to 28 and 31 to 36 are open in v1.

[1.0.1]: https://github.com/agent-realm/harness-sessions-sql/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/agent-realm/harness-sessions-sql/releases/tag/v1.0.0

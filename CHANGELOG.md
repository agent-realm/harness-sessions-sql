# Changelog

All notable changes to harness-sessions-sql are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Version numbers match the
specification's: the first release, 1.0.0, is its v1.

## [Unreleased]

- **Status (§9): memhouse 0.20.2 against v1.1.1**, on ClickHouse 26.7 and 25.11: 24 rows pass,
  Native is declared and Units resolve included; Crash-safe fails in the case SPEC-QUESTIONS.md
  question 20 leaves open; two Absences replay parts are n/a. Also `session_turns` timed on
  ClickHouse over 2,000,000 rows, as indicative numbers. PostgreSQL's form is not measured at
  size, so it stays (plan). No specification, table, column or key changes.

## [1.1.1] - 2026-11-03

- **Only the order of a source's generations is significant** (§4.1), after sessions v1.4.4. The
  consumer numbers a source's generations: each one it opens is higher than every one before it,
  and the first may be any number. A reader relies on their order and on a generation's identity
  in the session's own archive, never on its value. Backward compatible: an engine that starts at
  1 still conforms, and an archive whose sources start at 0 conforms without renumbering.
  - **Units resolve** compares a triple's generation by its rank among the source's generations
    in the engine's archive, manifests included, so the kit no longer requires the first one to
    be 1. A triple that names another generation of the source than its unit's still fails.
  - **The reference engine** takes a `firstGeneration` option (default 1). Two test engines use
    it: one that numbers generations from 0, which the kit accepts, and the same with every triple
    one generation ahead, which fails Units resolve.
  - **The kit's docs** say that `SSQL_ADAPTERS` must name a source checkout of the
    harness-session-adapters package for the fixture-based checks: the published npm package
    ships no `fixtures/`.
- **Kit: a kept source's units name the generation that holds them.** A source that vanishes under
  `kept` opens a generation that archives only its manifest; its units stay in the generation
  before it, which replay takes as current (§4.1), and a record's `units` name that one (sessions
  §2: a triple takes the source's generation as derive's input gives it). The kit's expectation
  and the reference engine, live and in replay, named the vanishing's generation instead. Units
  resolve did not see it, because it ran on the broad scenario alone, where no source vanishes.
  - **Units resolve** also runs a `kept` vanish, judged live and after a replay from
    `session_units` alone, when the engine implements `kept`; and a new reference-engine fault,
    `kept-units-gone-generation`, is its positive control.
  - **Its failures print their full count** (the first 20, then "… and N more"), no longer capped
    at 50.
  - In the kit's expectation, a source read again after it vanished opens a generation, as the
    reference engine does. No scenario reads one yet.
  - No table, column or key changes.

## [1.1.0] - 2026-11-02

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

[Unreleased]: https://github.com/agent-realm/harness-sessions-sql/compare/v1.1.1...HEAD
[1.1.1]: https://github.com/agent-realm/harness-sessions-sql/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/agent-realm/harness-sessions-sql/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/agent-realm/harness-sessions-sql/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/agent-realm/harness-sessions-sql/releases/tag/v1.0.0

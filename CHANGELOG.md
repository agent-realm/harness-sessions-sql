# Changelog

All notable changes to sessions-sql are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Version numbers match the
specification's: the first release, 1.0.0, is its v1.

## [Unreleased]

The first release, 1.0.0. When it is tagged, this heading becomes `## [1.0.0] - YYYY-MM-DD`, with
the link reference `[1.0.0]: https://github.com/agent-realm/sessions-sql/releases/tag/v1.0.0` in
place of `[Unreleased]` below.

**Status.** The specification is v1, accepted. It consumes sessions-model v1.3 (the records) and
sessions v1.3 (the seam), or any later v1.x. The reference engine passes every §8 item on both
database profiles (the two legacy items do not apply to PostgreSQL). memhouse, the first production
implementation, passes every item that applies to it except Crash-safe, whose remaining failures
are the case
[SPEC-QUESTIONS.md, question 20](conformance/SPEC-QUESTIONS.md#more-points-the-kit-had-to-settle)
leaves open; two parts of Absences replay do not apply to it, as it declares only the vanish
policies it uses ([§9](01-SESSIONS-SQL-SPEC.md#9-status)).

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
  19 to 28 and 31 to 35 are open in v1.

[Unreleased]: https://github.com/agent-realm/sessions-sql/commits/main

# Run the conformance kit against your engine

The kit ([`conformance/`](../../conformance/)) checks an **engine**, the code that writes sessions
into the tables, against the items of [§8][s8]. It does not inspect a database you already have: it
makes namespaces of its own on your target, has your engine create its tables and write into them,
and reads them back. [`conformance/README.md`](../../conformance/README.md) is the reference for all
of it; this page is the short way through, with the reference engine as the worked case.

## 1. What your engine module exports

`SSQL_ENGINE` names a module (a path, or a package name resolved from the kit's folder). Its shape
is defined in [Plugging in an engine][plug]:

| Export or member | Required | What it is for |
|---|---|---|
| `createEngine(options)` | yes | returns the engine, once per namespace |
| `createTables(options)` | no | makes the tables with your own DDL. Without it the kit loads `schema/`, and the database parts become a self-check of `schema/`, outside your verdict |
| `name`, `version` | yes | printed in the report |
| `pass(envelopes, { crashAfter })` | yes | one ingest pass ([§5][s5]), stopping after the step `crashAfter` names |
| `replay({ adapterVer })` | yes | re-derive every session from `session_units` alone ([§4.1][s41]) |
| `crashPoints` | no | the later crash points it supports; `'archive'` is always run |
| `cursor()` | no | its committed cursor, when it is not kept in `session_sources`; without either, Crash-safe is not proven |
| `removal` | no | `'removed'` (the default) or `'tombstone'` |
| `vanishPolicies` | no | the vanish policies it implements (`'kept'`, `'removed'`); undeclared, it is checked against both |
| `legacySha(exprs)` | no | ClickHouse: its SQL for a legacy `content_sha` ([§4.8][s48]); without it, the two legacy items are skipped |

The options (`profile`, `target`, `database`, `prefix`, `tables`, `ns`, and for `createEngine`
`adapters`) are listed in the same section. Write into the physical names `tables` gives you.

**The worked case** is the [reference engine](../../conformance/reference/engine.mjs), which the kit
runs when `SSQL_ENGINE` is unset. It exports `createTables` (this repository's `schema/`),
declares crash points, both vanish policies and a `legacySha`, keeps its cursor in
`session_sources`, and writes removed versions. The kit's test engines
([`conformance/test/engines/`](../../conformance/test/engines/)) show smaller modules that wrap it
and change one thing; [Add a column without breaking conformance](add-a-column-without-breaking-conformance.md)
builds one.

## 2. Point the kit at a target and your engine

The variables are listed in [What it needs][needs]: `SSQL_CH_URL` (with `SSQL_CH_USER` and
`SSQL_CH_PASSWORD`) and/or `SSQL_PG_URL` for the targets, `SSQL_ENGINE` for your module,
`SSQL_ADAPTERS` for the session-adapters package, and `SSQL_PREFIX` and `SSQL_TIMEOUT_MS` to adjust
the run. Point the targets only at a disposable deployment.

```sh
(cd conformance && npm ci)
SSQL_ENGINE=./conformance/reference/engine.mjs node conformance/run.mjs
```

That names the reference engine, which is also what the kit runs with `SSQL_ENGINE` unset; put
your module's path in its place.

A value starting with `.` or `/` is a path, taken from the directory you run in; anything else is a
package name. The fixture-based checks need
`SSQL_ADAPTERS` to name a checkout of the session-adapters package, as for
[example 05](../../examples/05-full-blown/); without it they are skipped, with the reason.

## 3. Read the verdict

The report names the kit, the engine, the adapters, each target's server and whose DDL the database
parts check, then one row per §8 item and part. From a run of the reference engine on both
profiles:

```text
| # | §8 item | part | ClickHouse | PostgreSQL |
|---|---|---|---|---|
| 1 | Tables and keys | database | pass | pass |
…
| 12 | Legacy content_sha, whole rows | database | pass | n/a |
…
| 19 | Database profile parity | engine | pass | pass |

the engine: 48 pass, 3 n/a

exit 0: 48 row(s) checked
```

- **pass** and **fail**: the item held or not; a fail lists what failed.
- **n/a**: the item does not apply to that profile (the legacy items are ClickHouse database
  profile items), with why.
- **skipped**: it could not run here (no fixtures, no legacy SQL), with why. Not a pass.
- **`-`** (`not run`): a profile outside this run. Database profile parity needs both profiles in
  one run.
- **self-check**: a database part run against `schema/` because the engine has no `createTables`;
  it is no part of your verdict.

The last line is the verdict. Exit 0 when every selected row ran and passed; 1 when a row failed,
or a row was skipped or only a self-check (unless `--allow-skip`), or nothing was checked; 2 for a
usage error, such as an unknown check id or no target at all.

## 4. Narrow a run

```sh
SSQL_ENGINE=./conformance/reference/engine.mjs node conformance/run.mjs --only host-form,crash-safe --profile clickhouse --verbose
```

- `--only <ids>` runs those checks; the ids are the names of the files in
  [`conformance/checks/`](../../conformance/checks/) without their number, such as `tables-and-keys`.
- `--profile clickhouse|postgres` runs one profile.
- `--allow-skip` exits 0 although a selected row was skipped or a self-check: for a run that cannot
  have everything (no fixtures, an engine without legacy SQL). It does not turn a fail into a pass.
- `--verbose` prints every row's notes; `--json <file>` writes the results.
- `--self-test` runs every check against the faults it exists to catch. It runs the reference
  engine only, so it proves the kit, not your engine ([Positive controls][controls]).

[s41]: ../../01-SESSIONS-SQL-SPEC.md#41-session_units--the-archive
[s48]: ../../01-SESSIONS-SQL-SPEC.md#48-rows-no-adapter-derived-legacy-memhouse-bridge-memhouse-log
[s5]: ../../01-SESSIONS-SQL-SPEC.md#5-writing-the-engines-side-of-the-seam
[s8]: ../../01-SESSIONS-SQL-SPEC.md#8-conformance
[plug]: ../../conformance/README.md#plugging-in-an-engine
[needs]: ../../conformance/README.md#what-it-needs
[controls]: ../../conformance/README.md#positive-controls

# Examples

A ladder, from one row written by hand to the reference engine checked by the conformance kit. Each
example is a folder with a README: what it shows, the sections of
[`01-SESSIONS-SQL-SPEC.md`](../01-SESSIONS-SQL-SPEC.md) it illustrates, what it needs, the command
that runs it, and the output it prints.

| # | Example | What it shows | Profiles | Needs the session adapters |
|---|---|---|---|---|
| 01 | [One session, one message](01-one-message/) | SQL only: one session and one message written by hand, read back with `FINAL` or `argMax`; a removal showing why `argMax`'s filter goes in `HAVING`; a hostname refused as `host` | ClickHouse | no |
| 02 | [Revisions and removals](02-revisions-and-removals/) | SQL only: a revision, a late re-send that changes nothing, a removed version, the physical deletion of a key an upgraded adapter no longer produces, and what a reader sees after each | both | no |
| 03 | [Records in, rows out](03-records-to-rows/) | synthetic sessions-model records mapped to rows by the reference mapping, written, and read with the common queries | both | no |
| 04 | [Raw apart from derived](04-raw-and-derived/) | the archive of raw units and read manifests, and the entity tables rebuilt from it alone | both | no |
| 05 | [Full-blown](05-full-blown/) | real adapters over fixture harness stores, the reference engine, the current state read back, and the conformance kit's report | both | yes |

## Running them

Every example takes its targets from the environment, with the conformance kit's variables
([`conformance/README.md`](../conformance/README.md)): `SSQL_CH_URL`, `SSQL_CH_USER` and
`SSQL_CH_PASSWORD` for ClickHouse, `SSQL_PG_URL` for PostgreSQL, and `SSQL_ADAPTERS` for the
session adapters (example 05). They reuse the kit's code by relative import, so they need Node.js
24 and the kit's one dependency:

```sh
(cd conformance && npm ci)
```

One example, on one profile, from the repository root:

```sh
SSQL_CH_URL=http://localhost:8123 SSQL_CH_USER=kit SSQL_CH_PASSWORD=… \
  node examples/03-records-to-rows/example.mjs --profile clickhouse
```

Without `--profile`, an example runs on every profile it supports that has a target, each
profile's output after a line `== <profile> ==`.

All of them, checked against the expected output in their READMEs:

```sh
cd examples
SSQL_CH_URL=http://localhost:8123 SSQL_CH_USER=kit SSQL_CH_PASSWORD=… \
SSQL_PG_URL=postgres://kit:…@localhost:5432/kit \
SSQL_ADAPTERS=/path/to/harness-skeleton/packages/harness-session-adapters \
  npm test
```

`SSQL_ADAPTERS` names a checkout of the harness-session-adapters package at version 1.0.0, harness-skeleton
commit `5ab0659`: example 05 reads its `fixtures/`, and its expected output is that version's
([`05-full-blown/README.md`](05-full-blown/README.md) says how to get it).

[`test.mjs`](test.mjs) runs each example once per profile that has a target, and checks that it
prints exactly its README's expected output (the fenced block on the line after
`<!-- expected: <profile>[, <profile>] -->`), and that it leaves no namespace behind.

- **The READMEs' markers.** A marker that does not parse, in any case, an unknown profile, or a
  README whose profiles are not those the example runs on fails the example, on the profile it
  concerns. An example that reads the harness-session-adapters package (example 05) must name the version
  its output is from in a line `<!-- harness-session-adapters: <version> -->`; a missing or misspelled one
  fails it, and so does running it with another version in `SSQL_ADAPTERS`.
- **Interrupts.** It interrupts one example per profile while it holds namespaces open (example 05
  while the kit it runs is running too, or example 04 when 05 did not run), and checks that nothing
  it opened is left.
- **The seal.** It checks the examples' seal ([`lib/records.mjs`](lib/records.mjs)) on records that
  leave out members a seal fills in: against known answers computed with harness-session-adapters 1.0.0's
  own seal, always, and against the package's seal itself when `SSQL_ADAPTERS` is set.

`node test.mjs --only 01,03`, `--profile postgres` and `--allow-skip` narrow or relax a run. It
exits 0 when every run printed its expected output and every check passed; 1 when one failed,
printed something else, left a namespace behind, or (without `--allow-skip`) was skipped, when
nothing ran, or when the test itself failed; 2 for a usage error, or no target at all.
`--allow-skip` accepts an example that cannot run here for want of something, such as example 05
without `SSQL_ADAPTERS`. It does not accept a failed seal check: with `SSQL_ADAPTERS` set but its
package's seal not loadable, the setting is broken and the comparison it asks for did not happen,
so the run fails, with the reason.

**Point them only at a disposable deployment.** Each example works in a fresh database (ClickHouse)
or schema (PostgreSQL) of its own, holding [`schema/`](../schema/)'s tables, and drops it when it
ends, fails or is interrupted; example 05 also runs the kit, which does the same with its own.
[`conformance/compose.yml`](../conformance/compose.yml) starts a disposable pair. No credential is
ever printed: every message goes through the kit's scrub
([`conformance/lib/secrets.mjs`](../conformance/lib/secrets.mjs)) first.

An example exits 0 when it is done, 1 when it failed or could not drop a namespace it opened, 2
for a usage error, and 3 when it is skipped because it cannot run here (example 05 without the
session adapters' fixtures). `node example.mjs --about` prints, as one line of JSON, the profiles
it runs on and whether it reads the harness-session-adapters package.

## Layout

```
NN-name/README.md    what the example shows, the spec sections, what it needs, the command, the output
NN-name/example.mjs  the example; 01 and 02 run their .sql files
lib/example.mjs      targets, namespaces, interrupts and output, shared by every example
lib/sql.mjs          the runner of the SQL-only examples
lib/records.mjs      the two hashes of a sessions-model record, for the examples' own records
test.mjs             runs every example and checks its output
```

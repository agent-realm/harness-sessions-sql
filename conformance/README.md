# Conformance kit

The checks of [`01-SESSIONS-SQL-SPEC.md`](../01-SESSIONS-SQL-SPEC.md) §8, runnable. Each check is
one file in [`checks/`](checks/), named and titled as §8 names its item, so the report reads as
the specification's checklist. The kit runs against a ClickHouse or PostgreSQL target taken from
the environment, and creates and drops its own databases there.

```sh
npm install
SSQL_CH_URL=http://localhost:8123 SSQL_CH_USER=… SSQL_CH_PASSWORD=… \
SSQL_PG_URL=postgres://…@localhost:5432/… \
SSQL_ADAPTERS=/path/to/harness-skeleton/packages/session-adapters \
node run.mjs
```

Node.js 24. One dependency, `pg`; ClickHouse is spoken over its HTTP interface with `fetch`.

## What it needs

| Variable | Meaning |
|---|---|
| `SSQL_CH_URL` | a ClickHouse HTTP endpoint (for example `http://localhost:8123`) |
| `SSQL_CH_USER`, `SSQL_CH_PASSWORD` | its credentials, passed by the caller's environment; never printed |
| `SSQL_PG_URL` | a PostgreSQL connection URL; printed without its user and password |
| `SSQL_PREFIX` | the deployment prefix of every table (spec §3, physical names); default `conf_` |
| `SSQL_ENGINE` | the engine under test, a module path or package name; default the [reference engine](reference/engine.mjs) |
| `SSQL_ADAPTERS` | the session-adapters package (`@agent-realm/session-adapters`, `packages/session-adapters` of [harness-skeleton](https://github.com/agent-realm/harness-skeleton)): a path to it, or a package name, until it is on npm |

A profile without a URL is reported as skipped. The fixture-based checks need the package's
`fixtures/` folder, which a checkout has; without it they are skipped, with the reason.

**Point it only at a disposable deployment.** Every check creates a namespace of its own
(`ssql_conf_<run>_<n>`: a ClickHouse database, or a PostgreSQL schema), loads the profile's DDL
from [`schema/`](../schema/) into it under the prefix, and drops it when the check ends.
[`compose.yml`](compose.yml) starts a ClickHouse 26 and a PostgreSQL 16 with throwaway credentials,
for a local container host or a test-deploy tool.

```sh
node run.mjs                  # every check on every profile with a target; exit 1 on a failure
node run.mjs --self-test      # every check against each of its faults (below); exit 1 if one passes
node run.mjs --only host-form,crash-safe --profile clickhouse --verbose
node run.mjs --json report.json
npm test                      # the kit's own tests; the two that need targets run when they are set
```

The report names the kit version and commit, the engine and its version, the adapters package and
each target's server version, then one row per §8 item: `pass`, `fail` (with what failed),
`skipped` (cannot run here, with why) or `n/a` (does not apply to the profile, with why).

## The input: envelopes

Engines are fed **envelopes**, made by the session adapters from the package's own synthetic
fixtures ([`envelopes.mjs`](envelopes.mjs)). An envelope is one read of one source as the
`sessions` seam delivers it:

```js
{ store: {host, harness, harness_path}, session: {session_id, incarnation},
  source_key, role, mode, position_kind,
  from,                                   // the position the read started from (null: from scratch)
  read: {continuity, units, gone, position, held_back} }
```

or, for a source the harness store no longer has, the consumer's decision:
`{ store, session, source_key, from, source_gone: true, policy: 'kept' | 'removed' }`.

A pass is a list of envelopes. The kit builds each scenario by copying a fixture case to a
temporary folder, reading it as a consumer would (keeping each source's position and `known`), and
changing the copy between passes the way a harness does: a file rewritten through a new inode,
rows deleted, a line appended or cut in half. The folders are removed before any engine runs. Hosts
are host/v0 values of synthetic machine ids. The database checks that need a shape no fixture has
(a hostname key, unknown registry values, null counters) write the kit's own synthetic rows with
plain SQL.

The kit's expectation comes from the envelopes alone ([`lib/oracle.mjs`](lib/oracle.mjs)): each
source folded as sessions §3 says, each touched session derived in full (sessions §2), and the
keys reconciled as sessions §4 says. No check compares an engine with the reference engine.

## The checks

Two kinds, labelled in the report:

- **Database checks** prove the DDL and SQL of a profile, with no engine: plain inserts and the
  catalogue.
- **Engine checks** prove a writer: they drive the engine under test through passes of envelopes,
  then read its tables with §6's queries (current state: not deleted, not removed; removed
  versions: `removed = 1`).

| # | §8 item | Kind | What it proves, on what input |
|---|---|---|---|
| 1 | Tables and keys | database, engine | the catalogue holds every §3 table under the prefix, keyed by exactly its identity columns (`session_sources` may be absent); after the rewind scenario, every record ever current is still present, so nothing was physically deleted outside principle 3 |
| 2 | Twice is once | engine | each pass, then the whole sequence, delivered again adds no logical row: the entity tables and cursor are unchanged, session_units gains no unit and no generation (only manifests of reads that deliver nothing new), and no identity holds two rows after a merge |
| 3 | Crash-safe | engine | for each crash point the engine offers (at least right after the archive write), every pass stopped there and re-run on a fresh engine instance gives the clean run's logical row counts and current state |
| 4 | Removed equals not live | engine | after each pass of a Copilot rewind, an OpenCode revert and a Gemini `$rewindTo`: the current records are the pass's `live` sets with their derived shas; each key that left `live` is a removed version of its last row (or gone, for a tombstoning engine); totals over current rows equal those over live records; a retracted message stays current |
| 5 | Edges outlive statements correctly | engine | the OpenCode child/task pair merges into one edge (`stated_on: both`, at the call); a child-only re-derive keeps it unchanged; removing both statements ends it |
| 6 | Zero-part messages | engine | an assistant message with no parts is exactly one row, `part_id ''`, `kind 'none'`, the message's sha in both sha columns |
| 7 | Registries take new values | database | unseen `harness`, `ts_source` and `enc` values are accepted and read back as given |
| 8 | Host form | database | in every table with a key `host`: host/v0 and `r-` values accepted; a hostname, uppercase hex and 31 digits rejected; a `legacy` entity row exempt; the link reference hosts alike |
| 9 | No time partition | database, engine | no entity table has a time partition key, every `ts` is Nullable, and Zed's null `ts` values are stored null |
| 10 | Units only | engine | every unit row equals a unit a read emitted (a cut last line, held back by `read`, never lands); every row with `unit_key ''` is a manifest; every adapter-owned record is one the adapter derived |
| 11 | Legacy content_sha, line format | database | each §4.8 known-answer vector gives its line and its sha through the implementation's SQL (ClickHouse; n/a on PostgreSQL) |
| 12 | Legacy content_sha, whole rows | database | each §4.8 full-row vector, loaded by column name into the deployed table, formats back in DDL order into its line and its sha (ClickHouse; n/a on PostgreSQL) |
| 13 | Two hosts, two sessions | engine | one harness store read under two hosts gives each session under both, two session keys |
| 14 | Absences replay | engine | the four absences (a source reset to empty, a vanished source kept, one removed, a delta's gone keys) replayed from a copy of session_units alone give the live namespace's rows, removed versions included |
| 15 | No-op manifests | engine | the archive replayed with and without its no-op manifests gives the same state |
| 16 | Re-derive from the archive | engine | a replay with the kit's bumped adapters (next patch version, every usage record re-keyed) rewrites every record it produces at a higher `rev`, and physically deletes exactly the records it no longer produces |
| 17 | Null is unknown | database, engine | null counters, flags, `exit_code`, `output_ref_bytes` and `output_len` read back null, and a part's own source and state survive beside its message's; then every such field of the broad scenario equals what the adapter emitted |
| 18 | Redaction holds | engine | on the three sentinel fixtures, no row holds a planted value unless the unit or record it was written from holds it (free text, sessions-model §4 rule 6), and the values redacted on declared paths are in no table |
| 19 | Database profile parity | engine | the same envelopes into ClickHouse and PostgreSQL give the same current `(identity, content_sha[, message_content_sha])` in every entity table, `legacy` rows left out |

Where §8 cannot be checked as it is written, the check says what it checks instead, and
[`SPEC-QUESTIONS.md`](SPEC-QUESTIONS.md) asks the specification to settle it.

### Positive controls

A check that cannot fail proves nothing. Each check names the faults it exists to catch, and
`node run.mjs --self-test` runs it against each of them, with the reference engine; every one must
make it fail:

- **engine faults** break one behaviour of the reference engine (a re-delivered read opening a new
  generation, the cursor advancing before the entity writes, no removed versions, a null `ts`
  filled, no manifests, and so on);
- **DDL faults** change the profile's DDL text before it loads (a key column dropped, a registry
  turned into a closed list, the host check removed, a time partition, a non-Nullable `ts` or
  counter, two columns swapped).

The list, with what each breaks, is [`reference/faults.mjs`](reference/faults.mjs).

## Plugging in an engine

`SSQL_ENGINE` names a module that exports `createEngine(options)`. The kit calls it once per
namespace (and again to stand for a restarted process), with:

| Option | Meaning |
|---|---|
| `profile` | `clickhouse` or `postgres` |
| `target` | the profile's target: `{url, user, password}` or `{url}` |
| `database` | the namespace: a ClickHouse database, or a PostgreSQL schema |
| `prefix`, `tables` | the deployment prefix, and each logical table's qualified physical name |
| `ns` | the kit's own connection to the namespace (`query`, `exec`, `present`, `current`), which an engine may use |
| `adapters` | the session adapters: `adapterFor(harness, {adapterVer})` and `describe(harness)` |

It returns an engine:

| Member | Meaning |
|---|---|
| `name`, `version` | printed in the report |
| `pass(envelopes, {crashAfter})` | one ingest pass (spec §5). With `crashAfter`, stop right after that step and return, as a killed process would; `'archive'` is between the archive write and the cursor write |
| `crashPoints` | optional: the `crashAfter` values the engine supports (default `['archive']`) |
| `replay({adapterVer})` | re-derive every session from session_units alone. `adapterVer` is `{harness: version}`: replay with that adapter version, which the kit supplies through `adapters.adapterFor` |
| `removal` | optional: `'removed'` (default) for removed versions, `'tombstone'` for a tombstoning engine |
| `legacySha(exprs)` | optional, ClickHouse: `{line, sql, settings}`, the SQL of a legacy TabSeparated line and its sha over the column expressions; default §4.8's |

The kit reads the tables itself with §6's queries; it never asks the engine for its state. An
engine stores into the namespace's tables, under the names `tables` gives. An engine that derives
keys, `rev` or edges its own way is free to: the checks compare with the contracts' expectation,
not with the reference engine.

## The reference engine

[`reference/`](reference/) implements §5's write protocol for both profiles, as the engine the
kit runs when `SSQL_ENGINE` is unset, the second profile the parity check needs, and an example to
read. It favours plain over fast: every pass re-derives each touched session in full from its
archived units (sessions §2: the full replay), so it keeps no derive state; it writes removed
versions, never tombstones; it recomputes every edge after each pass; its cursor keeps each
source's position, generation, a per-session pass counter (`progress`, shared by the manifests of
one pass so a replay can fold them back pass by pass) and the source's current unit list; and a
read whose `from` is not the cursor's position is stale and ignored. Its choices where the
specification leaves one open are listed in [`SPEC-QUESTIONS.md`](SPEC-QUESTIONS.md).

## Layout

```
run.mjs            the runner: report, self-test, JSON output
envelopes.mjs      the scenarios, from the session adapters' fixtures; the kit's synthetic rows
checks/NN-*.mjs    one per §8 item
lib/               targets and namespaces (db, ch, pg), the spec's tables and vectors (spec),
                   keys, JCS, the oracle, state reads
reference/         the reference engine (engine.mjs, rows.mjs) and the faults (faults.mjs)
test/              the kit's own tests
compose.yml        a disposable ClickHouse and PostgreSQL pair
```

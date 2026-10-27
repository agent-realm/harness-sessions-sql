# Conformance kit

The checks of [`01-SESSIONS-SQL-SPEC.md`](../01-SESSIONS-SQL-SPEC.md) §8, runnable. Each check is
one file in [`checks/`](checks/), named and titled as §8 names its item, so the report reads as
the specification's checklist. The kit runs against a ClickHouse or PostgreSQL target taken from
the environment, and creates and drops namespaces of its own there (ClickHouse databases,
PostgreSQL schemas).

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
| `SSQL_CH_USER`, `SSQL_CH_PASSWORD` | its credentials, passed by the caller's environment. User info in `SSQL_CH_URL` is accepted too and moved into the request headers; these two win over it |
| `SSQL_PG_URL` | a PostgreSQL connection URL |
| `SSQL_PREFIX` | the deployment prefix of every table (spec §3, physical names); default `conf_` |
| `SSQL_ENGINE` | the engine under test, a module path or package name; default the [reference engine](reference/engine.mjs) |
| `SSQL_ADAPTERS` | the session-adapters package (`@agent-realm/session-adapters`, `packages/session-adapters` of [harness-skeleton](https://github.com/agent-realm/harness-skeleton)): a path to a checkout of it, pinned to the package's release tag once it has one, or a package name |
| `SSQL_TIMEOUT_MS` | how long one database request may take; default 300000 |

A package name in `SSQL_ENGINE` or `SSQL_ADAPTERS` resolves from the kit's own folder (its
`node_modules`), not from where you run it: give a path otherwise.

No credential is ever printed. Targets are shown without their user info, and every message the
kit prints or writes to `--json`, its own or a server's or an engine's, has every user name and
password it was given taken out first.

The run checks the profiles that have a target (or the one `--profile` names); a profile with no
target is not run, and no target at all is a usage error. The fixture-based checks need the
package's `fixtures/` folder, which a checkout has and a published package does not ship; without
it they are skipped, with the reason.

**Point it only at a disposable deployment.** Every check creates a namespace of its own
(`ssql_conf_<run>_<n>`), makes the deployment's tables in it under the prefix (below: the engine's
DDL), and drops it when the check ends. An interrupted run (Ctrl-C, or a test harness's timeout)
drops what it opened before it exits. [`compose.yml`](compose.yml) starts such a pair (below).

```sh
node run.mjs                  # every check on every profile with a target
node run.mjs --self-test      # every check against each of its faults (below)
node run.mjs --only host-form,crash-safe --profile clickhouse --verbose
node run.mjs --allow-skip     # accept checks that cannot run here (no fixtures, no legacy SQL, …)
node run.mjs --self-test --only crash-safe --fault engine:ignore-crash   # one fault, any check
node run.mjs --json report.json
npm test                      # the kit's own tests; those that need targets run when they are set
```

Exit 0 when every selected check ran and passed. Exit 1 when one failed or errored, when (without
`--allow-skip`) one was skipped or ran only as a self-check of `schema/` (below), or when nothing
was checked at all. Exit 2 for a usage error: an unknown check id, flag, profile or fault, or a
profile with no target. The self-test exits 0 when every control it ran made its check fail.

The report names the kit version and commit, the engine and its version, whose DDL the database
parts test, the adapters package and each target's server version, then one row per §8 item and
part: `pass`, `fail` (with what failed), `skipped` (cannot run here, with why) or `n/a` (does not
apply to the profile, with why). A column outside the run's profiles shows `-`. The last line is
the verdict, with its reasons.

## A disposable pair

[`compose.yml`](compose.yml) starts a ClickHouse 26 and a PostgreSQL 16 on this machine, safe by
default: both ports on `127.0.0.1` only, and no default password (it refuses to start without
`SSQL_KIT_PASSWORD`). `SSQL_KIT_CH_PORT` and `SSQL_KIT_PG_PORT` move the ports (default 8123 and
5432).

```sh
SSQL_KIT_PASSWORD=… docker compose up -d
```

To run the pair anywhere else (a disposable host of its own reached through a tunnel, ports a
deploy tool hands out), write a deployment file of your own and keep it outside this repository,
so a password or an address of yours never lands in a commit. Either a whole file, for a tool that
takes one compose file, with the bind address, ports and password that deployment needs:

```yaml
services:
  clickhouse:
    image: clickhouse/clickhouse-server:26.8
    environment: { CLICKHOUSE_USER: kit, CLICKHOUSE_PASSWORD: "${MY_KIT_PASSWORD:?}" }
    ports: ["0.0.0.0:${MY_CH_PORT:?}:8123"]
  postgres:
    image: postgres:16
    environment: { POSTGRES_USER: kit, POSTGRES_PASSWORD: "${MY_KIT_PASSWORD:?}", POSTGRES_DB: kit }
    ports: ["0.0.0.0:${MY_PG_PORT:?}:5432"]
```

or an override merged over this file (`docker compose -f compose.yml -f ../my-deploy.yml up -d`,
with `SSQL_KIT_PASSWORD` still set), whose `ports: !override [...]` replaces the loopback binding
instead of adding to it. Publish on every interface only where nobody else can reach the ports:
the user `kit` is a PostgreSQL superuser, and a port Docker publishes bypasses the host's
firewall.

## The input: envelopes

Engines are fed **envelopes**, made by the session adapters from the package's own synthetic
fixtures ([`envelopes.mjs`](envelopes.mjs)). An envelope, as spec §8 defines it, is one read of
one source as the `sessions` seam delivers it:

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
rows deleted or edited, a line appended or cut in half. One scenario reads a pass, then reads it
again from the same positions after the store changed, as a consumer does after a crash. The
folders are removed before any engine runs. Hosts are host/v0 values of synthetic machine ids. The
database checks that need a shape no fixture has (a hostname key, unknown registry values, null
counters) write the kit's own synthetic rows with plain SQL.

The kit's expectation comes from the envelopes alone ([`lib/oracle.mjs`](lib/oracle.mjs)): each
source folded as sessions §3 says, each touched session derived in full (sessions §2), and the
keys reconciled as sessions §4 says. The archive is read back the same way, by the kit:
[`lib/archive.mjs`](lib/archive.mjs) folds `session_units` as §4.1's replay does, checks every
read manifest against §4.1's shape, and matches the manifests with the reads they record. No check
compares an engine with the reference engine.

## The checks

Each check has a **database** part, an **engine** part, or both (Absences replay has four engine
parts, one per case), and each part is its own row:

- **Database parts** prove the DDL and SQL of a profile, with no engine: the catalogue, plain
  inserts. They test the engine's own DDL, which the engine supplies through `createTables`
  (below). An engine that supplies none gets this repository's [`schema/`](../schema/), and its
  database rows are then a **self-check of `schema/`**: labelled so in the report and in `--json`
  (`selfCheck`), and no part of that engine's verdict.
- **Engine parts** prove a writer: they drive the engine under test through passes of envelopes,
  then read its tables with §6's queries (current state: not deleted, not removed; removed
  versions: `removed = 1`).

| # | §8 item | Parts | What it proves, on what input |
|---|---|---|---|
| 1 | Tables and keys | database, engine | the catalogue holds every §3 table under the prefix, keyed by exactly its identity columns (`session_sources` may be absent; in ClickHouse, §3's sort-key prefix of `ts` or one function of `ts` before them is accepted, and nothing else); after the rewind scenario, every record ever current is still present, so nothing was physically deleted outside principle 3 |
| 2 | Twice is once | engine | each pass delivered again right after itself (a pass re-run, §5) adds no logical row: the entity tables are unchanged, the cursor gains no row, session_units gains no unit and no generation (only manifests of reads that deliver nothing new) |
| 3 | Crash-safe | engine | for each crash point (`archive` always, and each later one the engine declares), every pass is stopped there and the stop itself checked (the pass's units archived, the cursor as it was, and at `archive` the entity tables untouched), then re-run on a fresh engine instance: the clean run's logical row counts and current state. The cursor is read through the engine's `cursor()`, else from session_sources; when neither changes over a clean run, the stops are not proven and the row is `skipped`, never `pass`. And a crash after the archive write whose re-run reads other content (the store changed in between): the clean state of what was committed, live, in the kit's fold of the archive, and in the engine's replay |
| 4 | Removed equals not live | engine | after each pass of a Copilot rewind, an OpenCode revert and a Gemini `$rewindTo`: the current records are the pass's `live` sets with their derived shas; each key that left `live` is a removed version that copies its last row column by column (or gone, for a tombstoning engine); totals over current rows equal those over live records; a retracted message stays current |
| 5 | Edges outlive statements correctly | engine | the OpenCode child/task pair merges into one edge (`stated_on: both`, at the call); a child-only re-derive keeps that edge, still merged; removing the child's statement while the parent's stands keeps an edge; removing the last ends it |
| 6 | Zero-part messages | engine | an assistant message with no parts is exactly one row, `part_id ''`, `kind 'none'`, the message's sha in both sha columns |
| 7 | Registries take new values | database | unseen `harness`, `ts_source` and `enc` values are accepted and read back as given |
| 8 | Host form | database | in every table with a key `host`: host/v0, `r-` and `s-` values accepted (`s-`: the claude.ai known answer, sessions-model v1.3); a hostname, uppercase hex, 31 or 33 hex digits, 32 with a prefix or a suffix, `r-` with 31 or 33, an undefined prefix (`t-`), `s-` with uppercase hex or 31 digits, and `''` rejected; a `legacy` entity row exempt; the link reference hosts alike |
| 9 | No time partition | database, engine | no entity table has a time partition key, every `ts` of a §3 table is Nullable (a consumer's own tables left alone), and Zed's null `ts` values, on messages and lifecycle records, are stored null |
| 10 | Units only | engine | every unit (its chunks joined, if several) equals a unit a read emitted (a cut last line, held back by `read`, never lands); every row with `unit_key ''` is a manifest of §4.1's shape that records its read; every adapter-owned record is one the adapter derived, each row with the shas §4 gives it (a part row: the sha of the part as emitted) |
| 11 | Legacy content_sha, line format | engine | each §4.8 known-answer vector gives its line and its sha through the engine's legacy SQL (a ClickHouse database profile item; n/a on PostgreSQL; skipped for an engine with no `legacySha`) |
| 12 | Legacy content_sha, whole rows | database, engine | the database half: each §4.8 full-row vector, loaded by column name into the deployed table, formats back in DDL order into its line and its sha, a column the deployment adds left out of the line (§4.8): the database part through §4.8's own expression (the DDL), the engine part through the engine's legacy SQL, which counts in the verdict even when the database part is a self-check. The conversion half is the implementation's own known-answer tests, which its conformance report names (a ClickHouse database profile item; n/a on PostgreSQL; skipped for an engine with no `legacySha`) |
| 13 | Two hosts, two sessions | engine | one harness store read under two hosts gives every session under both, two session keys, each with all its records in every entity table |
| 14 | Absences replay | engine (four parts) | for each absence: after each live pass, the records against the contract and the kit's fold of the archive against the reads; every manifest against §4.1; then the archive alone, copied and replayed, gives the live namespace's adapter-owned rows, removed versions included, and its current edges. One part per case: a source reset to empty and a delta's gone keys; a vanished source kept; one removed; and, for an engine that offers both, a policy changed between passes, in both orders, each event replaying under the policy its manifest records. A vanish policy the engine does not declare (`vanishPolicies`) is n/a, with the declaration as the reason; an engine that declares none is checked against both |
| 15 | No-op manifests | engine | the archive replayed with and without its no-op manifests (those of reads that change nothing in the fold, §4.1; left out by their whole identity) gives the same state |
| 16 | Re-derive from the archive | engine | a replay with the kit's bumped adapters (next patch version, every usage record re-keyed) rewrites every record it produces at a higher `rev`, each row carrying the new `adapter_ver` exactly as the adapter states it, and physically deletes exactly the records it no longer produces |
| 17 | Null is unknown | database, engine | null counters, flags, `exit_code`, `output_ref_bytes`, `output_len`, `child_stored` and `orig_sha256` read back null, and a part's own source and state survive beside its message's; then every such field of the broad scenario equals what the adapter emitted, every statement's `child_stored` included, every unit's `orig_sha256` is the unit's own or null, and a tool result whose newer version has no output reference keeps none |
| 18 | Redaction holds | engine | on the three sentinel fixtures, OpenCode's first user message (its text holds a planted value) deleted in a second pass: no row holds a planted value in the specification's columns (units read whole and decoded) unless the unit or record it was written from holds it (free text, sessions-model §4 rule 6); a column the deployment adds (§3, derived columns) holds one only where a current record of the row's session holds it (in a removed version, the archive or the cursor: a record of the session, current or removed); and the values redacted on declared paths are in no table |
| 19 | Database profile parity | engine | the same envelopes into ClickHouse and PostgreSQL give the same current `(identity, content_sha[, message_content_sha])` in every entity table, `legacy` rows left out (runs when both profiles are in the run) |

Each check runs its item as §8 of the specification's v1 words it, against the v1 DDL in
[`schema/`](../schema/). [`SPEC-QUESTIONS.md`](SPEC-QUESTIONS.md) keeps the questions the kit
raised against v0, each with the answer v1 gives, and the ones still open.

### Positive controls

A check that cannot fail proves nothing. Each check names the faults it exists to catch, and
`node run.mjs --self-test` runs it against each of them, with the reference engine; every one must
make it fail:

- **engine faults** break one behaviour of the reference engine (a re-delivered read opening a new
  generation, the cursor advancing before the entity writes, a crash point ignored, no removed
  versions, a removed version that rewrites its row, a null `ts` filled, no manifests or manifests
  only the engine's replay reads, a part sha computed without its null members, a chunk lost, a
  PostgreSQL upsert that keeps a column the new version lost, `adapter_ver` stored as an integer
  encoding, a null `child_stored` written as true, a missing `orig_sha256` written as `''`, a
  derived column that keeps a removed message's text or takes another session's, a replay that
  applies the current vanish policy instead of the one each manifest records, and so on);
- **DDL faults** are a faulty implementation DDL, supplied through the reference engine's
  `createTables` as any engine's would be: a key column dropped, a registry turned into a closed
  list, the host check removed or unanchored, a time partition, a non-Nullable `ts` or counter, an
  integer `adapter_ver`, a non-Nullable `child_stored` or `orig_sha256`, two columns swapped.

The list, with what each breaks, is [`reference/faults.mjs`](reference/faults.mjs). The kit's own
tests add test engines ([`test/engines/`](test/engines/)), each a conforming deployment the kit
must accept or a fault in an engine's own code the kit must catch:

- accepted: one that stores large units in several chunks; one whose ClickHouse DDL prefixes a
  sort key with `toDate(ts)`; one that adds a column of its own to two tables; one whose DDL adds a
  derived column (`sessions.first_prompt`) it computes from the session's current records; one
  with a table of its own beside the §3 tables; one that keeps its cursor in a table of its own and
  exposes it as `cursor()`;
- caught or not proven: one with no DDL (self-check rows); one whose own DDL lacks the host check;
  one with no legacy SQL; one with no DDL and a wrong legacy SQL; one that hides its cursor and
  ignores its later crash points (not proven), and one that exposes it and ignores them (fails);
  one whose derived column keeps a removed message's text, and one whose derived column takes
  another session's; one that keeps every vanished source and declares `vanishPolicies: ['kept']`
  (accepted, its removed parts n/a), and the same with no declaration (checked against both, so
  its removed parts fail); two whose errors quote a URL with a password the kit was never given, which it must not print.

## Plugging in an engine

`SSQL_ENGINE` names a module that exports `createEngine(options)`, and may export
`createTables(options)`:

| Export | Meaning |
|---|---|
| `createEngine(options)` | called once per namespace (and again to stand for a restarted process); returns the engine below |
| `createTables(options)` | optional: make the deployment's tables in the namespace, under the names `tables` gives, with the engine's own DDL. The database checks test what it makes. Without it, the kit loads `schema/` and the database rows are a self-check of `schema/`, outside the engine's verdict. A column the deployment adds needs a default, or the kit's synthetic rows are refused |

Both receive:

| Option | Meaning |
|---|---|
| `profile` | `clickhouse` or `postgres` |
| `target` | the profile's target: `{url, user, password}` (the URL without user info) or `{url}` |
| `database` | the namespace: a ClickHouse database, or a PostgreSQL schema |
| `prefix`, `tables` | the deployment prefix, and each logical table's qualified physical name |
| `ns` | the kit's own connection to the namespace (`query`, `exec`, `present`, `current`), which an engine may use |
| `adapters` | `createEngine` only: the session adapters, `adapterFor(harness, {adapterVer})` and `describe(harness)` |

`createEngine` returns an engine:

| Member | Meaning |
|---|---|
| `name`, `version` | printed in the report |
| `pass(envelopes, {crashAfter})` | one ingest pass (spec §5). With `crashAfter`, stop right after that step and return, as a killed process would; `'archive'` is right after the archive write. The kit checks that the stop happened there |
| `crashPoints` | optional: the later `crashAfter` values the engine supports; `'archive'` is always run. Each lies before the cursor write |
| `cursor()` | optional: the engine's committed cursor as it is stored (any JSON value), read from its store, so that any instance on the namespace returns the same. Crash-safe compares it before and after each stop. Without it the kit reads session_sources; an engine that keeps its cursor elsewhere (§4.6 allows it) and has no `cursor()` gets Crash-safe reported not proven |
| `replay({adapterVer})` | re-derive every session from session_units alone. `adapterVer` is `{harness: version}`: replay with that adapter version, which the kit supplies through `adapters.adapterFor` |
| `removal` | optional: `'removed'` (default) for removed versions, `'tombstone'` for a tombstoning engine |
| `vanishPolicies` | optional: the vanish policies (§4.1) the engine implements, at least one of `'kept'` and `'removed'` (`['kept']`, `['removed']` or both). Absences replay checks each declared policy and reports the other n/a, with the declaration as the reason; without it, both are checked, so a missing declaration never skips a check. Anything else (an empty list, another value) fails the item |
| `legacySha(exprs)` | optional, ClickHouse: `{line, sql, settings}`, the engine's SQL of a legacy TabSeparated line and its sha over the column expressions. Without it the two legacy checks are skipped: they prove the implementation's SQL |

The kit reads the tables itself with §6's queries; it never asks the engine for its state. An
engine stores into the namespace's tables, under the names `tables` gives. An engine that derives
keys, `rev` or edges its own way is free to: the checks compare with the contracts' expectation,
not with the reference engine.

## The reference engine

[`reference/`](reference/) implements §5's write protocol for both profiles, as the engine the
kit runs when `SSQL_ENGINE` is unset, the second profile the parity check needs, and an example to
read. Its DDL is this repository's `schema/`, supplied through its `createTables`. It favours plain
over fast: every pass re-derives each touched session in full from its archived units (sessions
§2: the full replay), so it keeps no derive state; it writes removed versions, never tombstones; it
recomputes every edge after each pass; its cursor keeps each source's position, generation, a
per-session pass counter (`progress`, shared by the manifests of one pass so a replay can fold them
back pass by pass) and the source's current unit list. A read whose `from` is not the cursor's
position is stale and ignored, except a read from scratch, which moves only the position when it
delivers the units the source holds and otherwise opens a generation. A re-run that reads other
content than a crashed pass archived opens a generation of its own. Every PostgreSQL upsert writes
the table's whole column list. It declares both vanish policies and records each in its
`source_gone` manifest, which its replay follows. Its `chunkBytes` option stores large units in several chunks, and
its `firstPrompt` option keeps a derived column (spec §3), `sessions.first_prompt`, recomputed
from the session's current rows after every pass and written as a new version where it changed. It
stores `adapter_ver` as the adapter states it, keeps a statement's null `child_stored`, and writes
`orig_sha256` null for a unit without one. The choices it had to make where v0 left one open, the
v1 answers, and the questions still open are in [`SPEC-QUESTIONS.md`](SPEC-QUESTIONS.md).

## Layout

```
run.mjs            the runner: report, verdict, self-test, JSON output
envelopes.mjs      the scenarios, from the session adapters' fixtures; the kit's synthetic rows
checks/NN-*.mjs    one per §8 item, with a database part, an engine part, or both
lib/               targets and namespaces (db, ch, pg), credentials kept out of messages (secrets),
                   the spec's tables and vectors (spec), keys, JCS, the oracle, the archive's fold
                   and manifests (archive), record comparison (compare), state reads
reference/         the reference engine (engine.mjs, rows.mjs) and the faults (faults.mjs)
test/              the kit's own tests, and the test engines they run
compose.yml        a disposable ClickHouse and PostgreSQL pair
```

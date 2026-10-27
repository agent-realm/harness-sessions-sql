# 04. Raw apart from derived

A Node.js script, both database profiles. The reference engine reads a toy harness store over
three passes, archiving every raw unit in `session_units` and deriving the entity tables from it.
Then only `session_units` is copied into a fresh namespace, the engine replays it there, and the
replayed tables match the live ones, removed versions included.

## What it shows

- **The archive is the truth** ([§2], principle 1). Each pass archives the units its read
  delivered, and the reference engine writes a **read manifest** for each read (`unit_key = ''`,
  `enc = 'manifest'`): the read's continuity, its pass counter `progress`, the units it delivered
  and the keys it reported gone ([§4.1]). §4.1 lets an engine omit the manifest of a read that
  changes nothing; every read here changes something.
- **Generations.** A read that resets the source (a first read, or a rewrite) opens a new
  generation; an appended read adds to the current one. The third pass reads the file after a
  rewind rewrote it shorter, so the last two messages leave `live` and get removed versions
  ([§2], principle 3).
- **Replay from the archive alone** ([§4.1], [§6]). A fresh namespace gets `session_units` and
  nothing else: no entity table, no cursor (`session_sources`, which replay never reads, [§4.6]).
  The engine folds the manifests pass by pass, in `progress` order, and derives once per pass.
  Every entity row comes back, current and removed, with the same identity, `content_sha` and
  `removed` flag. Its `rev`s are the replaying writer's own ([§7]), so they are not compared.

The store and its adapter are toys, written for this example
([`toy-adapter.mjs`](toy-adapter.mjs)), so every unit and record stays readable: the session is one
JSONL file, one line per message, kept in memory, and the toy adapter's `read` and `derive`
follow the shapes of the `sessions` seam. The real session adapters come in
[example 05](../05-full-blown/). The engine is the conformance kit's reference engine, imported
from [`conformance/reference/engine.mjs`](../../conformance/reference/engine.mjs), and the
comparison is the kit's own snapshot of a namespace
([`conformance/lib/state.mjs`](../../conformance/lib/state.mjs)).

The passes, as the toy store changes between them:

| Pass | The file holds | The read |
|---|---|---|
| 1 | `m-1`, `m-2`, `m-3` | from scratch: `reset`, three units; generation 1 opens |
| 2 | `m-1` to `m-4` | from where pass 1 left it: `appended`, one unit |
| 3 | `m-1`, `m-2` (rewritten by a rewind) | the file is shorter than the position: `reset`, two units; generation 2 opens |

A unit's `unit_key` is the decimal byte offset where its line starts.

## Spec sections

- [§2 Core principles][§2]: principle 1 (the archive is the truth) and principle 3 (removed
  content is kept).
- [§4.1 `session_units`][§4.1]: units, read manifests, generations, and replay from the archive
  alone.
- [§4.6 `session_sources`][§4.6]: the cursor, which replay never reads.
- [§5 Writing][§5]: the pass the engine runs.
- [§6 Reading][§6]: history through the archive.
- [§7 Cursors and `rev`][§7]: `rev` is the writer's own policy.
- [§8 Conformance][§8]: envelopes, and replay from `session_units` alone, which the Absences
  replay item checks. The rewind here (a rewrite read as `reset`, with units left) is none of that
  item's three cases (a source reset to empty, a delta read's gone keys, a vanished source).

## What it needs

- A ClickHouse target (`SSQL_CH_URL`, with `SSQL_CH_USER` and `SSQL_CH_PASSWORD`), a PostgreSQL
  target (`SSQL_PG_URL`), or both, from the environment as the conformance kit takes them. Point
  them only at a disposable deployment.
- Node.js 24, and the kit's one dependency (`npm ci` in `conformance/`). No session adapter.

The example creates two databases (ClickHouse) or schemas (PostgreSQL) of its own, the live one and
the replayed one, loads `schema/` in each, and drops both when it ends, fails or is interrupted.

## Run it

From the repository root:

```sh
(cd conformance && npm ci)
SSQL_CH_URL=http://localhost:8123 SSQL_CH_USER=kit SSQL_CH_PASSWORD=… \
  node examples/04-raw-and-derived/example.mjs --profile clickhouse
SSQL_PG_URL=postgres://kit:…@localhost:5432/kit \
  node examples/04-raw-and-derived/example.mjs --profile postgres
```

The example exits 1 if the replayed tables differ from the live ones.

## Expected output

Both profiles print the same lines.

<!-- expected: clickhouse, postgres -->
```text
pass 1: read reset, units 0, 54, 120
pass 2: read appended, units 166
pass 3: read reset, units 0, 54
the archive, session_units (spec §4.1):
  generation 1: units 0, 54, 120, 166
    read manifest: progress 1, reset, units 0, 54, 120, gone none
    read manifest: progress 2, appended, units 166, gone none
  generation 2: units 0, 54
    read manifest: progress 3, reset, units 0, 54, gone none
the derived messages (session_parts): current m-1, m-2; removed versions m-3, m-4
the cursor (session_sources): 1 row(s)
replayed in a fresh namespace from session_units alone (its session_sources: 0 row(s))
  sessions: 1 row(s) live, 1 replayed
  session_parts: 4 row(s) live, 4 replayed
  session_usage: 0 row(s) live, 0 replayed
  session_links: 0 row(s) live, 0 replayed
  session_lifecycle: 0 row(s) live, 0 replayed
the replayed tables match the live ones, removed versions included
```

[§2]: ../../01-SESSIONS-SQL-SPEC.md#2-core-principles
[§4.1]: ../../01-SESSIONS-SQL-SPEC.md#41-session_units--the-archive
[§4.6]: ../../01-SESSIONS-SQL-SPEC.md#46-session_sources-informative
[§5]: ../../01-SESSIONS-SQL-SPEC.md#5-writing-the-engines-side-of-the-seam
[§6]: ../../01-SESSIONS-SQL-SPEC.md#6-reading-extraction
[§7]: ../../01-SESSIONS-SQL-SPEC.md#7-cursors-and-rev
[§8]: ../../01-SESSIONS-SQL-SPEC.md#8-conformance

# 05. Full-blown: adapters, engine, kit

A Node.js script, both database profiles. A consumer reads three small synthetic harness stores
through the real session adapters, over two passes, and the reference engine writes what it reads
into a fresh namespace. The example reads the current state back, then runs the conformance kit,
which checks the reference engine against the same target.

## What it shows

- **The seam end to end.** The harness stores are copies of three fixture cases of the
  session-adapters package (`claude-code/basic`, `codex/basic`, `opencode/features`), all
  synthetic. A consumer reads each store through its harness's adapter (`list`, then `read` of
  every source from where it was left) and hands each read to the engine as an **envelope**
  ([§8], Envelopes). The consumer is the kit's own `Reader`
  ([`conformance/envelopes.mjs`](../../conformance/envelopes.mjs)), which keeps each source's
  position between passes; the engine is the reference engine
  ([`conformance/reference/engine.mjs`](../../conformance/reference/engine.mjs)), running the write
  protocol of [§5] for each pass.
- **A change between passes.** Before pass 2 the OpenCode store deletes its latest message, as
  OpenCode deletes rows after a revert. The other two stores do not change, so their reads in pass
  2 deliver nothing new. The OpenCode read reports the message gone, and its rows get removed
  versions ([§2], principle 3).
- **The current state, per harness** ([§6]): sessions, messages, part rows, tool calls, usage
  records and link statements. Then the removed versions, the **edges** the engine resolved from
  the link statements (`owner = 'engine'`: the OpenCode child session and its parent's `task`
  call merge into one subagent edge, `stated_on` both, [§4.5]), and the size of the archive
  ([§4.1]). Its read manifests number one per read, 80 for 80 reads: the reference engine writes a
  manifest even for a read that changes nothing, such as the unchanged reads of pass 2, which
  §4.1 lets an engine omit.
- **The conformance kit** ([§8]): the example runs [`conformance/run.mjs`](../../conformance/run.mjs)
  with `--profile` against the same target, with the reference engine (`SSQL_ENGINE` unset), and
  prints one line per §8 item and the kit's exit code. The kit opens namespaces of its own; it never
  reads the example's. The two legacy items are ClickHouse database profile items, `n/a` on
  PostgreSQL. Database profile parity needs both profiles in one run, so a `--profile` run reports
  it `not run`: run `node conformance/run.mjs` with both targets set to check it.

## Spec sections

- [§2 Core principles][§2]: principle 3, removed content is kept.
- [§4.1 `session_units`][§4.1]: the archive and its read manifests.
- [§4.5 `session_links`][§4.5]: statements and edges.
- [§5 Writing][§5]: the pass.
- [§6 Reading][§6]: current state.
- [§8 Conformance][§8]: envelopes, and every item the kit checks.
- [§9 Status][§9]: the fixtures, read from a checkout of the session-adapters package.

## What it needs

- A ClickHouse target (`SSQL_CH_URL`, with `SSQL_CH_USER` and `SSQL_CH_PASSWORD`), a PostgreSQL
  target (`SSQL_PG_URL`), or both, from the environment as the conformance kit takes them. Point
  them only at a disposable deployment: the kit creates and drops namespaces of its own there.
- **The session adapters**, `@agent-realm/session-adapters` 1.0.0 (`packages/session-adapters` of
  [harness-skeleton][harness-skeleton]), named by `SSQL_ADAPTERS` as the kit names them. Two ways
  to get them:
  - **From source**, which this example needs: it reads the package's `fixtures/` folder, which a
    checkout has and a published package does not ship ([§9]). Version 1.0.0 is harness-skeleton
    commit `5ab0659`:

    ```sh
    git clone https://github.com/agent-realm/harness-skeleton
    git -C harness-skeleton checkout 5ab0659
    export SSQL_ADAPTERS=$PWD/harness-skeleton/packages/session-adapters
    ```

  - **From npm, once published:** `npm install @agent-realm/session-adapters@1.0.0` in
    `conformance/`, and `SSQL_ADAPTERS=@agent-realm/session-adapters` (a package name resolves
    from the kit's folder). That loads the adapters, which is enough for the kit's checks that
    need no fixtures, but not for this example.

  Without `SSQL_ADAPTERS`, or with a package that has no `fixtures/`, the example is skipped (exit
  3), with the reason. The expected output below is 1.0.0's: the examples' test fails the example,
  without running it, when `SSQL_ADAPTERS` names another version.
- Node.js 24, and the kit's one dependency (`npm ci` in `conformance/`).

The example creates a database (ClickHouse) or schema (PostgreSQL) of its own and drops it when it
ends, fails or is interrupted; an interrupt stops the kit first, which drops its own. The fixture
copies live in a temporary folder only while the passes are read.

## Run it

From the repository root, with `SSQL_ADAPTERS` set as above:

```sh
(cd conformance && npm ci)
SSQL_CH_URL=http://localhost:8123 SSQL_CH_USER=kit SSQL_CH_PASSWORD=… \
  node examples/05-full-blown/example.mjs --profile clickhouse
SSQL_PG_URL=postgres://kit:…@localhost:5432/kit \
  node examples/05-full-blown/example.mjs --profile postgres
```

To check an engine of your own instead of the reference engine, run the kit with `SSQL_ENGINE`
([`conformance/README.md`](../../conformance/README.md), Plugging in an engine).

## Expected output

The counts are those of session-adapters 1.0.0's fixtures; another version of the package can
change them.

<!-- session-adapters: 1.0.0 -->

<!-- expected: clickhouse -->
```text
pass 1: 40 reads of claude-code/basic, codex/basic, opencode/features
pass 2: 40 reads, after the OpenCode store deleted its latest message
the current state, per harness:
  harness      sessions  messages  part_rows  tool_calls  usage_records  link_statements
  claude-code  1         25        25         4           9              0
  codex        1         24        27         4           5              0
  opencode     7         24        64         9           9              2
removed versions (session_parts, removed = 1): opencode 1 message(s), 4 part row(s)
edges (session_links, owner = engine):
  harness   kind      stated_on  evidence
  opencode  subagent  both       explicit
the archive: 185 unit row(s), 80 read manifest(s)
the conformance kit, the reference engine, --profile clickhouse:
  1. Tables and keys: pass
  2. Twice is once: pass
  3. Crash-safe: pass
  4. Removed equals not live: pass
  5. Edges outlive statements correctly: pass
  6. Zero-part messages: pass
  7. Registries take new values: pass
  8. Host form: pass
  9. No time partition: pass
  10. Units only: pass
  11. Legacy content_sha, line format: pass
  12. Legacy content_sha, whole rows: pass
  13. Two hosts, two sessions: pass
  14. Absences replay: pass
  15. No-op manifests: pass
  16. Re-derive from the archive: pass
  17. Null is unknown: pass
  18. Redaction holds: pass
  19. Database profile parity: not run
  the kit exited 0
```

<!-- expected: postgres -->
```text
pass 1: 40 reads of claude-code/basic, codex/basic, opencode/features
pass 2: 40 reads, after the OpenCode store deleted its latest message
the current state, per harness:
  harness      sessions  messages  part_rows  tool_calls  usage_records  link_statements
  claude-code  1         25        25         4           9              0
  codex        1         24        27         4           5              0
  opencode     7         24        64         9           9              2
removed versions (session_parts, removed = 1): opencode 1 message(s), 4 part row(s)
edges (session_links, owner = engine):
  harness   kind      stated_on  evidence
  opencode  subagent  both       explicit
the archive: 185 unit row(s), 80 read manifest(s)
the conformance kit, the reference engine, --profile postgres:
  1. Tables and keys: pass
  2. Twice is once: pass
  3. Crash-safe: pass
  4. Removed equals not live: pass
  5. Edges outlive statements correctly: pass
  6. Zero-part messages: pass
  7. Registries take new values: pass
  8. Host form: pass
  9. No time partition: pass
  10. Units only: pass
  11. Legacy content_sha, line format: n/a
  12. Legacy content_sha, whole rows: n/a
  13. Two hosts, two sessions: pass
  14. Absences replay: pass
  15. No-op manifests: pass
  16. Re-derive from the archive: pass
  17. Null is unknown: pass
  18. Redaction holds: pass
  19. Database profile parity: not run
  the kit exited 0
```

[harness-skeleton]: https://github.com/agent-realm/harness-skeleton
[§2]: ../../01-SESSIONS-SQL-SPEC.md#2-core-principles
[§4.1]: ../../01-SESSIONS-SQL-SPEC.md#41-session_units--the-archive
[§4.5]: ../../01-SESSIONS-SQL-SPEC.md#45-session_links-statements-and-edges
[§5]: ../../01-SESSIONS-SQL-SPEC.md#5-writing-the-engines-side-of-the-seam
[§6]: ../../01-SESSIONS-SQL-SPEC.md#6-reading-extraction
[§8]: ../../01-SESSIONS-SQL-SPEC.md#8-conformance
[§9]: ../../01-SESSIONS-SQL-SPEC.md#9-status

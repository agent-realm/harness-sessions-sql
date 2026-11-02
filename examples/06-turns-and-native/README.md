# 06. Turns, and a native field

A Node.js script, both database profiles, v1.1. A consumer reads one small synthetic Claude Code
store through the real session adapter, and the reference engine writes it into a fresh namespace.
The example loads the reading view of [§6], reads the session's turns through it, and follows one
message's `native` field back to the raw line it came from, through the message's `units`.

## What it shows

- **The store.** A copy of the fixture case `claude-code/features` of the harness-session-adapters
  package, synthetic: one session with prompts, a tool call and its results, an error, a subagent
  message, a compaction and its summary. The consumer is the kit's own `Reader`
  ([`conformance/envelopes.mjs`](../../conformance/envelopes.mjs)), and the engine the reference
  engine ([`conformance/reference/engine.mjs`](../../conformance/reference/engine.mjs)), as in
  example 05.
- **The reading view** ([§6], plan): [`schema/clickhouse-views.sql`](../../schema/clickhouse-views.sql)
  or [`schema/postgres-views.sql`](../../schema/postgres-views.sql), loaded after the tables, as one
  statement. In ClickHouse it is a parameterized view, `session_turns(host = …, harness = …,
  harness_path = …, session_id = …, incarnation = …)`, whose parameters filter `session_parts` on
  its sort-key prefix before `FINAL`. In PostgreSQL it is a SQL function of the same name and shape.
- **A session's turns.** A turn starts at a message a person sent in the main conversation (`role`
  `user`, `source` `user`, `agent_id` `''`) and runs to the next one; messages before the first
  prompt are turn 0. Per turn: its prompt, its first and last `ts`, its messages, tool calls and
  failed tool results, and the models that served it, in byte order. The subagent's message
  (`agent_id` set) and the compaction summary (`source` `automated`) start no turn. A text block
  that Claude Code keeps beside tool results in one line is a message of its own, sent by the
  person, so it starts a turn.
- **A native field** ([§4.3]): the message whose response stopped for a tool call. Its
  `message_native` holds the values of the Claude Code fields the adapter declares for a message
  (sessions-model §2.7), keyed by their path: `userType` and `message.stop_reason`. ClickHouse keeps
  canonical JSON text and PostgreSQL `jsonb`, which orders keys its own way, so the example prints
  canonical JSON.
- **The way back to the raw line** ([§4.3], [§4.1], [§6]): the message's `message_units` triple
  `(source_key, generation, unit_key)`, joined with a `LEFT JOIN` to `session_units`, gives the
  line as Claude Code wrote it, and the line holds the same values. The SQL differs between the
  profiles: ClickHouse's `ARRAY JOIN` over named tuples, PostgreSQL's `jsonb_array_elements`.
- **A time for the view, indicative only.** The example reads `session_turns` 20 times and prints
  the median on standard error, never in the checked output: a fixture-sized session on whatever
  machine runs it says nothing about a house of realistic size.

## Spec sections

- [§4.1 `session_units`][§4.1]: the archive.
- [§4.3 `session_parts`][§4.3]: `message_native`, `message_units`.
- [§6 Reading][§6]: the reading view, and reading a record's units.

## What it needs

As example 05: a ClickHouse target, a PostgreSQL target, or both; the session adapters,
`@agent-realm/harness-session-adapters` 1.1.0 from source, named by `SSQL_ADAPTERS`, because the
example reads the package's `fixtures/` ([`05-full-blown/README.md`](../05-full-blown/README.md)
says how to get it); Node.js 24, and the kit's one dependency. Without `SSQL_ADAPTERS`, or with a
package that has no `fixtures/`, the example is skipped (exit 3), with the reason. The expected
output below is 1.1.0's: the examples' test fails the example, without running it, when
`SSQL_ADAPTERS` names another version.

The example creates a database (ClickHouse) or schema (PostgreSQL) of its own, loads the tables and
the view into it, and drops it when it ends, fails or is interrupted.

## Run it

From the repository root, with `SSQL_ADAPTERS` set:

```sh
(cd conformance && npm ci)
SSQL_CH_URL=http://localhost:8123 SSQL_CH_USER=kit SSQL_CH_PASSWORD=… \
  node examples/06-turns-and-native/example.mjs --profile clickhouse
SSQL_PG_URL=postgres://kit:…@localhost:5432/kit \
  node examples/06-turns-and-native/example.mjs --profile postgres
```

## Expected output

The same on both profiles. The time goes to standard error, so it is not part of it.

<!-- harness-session-adapters: 1.1.0 -->

<!-- expected: clickhouse, postgres -->
```text
one pass: 1 read(s) of claude-code/features
session 0f5e1c2a-7b3d-4e8f-a9c1-2d3e4f5a6b7c, its turns (session_turns, §6):
  turn  prompt_message_id                      started_at                ended_at                  messages  tool_calls  tool_errors  served_models
  1     00000000-0000-4000-a000-000000000001    2026-01-05T10:00:01.000Z  2026-01-05T10:00:04.000Z  5         2           1            ["claude-opus-4-1"]
  2     00000000-0000-4000-a000-000000000005+1  2026-01-05T10:00:04.000Z  2026-01-05T10:00:04.000Z  1         0           0            []
  3     00000000-0000-4000-a000-000000000006    2026-01-05T10:00:05.000Z  2026-01-05T10:00:07.000Z  3         0           0            ["<synthetic>"]
  4     00000000-0000-4000-a000-000000000009    2026-01-05T10:00:08.000Z  2026-01-05T10:00:12.000Z  6         1           0            ["claude-opus-4-1","gateway/toy-model"]
message 00000000-0000-4000-a000-000000000004:
  message_native: {"message.stop_reason":"tool_use","userType":"external"}
  message_units: [projects/-work-toy-repo/0f5e1c2a-7b3d-4e8f-a9c1-2d3e4f5a6b7c.jsonl, 1, 1355], chunk 0, enc utf8, continuity reset
  the raw line: message.stop_reason tool_use, userType external
```

[§4.1]: ../../01-SESSIONS-SQL-SPEC.md#41-session_units--the-archive
[§4.3]: ../../01-SESSIONS-SQL-SPEC.md#43-session_parts
[§6]: ../../01-SESSIONS-SQL-SPEC.md#6-reading-extraction

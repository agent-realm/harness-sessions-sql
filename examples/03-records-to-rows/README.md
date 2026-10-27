# 03. Records in, rows out

A small Node.js script, both database profiles. It takes a few synthetic sessions-model records,
maps them to rows the way the specification says, writes them, and runs the common reads: a
session whole, its messages in order, its tool calls with their results, and its usage totals.

## What it shows

- **The records** ([sessions-model][sessions-model] §2): one session, four messages (a user
  prompt; an assistant reply with a text part and a tool call; the tool's result; a closing
  reply), and two usage records. They are written by hand in [`example.mjs`](example.mjs), with
  every field of their type, and sealed as an adapter seals what it derives
  ([`../lib/records.mjs`](../lib/records.mjs)): each record's `content_sha` is the sha256 of its
  canonical JSON without the two hashes, and each message's `cmp_sha` the sha256 of its role and
  what its parts say.
- **The mapping** is the reference engine's, imported from
  [`conformance/reference/rows.mjs`](../../conformance/reference/rows.mjs) (`rowsOf`), not copied:
  - one `sessions` row per session, one `session_usage` row per usage record ([§4.2], [§4.4]);
  - one `session_parts` row per part, each carrying its message's columns: the assistant reply
    with two parts is two rows ([§3], [§4.3]);
  - a part row's `content_sha` is the sha of the part object as the record holds it, and its
    `message_content_sha` the message's own `content_sha`, so a part that did not change keeps its
    sha when a sibling changes ([§4]). The example checks this against its records and prints the
    first 12 hex digits.
- **The reads** ([§6]), in each profile's SQL (`FINAL` and `is_deleted = 0` in ClickHouse,
  `NOT is_deleted` in PostgreSQL):
  - a session whole: its tables joined on the session key, needing no harness and no adapter;
  - its parts in order: by `order_key` (sessions-model's `order`, a reserved word in SQL), then
    `ts`, then the part's native order;
  - a tool call with its result: two part rows of one session joined on `call_id`;
  - usage totals as [§4.4] defines them: the stored counts added up as `input_includes_cache` and
    `output_includes_reasoning` say. The records carry Anthropic-style counts (cached input beside
    `input`, reasoning inside `output`), and set both flags. Where a flag is null, §4.4 does not
    say what the total is; the example's SQL leaves it null (unknown), a choice of its own while
    that question is open.

Every row is written at `rev` 1 with a plain insert into empty tables, through the kit's
`insertRows`: a first write. Later versions follow the write rule that
[example 02](../02-revisions-and-removals/) shows.

## Spec sections

- [§3 Keys and versioning][§3]: messages and parts share one table.
- [§4 Schema][§4]: `content_sha` and `message_content_sha`.
- [§4.2 `sessions`][§4.2], [§4.3 `session_parts`][§4.3], [§4.4 `session_usage`][§4.4]: the
  columns, and the usage totals.
- [§6 Reading][§6]: current state, and a session whole.

## What it needs

- A ClickHouse target (`SSQL_CH_URL`, with `SSQL_CH_USER` and `SSQL_CH_PASSWORD`), a PostgreSQL
  target (`SSQL_PG_URL`), or both, from the environment as the conformance kit takes them. Point
  them only at a disposable deployment.
- Node.js 24, and the kit's one dependency (`npm ci` in `conformance/`). No session adapter.

The example creates a database (ClickHouse) or schema (PostgreSQL) of its own, loads `schema/` in
it, and drops it when it ends, fails or is interrupted.

## Run it

From the repository root:

```sh
(cd conformance && npm ci)
SSQL_CH_URL=http://localhost:8123 SSQL_CH_USER=kit SSQL_CH_PASSWORD=… \
  node examples/03-records-to-rows/example.mjs --profile clickhouse
SSQL_PG_URL=postgres://kit:…@localhost:5432/kit \
  node examples/03-records-to-rows/example.mjs --profile postgres
```

## Expected output

Both profiles print the same lines.

<!-- expected: clickhouse, postgres -->
```text
rows written: sessions 1, session_parts 5, session_usage 2
the session, whole (its tables joined on the session key):
  session_id         title                   state   messages  part_rows
  example-session-3  List the project files  active  4         5
its messages, one row per part, in order:
  message_id  part_id  role       kind         says
  m-1         0        user       text         List the files in this folder.
  m-2         0        assistant  text         I will run ls.
  m-2         1        assistant  tool_call    shell {"command":"ls"}
  m-3         0        tool       tool_result  "README.md\nsrc"
  m-4         0        assistant  text         The folder holds README.md and src.
tool calls with their results (joined on call_id):
  tool   args              is_error  exit_code  output_len
  shell  {"command":"ls"}  NULL      0          13
usage, with the totals of spec §4.4:
  usage_id           input  cache_read  cache_write  output  total_input  total_output
  response:resp-1#1  120    900         300          35      1320         35
  response:resp-2#1  15     1200        40           20      1255         20
the shas of m-2's two rows (first 12 hex digits; checked against its records):
  part_id  content_sha   message_content_sha
  0        a3f02a2c45b6  3116111fd298
  1        cd8f749a752a  3116111fd298
```

[sessions-model]: https://github.com/agent-realm/sessions-model/blob/main/contracts/sessions-model.md
[§3]: ../../01-SESSIONS-SQL-SPEC.md#3-keys-and-versioning
[§4]: ../../01-SESSIONS-SQL-SPEC.md#4-schema
[§4.2]: ../../01-SESSIONS-SQL-SPEC.md#42-sessions
[§4.3]: ../../01-SESSIONS-SQL-SPEC.md#43-session_parts
[§4.4]: ../../01-SESSIONS-SQL-SPEC.md#44-session_usage
[§6]: ../../01-SESSIONS-SQL-SPEC.md#6-reading-extraction

# sessions-sql — Specification

**version:** v1
**status:** the table shapes and semantics of v1, proposed. Under AGENTS.md rule 2, no table or
key is normative until a working implementation or a fixture test backs it. The conformance kit's
fixture tests back every §8 item through its reference engine, on both database profiles.
memhouse's capture engine is the first production implementation, and these shapes will be
reconciled against it (§9).
**provides:** the `sessions-sql` mapping: how session records are kept in SQL.
**consumes:**
[`sessions-model`][sessions-model] v1.3 (the records) and
[`sessions`][sessions] v1.3 (the seam), or any later v1.x. Its ClickHouse database profile uses common conventions:
ReplacingMergeTree versioned by `rev` with an `is_deleted` flag, `DateTime64` in UTC, and a
server-stamped `writer` column.

`sessions-sql` defines how the records of `sessions-model` are stored as SQL rows. It covers:
- the raw archive;
- the entity tables for sessions, messages with their parts, usage, link statements, edges and
  lifecycle records;
- their keys;
- how a revision and a removal are written;
- what a reader sees as the current state.

**ClickHouse is the normative database profile.** PostgreSQL is a second database profile over the same logical
keys, and the two may be mixed.

The aim is a reference for mapping session data to a database: ClickHouse first but not only,
PostgreSQL where a transactional persistence layer serves better, or a mix of both.

## 1. Overview

A consumer of the `sessions` seam receives:
- **raw units**: verbatim native records, already redacted;
- **normalised records**, which `derive` produces from those units;
- **`live` key sets**, which say what currently exists.

`sessions-sql` says where each of these lands and how the rows stay correct under the seam's
guarantees:
- replays are safe;
- `derive` is pure;
- every record has a key;
- a revision or a removal is visible as a set difference.

### Design goals

- **Re-derivable.** Every entity row can be rebuilt from the archive alone. A model, mapping or
  adapter change re-derives; it never patches rows in place.
- **Extractable.** The tables are plain, harness-neutral rows keyed exactly as sessions-model
  keys its records. Any reader can extract a session's state and its history without a harness
  or an adapter.
- **Correct without transactions.** Writes are idempotent and versioned, so a crash between any
  two writes, or a replay, converges to the same state. Transactions (PostgreSQL) are allowed
  but never required for correctness.

### Out of scope (v1)

- **Cursor storage and `rev` derivation** are consumer policy (see §7). `session_sources` (§4.6)
  shows one cursor layout and is informative: no conformance check needs it, and replay never
  reads it (§4.1).
- **Other harness state:** prompt history, memory files, checkpoints, settings. These are
  extracted through harness-skeleton's path classes, not mapped here.
- **Search indexes and derivatives**, such as full-text or embeddings. They are a consumer's
  choice, built on these tables.

## 2. Core principles

1. **The archive is the truth.** `session_units` keeps every raw unit the seam delivered. Entity
   tables are a projection of it.
   - **Forgotten content is held by no row.** Where an engine honours forget notices (sessions
     v1.1), a forgotten unit's content survives in no row: not in `session_units`, not in a
     removed version, not in a derived column. The forget rules are the one exception to the
     archive being append-only and to history rows never being recomputed.
2. **Keys come from the contract, verbatim.** A session belongs to one data folder on one host
   (sessions-model §1 rule 1), so the session key is
   `(host, harness, harness_path, session_id, incarnation)`, and every table's key starts with it.
   `harness_path` is the data folder's real path (sessions-model §1): absolute, symlinks
   resolved, in the case the filesystem stores. `host` is the sessions-model §1 value: the
   first 32 lowercase hex digits of sha256(`"sessions-model/host/v0:"` + the OS machine id), or
   `r-` + 32 hex where no machine id can be read, or, for a service-held harness store (claude.ai's
   conversations, read from an export; sessions-model v1.3), `s-` + 32 hex derived from the
   service's domain, with the service's origin (`https://claude.ai`) as `harness_path`. It is never
   a hostname. Both database profiles reject any
   other form, a Postgres `CHECK` and a ClickHouse `CONSTRAINT` on every key `host`, with one
   exemption: a row whose `adapter` is `legacy` (§4.8). The display name sits in
   `sessions.host_label` and is never part of a key.
3. **Removed content is kept (plan).** A key that it held and that a derive no longer lists in
   `live` (sessions §4) is written again as a **removed version**: a full copy of its last row,
   at a higher `rev`, with `is_deleted = 0` and `removed = 1`. The row keeps its last
   adapter-set `state` (current, reverted, retracted), so removing a reverted message does not
   lose that it was reverted.
   - Removed versions are never counted as live, and they stay searchable as history.
   - **Physical deletion** (ClickHouse `is_deleted = 1`, Postgres `DELETE`) is only for true
     duplicates: converted rows that match captured ones, and rows under keys that an upgraded
     adapter no longer produces at all.
   - A key that a derive produced and a later derive no longer lists is a removal, even when both
     derives ran in one capture pass over one append: it gets a removed version, never a deletion.
     It cannot come from a half-read unit, because an adapter holds an incomplete unit back
     (sessions §3) and a streaming record in `held`.
   - A consumer may tombstone vanished keys instead; sessions §4 allows either. This mapping
     writes removed versions.
4. **Revisions only go forward.** Every entity row carries `rev`. A row with a lower or equal
   `rev` never replaces one with a higher `rev`. A changed row takes a strictly higher `rev`. An
   equal `rev` is allowed only for a byte-identical re-send of the same row: with two different
   rows at one `rev`, ClickHouse may keep either, and PostgreSQL keeps the first. How `rev` is
   derived is consumer policy (§7).
5. **Server-stamped identity.** Where the deployment uses per-principal writes, each row's
   writer is a `MATERIALIZED currentUser()` column that is never in a key.
6. **Already redacted.** Rows hold what the adapter emitted, redacted under sessions-model §4.
   For the redacted fields, the archive is not a verbatim copy of the harness's data, and nothing
   here can restore them.
7. **Registries hold any value.** sessions-model §8 makes `harness`, a session's `ts_source` and
   a unit's `enc` registries, which grow in v1.x, and sessions §5 makes a source's
   `position_kind` one. Their columns are `LowCardinality(String)` in ClickHouse and `text` in
   PostgreSQL, never an `Enum` or a `CHECK` list, so a value a v1.x adds needs no `ALTER` and no
   row is refused for a value its database has not seen. A source's position is kept opaque
   (`session_sources.position`), whatever its kind. A closed list's column may be constrained.

## 3. Keys and versioning

Pieces marked **(plan)** are not yet proved by a production implementation (§9). They follow the rule that a session belongs to one harness store
(sessions-model §1 rule 1).

| Table | Identity (normative), after the session key `S = (host, harness, harness_path, session_id, incarnation)` | Version |
|---|---|---|
| `session_units` | `S + (source_key, generation, unit_key, chunk, sha256)` | none: append-only; an identical re-send collapses |
| `session_sources` (informative) | `S + (source_key)` | `ver = generation·2^40 + progress` |
| `sessions` | `S` | `rev`, `is_deleted` |
| `session_parts` | `S + (message_id, part_id)` | `rev`, `is_deleted` |
| `session_usage` | `S + (usage_id)` | `rev`, `is_deleted` |
| `session_links` | `S + (owner, kind, other_host, other_harness_path, other_harness, other_session_id, other_incarnation, at)` | `rev`, `is_deleted` |
| `session_lifecycle` | `S + (lifecycle_id)` | `rev`, `is_deleted` |

Notes on the table:
- `incarnation` is `''` wherever `reuse = impossible`, and otherwise separates lives of one id
  inside one harness store.
- **No cross-host identity.** The same native session read on two hosts is two sessions, with two
  sets of rows. There is no owner, no copy table and no divergence check.
- **Messages and parts share one table.** `session_parts` holds one row per part and repeats its
  message's columns. A message with no parts (an assistant `content: []`, a refused turn) is one
  header row with `part_id = ''` and `kind = 'none'`, so its status and usage anchor survive
  (plan).
- A consumer's own tables beside these (a table of tool calls derived from `session_parts`, for
  example) and its physical naming are its own business; this specification describes only the
  tables above.

**Derived columns.** A deployment may add derived columns to §3 tables (`sessions.first_prompt`,
for example).
- **From one session's current records only.** A derived column holds only values taken from that
  session's own records, never another session's. It adds no data those records do not have, and
  the redaction rules hold for it as for the records it copies.
- **It follows its sources.** When a record it copies is revised, removed or forgotten, the derived
  column is recomputed, in a new version of its row (principle 4). It never keeps a value the
  session's current records no longer hold: not a removed message's text, not a forgotten unit's
  content.
- **It stays out of identity.** A derived column never enters a key or a `content_sha` (as §4.8
  already says for added columns), so database profile parity (§8) is unaffected.

**Physical table names.** The tables above are logical names. A deployment may prefix every name (for
example one prefix per tenant of a shared database) and may keep `session_units` in a
database of its own. It must say so in one place, for example its schema template. A database
conforms when every logical table exists under those names. The `ORDER BY` (ClickHouse) or
primary key (PostgreSQL) must hold the identity columns above as a set, and their order is the
deployment's: a ReplacingMergeTree replaces on the whole key whatever its order. The order given
in `schema/` is the recommended one.

**ClickHouse.**
- Entity tables use `ReplacingMergeTree(rev, is_deleted)`. Their `ORDER BY` is the identity
  above, because a ReplacingMergeTree replaces on the whole sort key.
- **`ts` is Nullable, and is never a partition key.** A missing `ts` stays null (sessions-model §1
  rule 7). A consumer that wants a first-seen time keeps it in a column of its own, never in `ts`,
  because two consumers, or two re-derives, can see a record first at different times.
  - No entity table is partitioned by time. A ReplacingMergeTree replaces only within a
    partition, so two versions of one key in two time partitions never collapse on disk.
    Tested with ClickHouse 26.11: a key whose `ts` differed between versions kept 3 physical rows
    after `OPTIMIZE FINAL`. `FINAL` read 1 row by default, but 3 with
    `do_not_merge_across_partitions_select_final = 1`.
  - A consumer may prefix the sort key with columns that never change for a key, such as
    `toDate(ts)` for messages: sessions-model §1 rule 7 guarantees that `ts` never changes. A
    Nullable column in the sort key needs `SETTINGS allow_nullable_key = 1` (without it,
    ClickHouse refuses the table with Code 44). With it, null-`ts` versions of one key collapse,
    as tested.
- Current state is read with `FINAL`, or with `argMax(…, rev)`, filtering `is_deleted = 0` and
  `removed = 0`.
- `session_units` uses `ReplacingMergeTree()` with `sha256` in the key, so the byte history of
  a unit is kept and an identical re-send collapses.

**PostgreSQL.**
- The identity above is the `PRIMARY KEY`.
- Writes are `INSERT … ON CONFLICT (pk) DO UPDATE SET … WHERE excluded.rev > <table>.rev`. A
  removed version is the same upsert with `removed = 1`. `DELETE` is only for true
  duplicates (principle 3).
- `session_units` inserts use `ON CONFLICT DO NOTHING`.
- Current state is `WHERE NOT is_deleted AND removed = 0`.

**Mixed.** The archive and the entity tables may live in different engines, for example a
ClickHouse archive with PostgreSQL entity tables for transactional readers. Correctness rests
on `rev`, so the two converge in any order.

## 4. Schema

Logical columns follow; the DDL is in `schema/clickhouse.sql` (normative) and
`schema/postgres.sql`. Common to every entity table:
- `content_sha`: the sha256 hex of the record's canonical JSON (sessions-model §2). On
  `session_parts` the record is the part: `content_sha` is the sha of the part object as it sits
  in its message's `parts` (as the adapter emitted it, `exit_code: null` included), and
  `message_content_sha` is the message's own `content_sha`. A part that did not change keeps its
  sha when a sibling changes. A message's header row (`part_id = ''`, `kind = 'none'`) carries
  the message's sha in both columns;
- `rev`, `is_deleted`, and `removed` (the consumer's flag for a removed version);
- `adapter`, `adapter_ver` and `model_version`, as the adapter's output states them (sessions §5).
  `adapter_ver` is a string column (`LowCardinality(String)`, `text`) that holds the version
  string as stated (`0.2.0`). The contract defines no order on versions, so no numeric encoding
  is defined here either;
- `ingested_at`.

### 4.1 `session_units` — the archive

Per raw unit:
- **identity:** the session key (which includes `host` and `harness_path`), `source_key`, `generation`,
  `unit_key`, `chunk` (the part number of a large unit stored in several chunks) and `sha256`;
- **content:** `enc` (`utf8` | `b64` | `row-json` | `rows-json` | `pb-json`), `orig_sha256`
  (a `pb-json` unit, or a `row-json` unit whose compressed column `read` decoded; sessions-model
  §3; null in both database profiles for a unit without one, and for a manifest), `redacted` and
  `raw`;
- **provenance:** `continuity` (the read that delivered the unit, a sessions §3 value) and
  `captured_at`.

`unit_key` is the decimal byte offset for a stream, the rowid or KV key for a delta
source, and the `source_key` for a snapshot. It is never empty: `unit_key = ''` is reserved for
read manifests.

**Units only, verbatim.** A unit row of `session_units` is a unit as an adapter's `read` emitted
it. The other rows there are read manifests (below), which the consumer writes. They are normal
rows, not exemptions.
- **A partial last line is not a unit.** `read` holds it back until it is whole (sessions §3), so
  it has no row here: replaying the archive must give what `read` gave. A consumer that wants to
  keep a fragment that never completed (a harness that died mid-line) keeps it outside the
  sessions-sql tables.
- **Two named exemptions in `session_units`** hold rows that are not an adapter's native units
  (the entity tables also exempt a third, `legacy`, §4.8). They are marked by
  their `adapter` value, in `session_units` and in the entity tables (§4.8):
  - `memhouse-bridge`: harnesses no session adapter covers yet, whose archive is a consumer's
    snapshot log;
  - `memhouse-log`: a consumer's sessions whose harness store is gone, archived as the consumer's
    own log lines from before it captured through the adapters.

  Replay through an adapter, and the conformance items that rest on it, do not apply to them.

**Read manifests: absences are archived too.** Unit rows alone cannot show that something went
away: a source reset to empty, a source that vanished, or a delta read's `gone` keys deliver no
units at all. So a read also archives one **read manifest** row in `session_units`, under the
same source and generation (only a read that changes nothing may omit it, below):
- `unit_key = ''`, `chunk = 0`, `enc = 'manifest'`, `orig_sha256` null, `continuity` as in
  `raw`, and `sha256` of `raw`;
- `raw` is a JSON object:
  `{"progress": <the session's pass counter>, "continuity": "appended" | "delta" | "reset" |
  "snapshot" | "unchanged", "units": [[unit_key, sha256], …], "gone": [unit_key, …],
  "source_gone": true | false, "policy": "kept" | "removed"}`. `units` lists every unit this read
  delivered (for an appended stream, the new offsets), and `gone` lists the unit_keys a `delta`
  read reports vanished. `policy` appears only with `"source_gone": true` (see below);
- **`continuity`** is the read's value as the seam returned it, from sessions §3's closed list,
  `unchanged` included. A `source_gone` manifest records no read: its `continuity` is `reset`,
  because it opens a generation as a reset does. `source_gone` stays a flag beside it, never a
  continuity value: the list is closed in v1 (sessions §5), and a vanished source is the
  consumer's decision, not a read's outcome;
- **`progress`** is the session's pass counter. Every manifest that one pass (§5) writes for the
  session, across all its sources, carries the same value, and a later pass a higher one. It
  orders the manifests, and groups them by pass for replay (below);
- a read that opens a generation (the first read of a source, every `reset` or `snapshot`)
  writes its manifest even when it delivers nothing, and a source that vanished gets a new
  generation whose manifest says `"source_gone": true`;
- a read that opens no generation, does not report `source_gone`, and changes nothing in the fold
  MAY omit its manifest. It changes nothing when the generation already holds every unit it lists,
  with the same `sha256`, and no longer holds any key in its `gone`: an `unchanged` read, an
  appended read with no new complete line, a delta read that repeats what the generation holds.
  Such a read adds nothing to the replay fold. Its `progress` is not needed either: replay reads
  `progress` from the archive only to order and group manifests, and a read that changes no
  record assigns no `rev` (§7). `source_gone` is never a no-op: it is always archived;
- a vanished source is not an empty one. A source that is still listed but reset to empty is an
  empty source, and its records leave `live`. A source the harness store no longer has (the
  session's file deleted, so `list` omits it) is consumer policy: the sessions contract only
  says `list` omits it. So its manifest records what the consumer did live, as
  `"policy": "kept"` (its records stay current, the archive outlives the harness store) or
  `"policy": "removed"` (they were removed or tombstoned). The policy is recorded per event, so a
  consumer that changes its policy later still replays each earlier event as it was handled;
- `"policy": "removed"` removes the source's units, and with them every record derived from them.
  It does not decide whether the session itself still exists: the session record stays current
  while the adapter's derive over the session's remaining units lists it in `live`.

**Replay from the archive alone.** For each source, the highest generation in `session_units` is
current. A generation with a manifest and no units is an empty source, and replays as empty. A
`source_gone` generation replays as its `policy` says: `"kept"` replays the last generation before
it as current, and `"removed"` replays as empty. A `source_gone` manifest without `policy`
(written before `policy` existed) replays as `"removed"`, so older archives keep their meaning.
Within the current generation, the manifests are folded in `progress` order: each adds its `units`
and drops its `gone`. Delivery order is the manifests' `progress` and, within one manifest, the
order of its `units` array, never the table's sort key: `unit_key` is a string, so a stream's
offsets sort `'100'` before `'20'`.

Replay derives a session **once per pass**: it folds every manifest of one `progress` value, each
source's latest generation so far being current, and then derives, as the live pass derived once
after all its reads. Deriving after each manifest instead could remove a key that was live only
between two sources' reads, which the live pass never removed. That gives exactly the units each
pass left current, so replaying `session_units` through `derive` reproduces every removal without
the entity tables or the cursor. `session_sources` (§4.6) is only a cursor: it keeps the latest row
per source, so it can never serve as history.

### 4.2 `sessions`

The fields of sessions-model §2.1:
- `harness`, `engine`, `client`, `harness_version`;
- `title`, `title_set_by`, `cwd`, `last_cwd`;
- `created_at`, `updated_at`;
- `state`, `pinned`, `mode`, `kind`, `reuse`, `ts_source`;
- `aliases`: an array of `(id, kind)`;
- `fingerprint`: the ordered `cmp_shas`;
- `setup`: the session's setup as JSON, or null (sessions-model §2.1): canonical JSON text in
  ClickHouse, `jsonb` in PostgreSQL, as `args` is.

### 4.3 `session_parts`

One row per part (sessions-model §2.3), carrying its message's fields (sessions-model §2.2).

Message fields:
- `parent_id`, `order_key` (sessions-model's `order`; `order` is reserved in SQL), `agent_id`;
- `role`, `source`, `to_user`, `to_model`, `status`, `state`, `on_active_branch`. `source` may be
  null (sessions-model §2.2: a tool result, a sender the harness store does not record), stored as
  `''` like every absent string;
- `ts`, `requested_model`, `served_model`, `effort`, `response_id`;
- `message_aliases`, `cmp_sha`, `message_content_sha`.

Part fields:
- `part_id` and `part_index` (native order);
- `kind`: `none` for a message with no parts;
- `text`;
- `call_id`, `tool_name`, `args` (JSON), `server`;
- `is_error`, `result_status`, `output`, `output_len`, `truncated`, `exit_code` (null where the
  harness store keeps no code apart from the output);
- `output_ref`, `output_ref_sha256`, `output_ref_bytes`: the `{ref, sha256, bytes}` of output kept
  elsewhere (sessions-model §2.3). The sha and length are absent when that content is no longer
  stored;
- `media_type`, `inline_b64` or `ref`, `bytes_len`;
- `opaque`, `signature_len`;
- `replaces`: the form and its value;
- `error_kind`, `error_message`, `http_status`;
- `level`, `native_type`;
- `part_source`, `part_state`: a part's own `source` and `state`, where they differ from its
  message's (sessions-model §2.3: an injected part in a user's message, a part a revert hides
  inside a message that stays); `''` where the part has none of its own.

A message-level change revises every part row of that message at the new `rev`. A row the revised
message no longer has gets a removed version, as a key that left `live` does (principle 3): a
part the message lost, its header row (`part_id = ''`) once it has parts, or its part rows once it
has none. It is never physically deleted: that would drop it from history, and the live pass
would no longer match its replay.

### 4.4 `session_usage`

The fields of sessions-model §2.4:
- `usage_id`;
- `anchor_kind` and `anchor_id`;
- `input`, `output`, `cache_read`, `cache_write`, `reasoning`, `tool_prompt`, `cost`, all
  nullable: null means unknown, and is never written as 0;
- `input_includes_cache` and `output_includes_reasoning`, nullable booleans: null means the
  adapter has nothing that establishes it (sessions-model §2.4). The numbers are stored as the
  adapter gave them, never converted. A reader's total input is `input`, plus `cache_read +
  cache_write` where `input_includes_cache` is false, plus `tool_prompt` where it is not null. Its
  total output is `output`, plus `reasoning` where `output_includes_reasoning` is false;
- `granularity`: one of sessions-model §2.4's values, `per_response`, `per_message`, `per_turn`,
  `per_session` or `per_record`. **`per_record`** is not a scope: its values are one response's
  usage, stored repeated on every record of that response, kept as given (memhouse 0.18's Claude
  Code rows, §4.8). No adapter emits it.
  - It always has a `response_id`, with `anchor_kind = 'response'`, and there is no fallback. A
    converter that lacks the native id mints one from a run of repeated rows, under the reserved
    prefix `legacy-run:` (sessions-model §2.4).
  - A reader counts one `per_record` usage per `response_id`: the last of its records in order
    (the greatest `n` in `usage_id` `response:<id>#n`), not the first and not a sum. It carries
    the response's total `output`, since the early records of a streamed response carry a partial
    one. A reader counts none where a `per_response` usage has the same `response_id`;
- `model`.

### 4.5 `session_links`: statements and edges

`owner` separates the two kinds of row.

**`owner = 'adapter'`: a statement.** This is what one session's derive stated
(sessions-model §2.5):
- `kind`, `stated_on`, `at`;
- the child and origin references, each `(host, harness_path, harness, session_id,
  incarnation-or-null)`. An empty `host` and `harness_path` mean the stating session's own harness store;
- the key names the other side as `(other_host, other_harness_path, other_harness,
  other_session_id, other_incarnation)`. `other_incarnation` is `''` when unknown, so links to two
  lives of one reused id (a Copilot `--session-id`) are two keys whenever the stating side knows
  the incarnations;
- `through_message_id`, `ids_preserved`, `marked`, `usage_copied`;
- `child_stored`: nullable in both database profiles. Null means unknown (a statement that does
  not say, such as an origin-side one) and is never written as a default;
- `evidence = 'explicit'`.

These rows are reconciled against `live` like every adapter-owned record.

**`owner = 'engine'`: an edge.** It is resolved, merged or inferred, and keyed on the child
session, with the origin as the other side. It carries:
- `stated_on` (`child` | `origin` | `both`);
- `evidence` (`explicit` | `inferred`);
- `verified`;
- the keys of the supporting statements.

An edge is written only when both its ends resolve to exactly one held session each
(sessions-model §2.5, resolution). Until then its statements wait, and no edge row exists. Its
references follow the statements' convention: an empty `host` and `harness_path`, in `other_*`,
`child_*` and `origin_*`, mean the child's own harness store.

An edge is **never reconciled against an adapter's `live`**. It ends when its last supporting
statement is removed, or when re-verification of an inferred edge fails. An edge that ends gets a
removed version, like a key that left `live` (principle 3), never a physical deletion.
Billing reads edges only, so inherited usage is billed once.

### 4.6 `session_sources` (informative)

Cursor storage is consumer policy (§1, sessions-model §5). This table is an engine's cursor, for
example one row per session and source, shown as a reference: a conforming database may keep its cursor elsewhere, and replay never reads it,
because the read manifests (§4.1) carry everything a replay needs.

**`session_sources`** is the cursor, one row per session and `source_key`, with:
- `mode` (`stream` | `delta` | `snapshot`) and `position` (opaque);
- `generation`;
- `state` (the derive state) and `state_ver`;
- `adapter` and `adapter_ver` (the version string, as in the entity tables);
- `progress` (the session's pass counter, §4.1), `committed_at`.

It is a ReplacingMergeTree on `ver = generation·2^40 + progress`.

### 4.7 `session_lifecycle`

One row per lifecycle record (sessions-model §2.6), keyed `S + (lifecycle_id)`:
- `op`: `rewind` | `edit` | `compaction` | `delete` | `archive` | `unarchive` | `rename` | `pin` |
  `unpin` | `fork` | `clear`;
- the target: `target_kind` (`message` | `range` | `session`), `target_id`, `target_from`,
  `target_through`;
- `at` (the native position, where the harness store gives one) and `ts`;
- `evidence` (`explicit`: lifecycle records exist only for operations the harness store records);
- `content_sha`, `adapter`, `adapter_ver`, `model_version`, `rev`, `is_deleted`, `removed`.

These rows are adapter-owned and reconciled against `live` like messages. A lifecycle record
explains a removal; it never replaces the removed version (or tombstone) of the keys it removed.

### 4.8 Rows no adapter derived: `legacy`, `memhouse-bridge`, `memhouse-log`

Three `adapter` values mark rows that a session adapter did not derive from native units. They
keep a consumer's history in the sessions-sql tables while they cannot be re-derived.
- **`legacy`:** a row converted from memhouse 0.18's database, written before sessions-sql. It has
  no archive, so it is never re-derived. No adapter stated a version for it: its `adapter_ver` is
  the string `0`, as the full-row vectors below show.
  - **Its `host`** is the host/v0 value where the machine reported the pair `(old host id →
    host/v0)` before the conversion. It keeps its old host id where no pair was reported, or where
    the reported pairs conflict (one old id, two host/v0 values: a cloned machine). The host
    form check exempts exactly these rows: `host` matches host/v0 OR `adapter = 'legacy'`. The
    link reference hosts (`other_host`, `child_host`, `origin_host`) get the same exemption.
  - **A `legacy` row exists only in a ClickHouse database profile.** Legacy conversion exists only
    for ClickHouse houses: it reads a consumer's memhouse 0.18 database, which is ClickHouse,
    inside that engine. A PostgreSQL database profile holds no `legacy` row, so both legacy items
    of §8 are ClickHouse database profile items, and the database profile parity check (§8)
    leaves `legacy` rows out.
  - **Its `content_sha`** is computed where the conversion runs, in SQL, so the same source row
    always converts to the same sha. It is the lowercase sha256 hex of one TabSeparated line:
    the row's columns, in this specification's DDL order for that table, leaving out
    `content_sha`, `rev`, `is_deleted`, `removed`, `ingested_at` and `writer` (and any column a
    deployment adds; in `session_parts`, also `message_content_sha` and `cmp_sha`), each in ClickHouse's TabSeparated text form (NULL as `\N`; tab, newline
    and backslash escaped as `\t`, `\n`, `\\`), joined by tabs, without the trailing newline. In
    ClickHouse: `lower(hex(SHA256(trimRight(formatRow('TabSeparated', <columns>), '\n'))))`.
    - **What pins the bytes.** The conversion sets these to their defaults explicitly:
      `format_tsv_null_representation = '\N'`, `bool_true_representation = 'true'` and
      `bool_false_representation = 'false'`. Every `DateTime64` in the DDL declares `'UTC'`, so it
      renders as `YYYY-MM-DD hh:mm:ss.fff` in UTC, whatever the session's timezone.
    This is not the JCS hash of an adapter-derived row (sessions-model §2), and a reader never
    compares the two. Known-answer vectors pin it (§8), each computed in SQL on ClickHouse
    (26.11 and 26.7) and checked against the same line's bytes hashed outside SQL:

    | Columns | Line (`<TAB>` is a tab) | sha256 |
    |---|---|---|
    | `'a<TAB>b'`, NULL, `42` | `a\tb<TAB>\N<TAB>42` | `0da0ee1ee00eda3720fea767ff7478783c2b5b6392af1870f62a817608c80245` |
    | `'çalışma 🙂 über'` | `çalışma 🙂 über` | `290bb61c8334712f195ad6c11304d06e0b851e6f447573f96002f79e7b0b0801` |
    | `concat('a', char(10), 'b\\c')` | `a\nb\\c` | `938d665b94c12451d969ab133fd9ce3a7c1ecaba6be5f1527dbab0ebc5090566` |
    | `toDateTime64('2026-01-02 09:00:06.840', 3, 'UTC')` | `2026-01-02 09:00:06.840` | `7b2639b861712df9e5d1ffd23df9cdc32481a220811f3cb259b230bbbc05a38e` |
    | `true`, `18446744073709551615` | `true<TAB>18446744073709551615` | `371f16eb1af812d5922ef5a5670f937d656016f6fa6dc08ce7d9ad300afc13ec` |
    | `''`, NULL, `toNullable('')` | `<TAB>\N<TAB>` | `e5789e615c9ecfd3f67b8a12d0cac21fefefd7ce84834b31b429cccd5e0e8f50` |
    | `toLowCardinality('claude-code')` | `claude-code` | `28e174396028f226b3bead259d19749205378d9204ce12fd9b1918ab6032a15d` |
  - **Full-row vectors** pin whole `session_parts` and `sessions` lines. Each is a converted row,
    written by a conversion and recomputed from the stored row in ClickHouse 26.7, with its line's
    bytes hashed outside SQL as well. The line is given as a JSON string: `\t` is a tab, and `\\N`
    is the two bytes `\N`.

    - `claude-code`, `legacy:ship:0:2` (reasoning): `7fe6b8358d9814945a131e83a9d1ecd2772e4b6625806dc8c68c79f1e59e9994`

      ```
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\tclaude-code\t/Users/x/.claude\tcc-1\t\tlegacy:ship:0:2\t0\t0\t\t000000000002\t\tassistant\t\t\\N\t\\N\tcomplete\tcurrent\t\\N\t2026-10-01 10:00:02.000\t\tcm\t\tlegacy-run:ship:0:2\t[]\treasoning\t[thinking] consider ls\t\t\t\t\t\\N\t\t\t\t\t\\N\t\\N\t\\N\t\\N\t\t\t\t\\N\t\\N\t\\N\t\t\t\t\t\\N\t\t\t\t\tlegacy\t0\tsessions-model/1"
      ```

    - `claude-code`, `legacy:ship:0:4` (tool_call): `2827bfe0e7e2618e82e600d370f8a5ca79bb96af2e4d79e285a6702a48e3db68`

      ```
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\tclaude-code\t/Users/x/.claude\tcc-1\t\tlegacy:ship:0:4\t0\t0\t\t000000000004\t\tassistant\t\t\\N\t\\N\tcomplete\tcurrent\t\\N\t2026-10-01 10:00:04.000\t\tcm\t\tlegacy-run:ship:0:4\t[]\ttool_call\t\t\tBash\t\t\t\\N\t\t\t\t\t\\N\t\\N\t\\N\t\\N\t\t\t\t\\N\t\\N\t\\N\t\t\t\t\t\\N\t\t\t\t\tlegacy\t0\tsessions-model/1"
      ```

    - `codex`, `legacy:ship:0:2` (tool_result): `a3e498e23d5b0749247eea1c250230fdb7ef8a3a5e5703496dd6a0fff8fd4132`

      ```
      "old-2\tcodex\t\tcx-1\t\tlegacy:ship:0:2\t0\t0\t\t000000000002\t\ttool\t\t\\N\t\\N\tcomplete\tcurrent\t\\N\t2026-10-01 10:00:02.000\t\tgx\t\t\t[]\ttool_result\t\t\t\t\t\t\\N\t\t[tool-result: shell] exit 0\t\t\t\\N\t27\t\\N\t\\N\t\t\t\t\\N\t\\N\t\\N\t\t\t\t\t\\N\t\t\t\t\tlegacy\t0\tsessions-model/1"
      ```

    - `sessions`, the `codex` session `cx-1` on host `old-2` (never paired, no 0.18 sessions row,
      three parts: a user text, a tool_result and a usage-only header row):
      `4862b0b6980ee794417ae64051e32c27df761b1001a57eb346ed0eb29b01bb20`

      ```
      "old-2\t\tcodex\t\tcx-1\t\t\t\t\t\tunknown\t\t\t\\N\t\\N\tactive\t\\N\t\t\tundetectable\tlegacy\t[]\t['6c1e6c205b2b0d99e3133950c143f3816093b215ee1d726849d9cb2ffeb2c98d','76261d522a0348358a2299e18a914aa8eb3b9ecb92d84cdb0fab58b6d6798eaf','4f546f41473e1fab07be4f96274329d6444fe6259acc2429d439504f7fb92d73']\t\\N\tlegacy\t0\tsessions-model/1"
      ```

      ClickHouse writes an `Array(FixedString(64))` in TabSeparated as `['…','…']`, and an empty
      `aliases` as `[]`.
  - **Its other shas.** A `legacy` `session_parts` row is one message with one part, so:
    - its `message_content_sha` equals its `content_sha`;
    - its `cmp_sha` is the same TabSeparated-line sha over `role`, `kind`, `text`, `tool_name`,
      `args`, `is_error` and `output`, in that (DDL) order: what the message says, without its
      bookkeeping;
    - its session's `fingerprint` is the ordered `cmp_sha`s of the session's `legacy` rows.

    Like its `content_sha`, these are never compared with an adapter-derived row's.
  - **Its session row.** The conversion writes one `sessions` row per session key of its converted
    `session_parts`, with these fixed fields:
    - `fingerprint`: the session's `legacy` rows' `cmp_sha`, ordered by `(order_key, message_id)`;
    - `reuse` `undetectable` and `incarnation` `''`: 0.18 kept no birth marker;
    - `ts_source` `legacy`, a sessions-model §8 registry value (v1.1): the time a consumer stored
      before any adapter, which the source cannot give back;
    - `title_set_by` `unknown`, `state` `active`;
    - `pinned` and `setup` null, `aliases` `[]`;
    - `host_label`, `engine`, `client`, `harness_version`, `last_cwd` and `kind` `''`;
    - from memhouse 0.18's sessions row: `title` (its name), `cwd` (its folder), `created_at`,
      `updated_at` and `mode`. The converting writer's newest row wins, else the newest row of any
      writer (rows ordered by whether they are the converting writer's, then `ingested_at`); with no
      0.18 row, these stay `''` or null;
    - `content_sha`: the TabSeparated-line sha above, over the `sessions` columns in DDL order
      without the columns it leaves out: 27 fields. A full-row vector pins it.
  - **A consumer's tool-call table** (outside this mapping, §3), where it keeps one, holds for a
    `legacy` call: `is_error`, `result_ts` and `output_len` null, and `content_sha` the message's
    `session_parts` sha.
  - **A converted session can appear twice.** When a converted session's harness store is read
    again through an adapter, its sessions come back under host/v0 with adapter-derived keys.
    Where the machine reported its pair, the converted rows already carry host/v0, so this
    cannot happen to them. Where the conversion kept the old host id, the two copies are two
    sessions, and this specification does not merge them: matching by `session_id` across hosts
    would break per-host session identity (sessions-model §1). That is the floor. A consumer may
    tombstone the matched `legacy` rows once the adapter-derived session exists, and a reader
    that wants one view prefers the adapter-derived rows.
  - **Its usage** stays as memhouse 0.18's database recorded it. Its flags are null unless that
    database's split is known. Claude Code usage that 0.18 repeated on every record of a
    response has granularity `per_record`, which a reader collapses per response (§4.4).
    0.18 dropped the native
    `message.id` and `requestId`, so the conversion mints each run's `response_id` under the
    `legacy-run:` prefix.
  - **Its flags** are known for the three harnesses whose 0.18 readers fixed the split:
    | Harness | `input_includes_cache` | `output_includes_reasoning` |
    |---|---|---|
    | claude-code | false | true |
    | codex | false (0.18 took the cached tokens out of `input`) | true |
    | gemini-cli | true | false |

    Every other harness's are null. 0.18 kept no reasoning count, so `reasoning` is null.
- **`memhouse-bridge` and `memhouse-log`:** see §4.1. Their rows follow the entity tables'
  shapes, but are not checked against a session adapter's output.

## 5. Writing (the engine's side of the seam)

For one data folder and one session, in each pass:
1. `read` each source, and archive the units and the read's manifest (`session_units`, §4.1),
   including a read that delivered nothing; only a read that changes nothing in the fold may go
   without one. Every manifest of the pass carries the session's next pass counter as `progress`.
2. `derive`. Upsert the `changed` records at `rev`.
3. Write a removed version of each adapter-owned key held for the session and absent from `live`
   (plan; a tombstoning consumer writes a tombstone instead). This happens after **every**
   derive, as sessions §4 requires.
4. Recompute the session's edges (`owner = 'engine'` rows): write an edge whose ends now both
   resolve, and a removed version of one whose last supporting statement left (§4.5).
5. Advance the cursor (`session_sources`).

A crash between any two steps is repaired by re-running the pass: every step is idempotent, and
`rev` never goes backwards. An append-only retraction is neither a removal nor a tombstone: it is
a current row with `state = 'retracted'` (sessions-model §2.6 (a)), because the adapter still
lists it in `live`.

## 6. Reading (extraction)

- **Current state:** entity rows with `is_deleted = 0` and `removed = 0`. In ClickHouse,
  read with `FINAL` or `argMax`.
- **Removed content:** rows with `removed = 1`, such as a reverted OpenCode turn. They are
  history: searchable, never counted.
- **History:** `session_units` replayed through the adapter's `derive` reproduces every state
  the session had since its archive began. A cheaper record history is the entity tables
  without `FINAL`, where every `rev` that has not yet merged away is still visible. It is
  best-effort; the archive is the guaranteed path.
- **A session, whole:** join the entity tables on the session key. No harness and no adapter is
  needed to read it.

## 7. Cursors and `rev`

These are **consumer policy, not part of the model**. They are shown as memhouse 0.20 implements
them.
- **Cursor (plan):** `session_sources`, one row per session and source (§4.6).
- **`rev` (plan):** `generation·2^40 + progress` for the session in its own harness store, with a floor
  of `last rev + 1` whenever the derive output changed by `content_sha`. Each session has exactly
  one harness store, so it has one writer, and no cross-host arbitration exists. This spec requires only
  that `rev` never goes backwards for a key.

## 8. Conformance

A database conforms to `sessions-sql` v1 when every item below holds. An item marked
**(ClickHouse database profile)** applies to that database profile only, and does not apply to a
PostgreSQL one.

**Envelopes.** The items that run an engine feed it **envelopes**. An envelope is one of:
- one read of one source as the `sessions` seam delivers it (sessions §2: `continuity`, `units`,
  `gone`, `position`, `held_back`), with its store, session and `source_key`, and the position it
  was read from (`from`; none for a first read);
- a consumer's `source_gone` decision for a source the harness store no longer has, with its
  `policy` (`kept` or `removed`, §4.1).

A **pass** is the envelopes one run of §5 ingests. The seam needs no change for this: an envelope
is what a consumer holds after a `read`, or after deciding on a vanished source.

- [ ] Every table and key of §3 exists in the database profile's DDL, under the deployment's
      physical table names (§3), with each table's identity columns as its key set
      (`session_sources` is informative and may be absent). An entity row is physically deleted only for a true duplicate, for a
      key an upgraded adapter no longer produces (§2, principle 3), or as a tombstoning consumer's
      tombstone.
- [ ] **Twice is once:** ingesting the same envelopes again adds no version of any entity row, no
      cursor row version, no unit row and no generation. It may add read manifests that deliver
      nothing new: in a generation that already exists, not `source_gone`, listing only units that
      generation already holds and only `gone` keys it already reported.
- [ ] **Crash-safe:** killing the pass at the minimum crash point, right after the archive write
      and before the cursor write, then re-running it, gives equal row counts and equal current
      state. An engine may declare further crash points (after its entity writes, its removed
      versions, its edges), and the item holds at each of them too.
- [ ] **Removed equals not live:** after each pass, a session's current adapter-owned keys (not
      deleted, not removed) are exactly that pass's `live` sets plus each key in `held` that was
      written before (sessions §2: a held key's last written version stands). Every key that left
      `live` and `held` has a removed version, or a tombstone for a tombstoning consumer
      (sessions §4 allows either), and none of them counts in totals.
- [ ] **Edges outlive statements correctly:** re-deriving the child alone keeps a merged edge
      (`owner = 'engine'`) while the parent's statement stands. Removing every supporting
      statement ends it.
- [ ] **Zero-part messages:** an assistant message with `content: []` keeps one row
      (`kind = 'none'`).
- [ ] **Registries take new values:** a row whose `harness`, `ts_source` or `enc` is a value
      neither database profile has seen is accepted by both, and kept as given.
- [ ] **Host form:** a row whose key `host` is not a sessions-model §1 form (32 lowercase
      hex, or `r-` or `s-` + 32 lowercase hex), such as a hostname, is rejected by both database profiles, unless
      its `adapter` is `legacy` (§4.8).
- [ ] **No time partition:** no entity table is partitioned by time, `ts` is Nullable, and a
      null `ts` is never filled with a consumer's first-seen time (§3).
- [ ] **Units only:** `session_units` holds no partial line, and each of its unit rows is a unit
      an adapter's `read` emitted, unless its `adapter` names an exemption of §4.8. Read manifests
      (§4.1) are normal rows, outside this check. Each entity record is one an adapter derived,
      unless its `adapter` names an exemption of §4.8. Engine-owned edges (§4.5, `owner =
      'engine'`) are normal rows, outside this check. Neither manifests nor engine edges are
      exemptions, so every replay check applies to them.
- [ ] **Legacy content_sha, line format (ClickHouse database profile):** each of §4.8's
      known-answer vectors (column values, their TabSeparated line, its sha) gives the same sha
      through the implementation's SQL.
- [ ] **Legacy content_sha, whole rows (ClickHouse database profile),** in two halves, for each
      of §4.8's full-row vectors:
      - *the database half:* the vector's fields, loaded by column name into the deployed table,
        format back in this specification's DDL order into that line and that `content_sha`;
      - *the conversion half:* the implementation's conversion of that row gives that line and
        that `content_sha`. The implementation proves it with its own known-answer tests, and
        its conformance report names them; v1 defines no conversion interface for a conformance
        run.
- [ ] **Two hosts, two sessions:** a data folder copied to a second host gives a second set of
      sessions, with the same `session_id`s and different session keys.
- [ ] **Absences replay:** a still-listed source reset to empty, a delta read's `gone` keys, and a
      vanished source handled under each vanish policy the engine implements (`"policy": "kept"`,
      `"policy": "removed"`), each replayed from `session_units` alone (no entity table, no
      cursor), give the same current state as the live pass, with the adapter-owned rows' removed
      versions. Replay rebuilds the current edges, not the removed versions of edges that ended: it
      folds each session alone, and the order of passes across sessions is not archived.
      - **Vanish policies are declared, not assumed.** Which policy handles a vanished source is
        the consumer's choice (§4.1), so an engine declares the policies it implements: `kept`,
        `removed`, or both. Each declared policy is checked, and an undeclared one does not apply;
        an engine that declares none is checked against both. A consumer that only ever keeps
        conforms if it keeps correctly: both policies are needed only by an engine that offers
        both.
      - **Replay follows the recorded policy.** A `source_gone` manifest records the policy the
        consumer applied (§4.1), and replay follows that record, never the engine's current
        setting. For an engine that offers both, a policy that changes between passes leaves every
        earlier event replaying as it was handled.
- [ ] **No-op manifests:** a pass that omits the manifest of a read that changes nothing in the
      fold (§4.1) replays to the same current state as a pass that writes it.
- [ ] **Re-derive from the archive:** a new `adapter_ver` replayed from `session_units` alone
      writes higher `rev`s, every row it writes carries that `adapter_ver` as the adapter states
      it, and it physically deletes only the keys the new version no longer produces.
- [ ] **Null is unknown:** usage counters, `exit_code`, `output_ref_bytes` and a statement's
      `child_stored` that the adapter emitted as null, and the `orig_sha256` of a unit without
      one, stay null in every database profile, and a part's own `source` or `state` survives
      beside its message's.
- [ ] **Redaction holds:** on the sentinel-secret fixtures, no value the adapter redacted on a
      declared redaction path (sessions-model §4) is in any table, a column a deployment adds
      included. No row holds, in this specification's columns, a planted value that the unit or
      record it was written from did not hold. A column a deployment adds (§3, derived columns)
      holds one only where a record of the row's session holds it, never another session's, and
      in the current state (§6) only where a current record holds it, never a removed or
      forgotten one. Free text an adapter keeps on purpose (sessions-model §4 rule 6) is the
      adapter's contract, not storage's.
- [ ] **Database profile parity:** ClickHouse and PostgreSQL, fed the same envelopes, give the same
      current state, compared as sets of `(key, content_sha)`, with `message_content_sha` added
      for `session_parts`. `legacy` rows are left out: they exist only in a ClickHouse database
      profile (§4.8).

## 9. Status

**v1.** It maps the records of [sessions-model][sessions-model] v1.3 as the [sessions][sessions]
v1.3 seam delivers them, and stays valid under any later v1.x. The fixtures
are those of the session-adapters package (`packages/session-adapters` in [agent-realm/harness-skeleton](https://github.com/agent-realm/harness-skeleton), package name `@agent-realm/session-adapters`), under `fixtures/<harness>/<case>/`: harness stores, captured and scrubbed or synthetic, each with
its reviewed golden. A conformance run reads them from a checkout of the package, because a
published package ships no `fixtures/`.

**The conformance kit** (`conformance/`) runs every §8 item against a ClickHouse or PostgreSQL
target taken from the environment, and its self-test holds each check to the faults it exists to
catch. Its reference engine implements §5 for both database profiles. On 2026-10-27, with this
DDL, on ClickHouse 26.8 and PostgreSQL 16, both disposable:
- the reference engine passes every §8 item on both database profiles, except the two legacy items
  on PostgreSQL, which do not apply there (§8);
- every control in the self-test makes its check fail.

**Production implementations.** memhouse's capture engine (0.20) is the first. It has run the
kit on its ClickHouse database profile (2026-10-27) and does not pass every item yet: Crash-safe,
Edges outlive statements correctly, Absences replay and Re-derive from the archive fail. Its pass
is recorded here when it has one. Until then no production implementation has passed the kit: the
read manifests (§4.1) are proved by the reference engine alone, and the pieces marked (plan) wait
for a production implementation. Per the empirical-first rule, these shapes are corrected to match
what it proves out.

**DDL check, 2026-10-22, on a disposable test VM:**
- `schema/clickhouse.sql` loads in clickhouse-local 26.11.1, and all 7 tables (6 normative,
  `session_sources` informative) report the sort
  keys of §3;
- `schema/postgres.sql` loads in PostgreSQL 16, and all 7 tables report the primary keys of §3.

Both were re-checked after the 2026-10-22 harness-store change, and again with the `host` form
checks and `sessions.host_label` (sessions-model §1), and again with the `session_links`
`other_incarnation` key and the `child_host` / `origin_host` checks. The v1 DDL (a string
`adapter_ver`, a nullable `child_stored` and `orig_sha256`) loads in ClickHouse 26.8 and
PostgreSQL 16 with the keys of §3, as the kit's Tables and keys item reads them from each catalogue.

[sessions-model]: https://github.com/agent-realm/sessions-model/blob/main/contracts/sessions-model.md
[sessions]: https://github.com/agent-realm/sessions-model/blob/main/contracts/sessions.md

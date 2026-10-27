-- sessions-sql v1: the normative ClickHouse database profile.
-- Spec: 01-SESSIONS-SQL-SPEC.md. Records: sessions-model v1 (contracts/sessions-model.md).
-- Status: loads in ClickHouse 26.8 with the sort keys of spec section 3 (section 9).
--
-- Conventions:
-- * The identity of every entity table is its whole ORDER BY (ReplacingMergeTree replaces on
--   the sort key). Never add a column that can change for a key.
-- * rev: monotonic per key, set by the consumer (spec section 7).
-- * A key absent from live is written again with removed = 1, keeping its adapter-set state
--   (spec principle 3), or tombstoned by a tombstoning consumer (sessions §4 allows
--   either). Otherwise is_deleted = 1 is only for true duplicates and keys an upgraded adapter
--   no longer produces.
--   Current state: is_deleted = 0 AND removed = 0.
-- * incarnation is '' wherever reuse = impossible.
-- * writer: server-stamped. Drop the column where the deployment does
--   not use per-principal writes.

-- 4.1 The archive of raw units, keyed by session and source.
CREATE TABLE session_units
(
    host          LowCardinality(String),
    CONSTRAINT host_form CHECK match(host, '^([rs]-)?[0-9a-f]{32}$'),  -- sessions-model §1, host/v0
    harness       LowCardinality(String),
    harness_path  LowCardinality(String),           -- the data folder's real path
    session_id    String,
    incarnation   String,
    source_key    String,
    generation    UInt32,
    unit_key      String,
    chunk         UInt16 DEFAULT 0,                 -- a unit split into chunks (large units)
    sha256        FixedString(64),                  -- hex, of the bytes as emitted (after redaction)
    enc           LowCardinality(String),           -- a registry (spec §2, principle 7): utf8 | b64 | row-json | rows-json | pb-json | manifest (unit_key '', §4.1) | …
    orig_sha256   Nullable(FixedString(64)),        -- sha256 of the original bytes (spec §4.1); null when the unit has none
    redacted      Bool DEFAULT false,
    continuity    LowCardinality(String),           -- sessions §3: appended | delta | reset | snapshot | unchanged (a source_gone manifest: reset)
    raw           String CODEC(ZSTD(3)),
    adapter       LowCardinality(String),
    adapter_ver   LowCardinality(String),           -- the version string the adapter states (0.2.0), as given
    captured_at   DateTime64(3, 'UTC') DEFAULT now64(3),
    writer        String MATERIALIZED currentUser()
)
ENGINE = ReplacingMergeTree
ORDER BY (host, harness, harness_path, session_id, incarnation, source_key, generation, unit_key, chunk, sha256);

-- 4.6 (informative: one cursor layout, per session and source; not required for conformance).
CREATE TABLE session_sources
(
    host               LowCardinality(String),
    CONSTRAINT host_form CHECK match(host, '^([rs]-)?[0-9a-f]{32}$'),  -- sessions-model §1, host/v0
    harness            LowCardinality(String),
    harness_path       LowCardinality(String),      -- the data folder's real path
    session_id         String,
    incarnation        String,
    source_key         String,
    mode               LowCardinality(String),      -- stream | delta | snapshot
    position           String DEFAULT '',           -- opaque, host-local
    generation         UInt32,
    progress           UInt64,
    state              String DEFAULT '' CODEC(ZSTD(1)),  -- the derive state (opaque)
    state_ver          UInt32,
    adapter            LowCardinality(String),
    adapter_ver        LowCardinality(String),
    committed_at       DateTime64(3, 'UTC') DEFAULT now64(3),
    ver                UInt64 MATERIALIZED (toUInt64(generation) * 1099511627776) + progress,
    writer             String MATERIALIZED currentUser()
)
ENGINE = ReplacingMergeTree(ver)
ORDER BY (host, harness, harness_path, session_id, incarnation, source_key);

-- 4.2 Sessions.
CREATE TABLE sessions
(
    host             LowCardinality(String),
    CONSTRAINT host_form CHECK match(host, '^([rs]-)?[0-9a-f]{32}$') OR adapter = 'legacy',  -- sessions-model §1, host/v0; legacy rows exempt (spec §4.8)
    host_label       String DEFAULT '',                 -- display only (e.g. my-laptop), never in a key
    harness          LowCardinality(String),
    harness_path     LowCardinality(String),
    session_id       String,
    incarnation      String,
    engine           LowCardinality(String) DEFAULT '',
    client           LowCardinality(String) DEFAULT '',
    harness_version  LowCardinality(String) DEFAULT '',
    title            String DEFAULT '',
    title_set_by     LowCardinality(String) DEFAULT 'unknown',
    cwd              String DEFAULT '',
    last_cwd         String DEFAULT '',
    created_at       Nullable(DateTime64(3, 'UTC')),
    updated_at       Nullable(DateTime64(3, 'UTC')),
    state            LowCardinality(String),           -- active | archived | deleted (a session gone from list: deleted)
    pinned           Nullable(Bool),
    mode             LowCardinality(String) DEFAULT '',
    kind             LowCardinality(String) DEFAULT '',
    reuse            LowCardinality(String),           -- impossible | detected | undetectable
    ts_source        LowCardinality(String),           -- a registry (spec §2, principle 7): event | write | reset_on_save | seconds | none | first_seen | …
    aliases          Array(Tuple(id String, kind LowCardinality(String))),
    fingerprint      Array(FixedString(64)),           -- ordered cmp_sha of the current line
    setup            Nullable(String),                 -- canonical JSON of sessions-model §2.1 setup; null unless recorded
    content_sha      FixedString(64),
    adapter          LowCardinality(String),
    adapter_ver      LowCardinality(String),
    model_version    LowCardinality(String),
    rev              UInt64,
    is_deleted       UInt8 DEFAULT 0,
    removed          UInt8 DEFAULT 0,               -- consumer: kept as a removed version
    ingested_at      DateTime64(3, 'UTC') DEFAULT now64(3),
    writer           String MATERIALIZED currentUser()
)
ENGINE = ReplacingMergeTree(rev, is_deleted)
ORDER BY (host, harness, harness_path, session_id, incarnation);

-- 4.3 Parts, one row per part, each carrying its message's columns, so a message reads without a join.
-- A message with no parts is one row with part_id = '' and kind = 'none'.
CREATE TABLE session_parts
(
    host                 LowCardinality(String),
    CONSTRAINT host_form CHECK match(host, '^([rs]-)?[0-9a-f]{32}$') OR adapter = 'legacy',  -- sessions-model §1, host/v0; legacy rows exempt (spec §4.8)
    harness              LowCardinality(String),
    harness_path         LowCardinality(String),
    session_id           String,
    incarnation          String,
    message_id           String,
    part_id              String,
    part_index           UInt32,                  -- native order within the message
    -- message columns
    parent_id            String DEFAULT '',
    order_key            String,                  -- sessions-model 2.2 `order`
    agent_id             String DEFAULT '',
    role                 LowCardinality(String),  -- user | assistant | system | tool
    source               LowCardinality(String) DEFAULT '',  -- '' = null (sessions-model 2.2: a tool result, an unrecorded sender)
    to_user              Nullable(Bool),
    to_model             Nullable(Bool),
    status               LowCardinality(String),
    state                LowCardinality(String),  -- current | reverted | retracted (set by the adapter)
    on_active_branch     Nullable(Bool),
    ts                   Nullable(DateTime64(3, 'UTC')),
    requested_model      LowCardinality(String) DEFAULT '',
    served_model         LowCardinality(String) DEFAULT '',
    effort               LowCardinality(String) DEFAULT '',
    response_id          String DEFAULT '',
    message_aliases      Array(Tuple(id String, kind LowCardinality(String))),
    cmp_sha              FixedString(64),
    message_content_sha  FixedString(64),
    -- part columns
    kind                 LowCardinality(String),  -- text | reasoning | tool_call | tool_result | attachment | summary | error | notice | none
    text                 String DEFAULT '' CODEC(ZSTD(3)),
    call_id              String DEFAULT '',
    tool_name            LowCardinality(String) DEFAULT '',
    args                 String DEFAULT '',       -- JSON
    server               LowCardinality(String) DEFAULT '',
    is_error             Nullable(Bool),
    result_status        LowCardinality(String) DEFAULT '',  -- completed | cancelled | denied
    output               String DEFAULT '' CODEC(ZSTD(3)),
    output_ref           String DEFAULT '',
    output_ref_sha256    String DEFAULT '',       -- '' when the content is no longer stored
    output_ref_bytes     Nullable(UInt64),
    output_len           Nullable(UInt64),
    truncated            Nullable(Bool),
    exit_code            Nullable(Int32),         -- a shell tool's, where the store keeps it apart
    media_type           LowCardinality(String) DEFAULT '',
    inline_b64           String DEFAULT '' CODEC(ZSTD(3)),
    ref                  String DEFAULT '',
    bytes_len            Nullable(UInt64),
    opaque               Nullable(Bool),
    signature_len        Nullable(UInt32),
    replaces_form        LowCardinality(String) DEFAULT '',  -- first_kept_id | through_id | through_index | count | flags | archive_ref | unknown
    replaces_value       String DEFAULT '',
    error_kind           LowCardinality(String) DEFAULT '',
    error_message        String DEFAULT '',
    http_status          Nullable(UInt16),
    level                LowCardinality(String) DEFAULT '',
    native_type          LowCardinality(String) DEFAULT '',
    part_source          LowCardinality(String) DEFAULT '',  -- the part's own source, '' = its message's
    part_state           LowCardinality(String) DEFAULT '',  -- the part's own state, '' = its message's
    content_sha          FixedString(64),
    adapter              LowCardinality(String),
    adapter_ver          LowCardinality(String),
    model_version        LowCardinality(String),
    rev                  UInt64,
    is_deleted           UInt8 DEFAULT 0,
    removed              UInt8 DEFAULT 0,           -- consumer: kept as a removed version
    ingested_at          DateTime64(3, 'UTC') DEFAULT now64(3),
    writer               String MATERIALIZED currentUser()
)
ENGINE = ReplacingMergeTree(rev, is_deleted)
ORDER BY (host, harness, harness_path, session_id, incarnation, message_id, part_id);

-- 4.4 Usage. Null counters mean unknown; never write 0 for unknown.
CREATE TABLE session_usage
(
    host           LowCardinality(String),
    CONSTRAINT host_form CHECK match(host, '^([rs]-)?[0-9a-f]{32}$') OR adapter = 'legacy',  -- sessions-model §1, host/v0; legacy rows exempt (spec §4.8)
    harness        LowCardinality(String),
    harness_path   LowCardinality(String),
    session_id     String,
    incarnation    String,
    usage_id       String,
    anchor_kind    LowCardinality(String),           -- response | message | session | compaction
    anchor_id      String DEFAULT '',
    input          Nullable(UInt64),
    output         Nullable(UInt64),
    cache_read     Nullable(UInt64),
    cache_write    Nullable(UInt64),
    reasoning      Nullable(UInt64),
    tool_prompt    Nullable(UInt64),                 -- input counted apart from input and output (Gemini)
    cost           Nullable(Decimal(18, 9)),
    input_includes_cache      Nullable(Bool),   -- null = not established (sessions-model §2.4)
    output_includes_reasoning Nullable(Bool),
    granularity    LowCardinality(String),           -- per_response | per_message | per_turn | per_session | per_record (counted once per response_id: its last record)
    model          LowCardinality(String) DEFAULT '',
    content_sha    FixedString(64),
    adapter        LowCardinality(String),
    adapter_ver    LowCardinality(String),
    model_version  LowCardinality(String),
    rev            UInt64,
    is_deleted     UInt8 DEFAULT 0,
    removed        UInt8 DEFAULT 0,
    ingested_at    DateTime64(3, 'UTC') DEFAULT now64(3),
    writer         String MATERIALIZED currentUser()
)
ENGINE = ReplacingMergeTree(rev, is_deleted)
ORDER BY (host, harness, harness_path, session_id, incarnation, usage_id);

-- 4.5 Links: adapter statements (owner = 'adapter', reconciled against live) and engine edges
-- (owner = 'engine', keyed on the child; never reconciled against an adapter's live).
CREATE TABLE session_links
(
    host                LowCardinality(String),
    CONSTRAINT host_form CHECK match(host, '^([rs]-)?[0-9a-f]{32}$') OR adapter = 'legacy',  -- sessions-model §1, host/v0; legacy rows exempt (spec §4.8)
    harness             LowCardinality(String),      -- the stating session (the child, for engine edges)
    harness_path        LowCardinality(String),
    session_id          String,
    incarnation         String,
    owner               LowCardinality(String),      -- adapter | engine
    kind                LowCardinality(String),      -- fork | subagent | rewind_copy | clear | continuation
    other_host          LowCardinality(String) DEFAULT '',  -- '': the stating session's own harness store
    CONSTRAINT other_host_form CHECK other_host = '' OR match(other_host, '^([rs]-)?[0-9a-f]{32}$') OR adapter = 'legacy',
    other_harness_path  LowCardinality(String) DEFAULT '',
    other_harness       LowCardinality(String),
    other_session_id    String,
    other_incarnation   String DEFAULT '',           -- '': unknown, or the empty incarnation
    at                  String DEFAULT '',
    stated_on           LowCardinality(String),      -- child | origin | both (both: engine only)
    child_host          LowCardinality(String) DEFAULT '',  -- '': the stating session's own harness store
    CONSTRAINT child_host_form CHECK child_host = '' OR match(child_host, '^([rs]-)?[0-9a-f]{32}$') OR adapter = 'legacy',
    child_harness_path  LowCardinality(String) DEFAULT '',
    child_harness       LowCardinality(String),
    child_session_id    String,
    child_incarnation   Nullable(String),            -- null: unknown to the stating side
    origin_host         LowCardinality(String) DEFAULT '',
    CONSTRAINT origin_host_form CHECK origin_host = '' OR match(origin_host, '^([rs]-)?[0-9a-f]{32}$') OR adapter = 'legacy',
    origin_harness_path LowCardinality(String) DEFAULT '',
    origin_harness      LowCardinality(String),
    origin_session_id   String,
    origin_incarnation  Nullable(String),
    through_message_id  String DEFAULT '',
    ids_preserved       Nullable(Bool),
    marked              Nullable(Bool),
    usage_copied        Nullable(Bool),
    child_stored        Nullable(Bool),             -- null: unknown (a statement that does not say)
    evidence            LowCardinality(String) DEFAULT 'explicit',  -- explicit | inferred (inferred: engine only)
    verified            Nullable(Bool),             -- engine only
    statements          Array(Tuple(host String, harness String, harness_path String, session_id String, incarnation String)),  -- engine only
    content_sha         FixedString(64),
    adapter             LowCardinality(String),
    adapter_ver         LowCardinality(String),
    model_version       LowCardinality(String),
    rev                 UInt64,
    is_deleted          UInt8 DEFAULT 0,
    removed             UInt8 DEFAULT 0,
    ingested_at         DateTime64(3, 'UTC') DEFAULT now64(3),
    writer              String MATERIALIZED currentUser()
)
ENGINE = ReplacingMergeTree(rev, is_deleted)
ORDER BY (host, harness, harness_path, session_id, incarnation, owner, kind, other_host, other_harness_path, other_harness, other_session_id, other_incarnation, at);

-- 4.7 Lifecycle.
CREATE TABLE session_lifecycle
(
    host            LowCardinality(String),
    CONSTRAINT host_form CHECK match(host, '^([rs]-)?[0-9a-f]{32}$') OR adapter = 'legacy',  -- sessions-model §1, host/v0; legacy rows exempt (spec §4.8)
    harness         LowCardinality(String),
    harness_path    LowCardinality(String),
    session_id      String,
    incarnation     String,
    lifecycle_id    String,
    op              LowCardinality(String),  -- rewind | edit | compaction | delete | archive | unarchive | rename | pin | unpin | fork | clear
    target_kind     LowCardinality(String),  -- message | range | session
    target_id       String DEFAULT '',
    target_from     String DEFAULT '',
    target_through  String DEFAULT '',
    at              String DEFAULT '',
    ts              Nullable(DateTime64(3, 'UTC')),
    evidence        LowCardinality(String) DEFAULT 'explicit',
    content_sha     FixedString(64),
    adapter         LowCardinality(String),
    adapter_ver     LowCardinality(String),
    model_version   LowCardinality(String),
    rev             UInt64,
    is_deleted      UInt8 DEFAULT 0,
    removed         UInt8 DEFAULT 0,
    ingested_at     DateTime64(3, 'UTC') DEFAULT now64(3),
    writer          String MATERIALIZED currentUser()
)
ENGINE = ReplacingMergeTree(rev, is_deleted)
ORDER BY (host, harness, harness_path, session_id, incarnation, lifecycle_id);


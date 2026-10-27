-- sessions-sql v1: the PostgreSQL database profile, over the same logical keys as clickhouse.sql.
-- Spec: 01-SESSIONS-SQL-SPEC.md, section 3.
-- Status: loads in PostgreSQL 16 with the primary keys of spec section 3 (section 9).
--
-- Write rule for every entity table:
--   INSERT INTO t (...) VALUES (...)
--   ON CONFLICT (<primary key>) DO UPDATE SET <all non-key columns> = EXCLUDED.<column>
--   WHERE EXCLUDED.rev > t.rev;
-- A key absent from live: the same upsert with removed = 1, keeping state, or a
-- tombstoning consumer's tombstone (sessions §4 allows either). Otherwise DELETE only true
-- duplicates and keys an upgraded adapter no longer produces. Current state: WHERE NOT is_deleted AND removed = 0.
-- session_units: INSERT ... ON CONFLICT DO NOTHING.
-- The writer column is optional; where used it is set by a trigger or a column DEFAULT current_user.

CREATE TABLE session_units (
    host          text        NOT NULL CHECK (host ~ '^([rs]-)?[0-9a-f]{32}$'),
    harness       text        NOT NULL,
    harness_path  text        NOT NULL,              -- the data folder's real path
    session_id    text        NOT NULL,
    incarnation   text        NOT NULL DEFAULT '',
    source_key    text        NOT NULL,
    generation    integer     NOT NULL,
    unit_key      text        NOT NULL,
    chunk         integer     NOT NULL DEFAULT 0,
    sha256        char(64)    NOT NULL,
    enc           text        NOT NULL,              -- a registry (spec §2, principle 7): utf8 | b64 | row-json | rows-json | pb-json | manifest (unit_key '', §4.1) | …
    orig_sha256   char(64),                          -- sha256 of the original bytes (spec §4.1); null when the unit has none
    redacted      boolean     NOT NULL DEFAULT false,
    continuity    text        NOT NULL,              -- sessions §3: appended | delta | reset | snapshot | unchanged (a source_gone manifest: reset)
    raw           text        NOT NULL,
    adapter       text        NOT NULL,
    adapter_ver   text        NOT NULL,              -- the version string the adapter states (0.2.0), as given
    captured_at   timestamptz NOT NULL DEFAULT now(),
    writer        text        NOT NULL DEFAULT current_user,
    PRIMARY KEY (host, harness, harness_path, session_id, incarnation, source_key, generation, unit_key, chunk, sha256)
);

-- 4.6 (informative: one cursor layout; not required for conformance).
-- Upsert WHERE (EXCLUDED.generation, EXCLUDED.progress) > (t.generation, t.progress).
CREATE TABLE session_sources (
    host               text    NOT NULL CHECK (host ~ '^([rs]-)?[0-9a-f]{32}$'),
    harness            text    NOT NULL,
    harness_path       text    NOT NULL,
    session_id         text    NOT NULL,
    incarnation        text    NOT NULL DEFAULT '',
    source_key         text    NOT NULL,
    mode               text    NOT NULL,
    position           text    NOT NULL DEFAULT '',
    generation         integer NOT NULL,
    progress           numeric(20,0) NOT NULL,
    state              text    NOT NULL DEFAULT '',
    state_ver          integer NOT NULL,
    adapter            text    NOT NULL,
    adapter_ver        text    NOT NULL,
    committed_at       timestamptz NOT NULL DEFAULT now(),
    writer             text    NOT NULL DEFAULT current_user,
    PRIMARY KEY (host, harness, harness_path, session_id, incarnation, source_key)
);

CREATE TABLE sessions (
    host             text     NOT NULL CHECK (host ~ '^([rs]-)?[0-9a-f]{32}$' OR adapter = 'legacy'),
    host_label       text     NOT NULL DEFAULT '',  -- display only (e.g. my-laptop), never in a key
    harness          text     NOT NULL,
    harness_path     text     NOT NULL,
    session_id       text     NOT NULL,
    incarnation      text     NOT NULL DEFAULT '',
    engine           text     NOT NULL DEFAULT '',
    client           text     NOT NULL DEFAULT '',
    harness_version  text     NOT NULL DEFAULT '',
    title            text     NOT NULL DEFAULT '',
    title_set_by     text     NOT NULL DEFAULT 'unknown',
    cwd              text     NOT NULL DEFAULT '',
    last_cwd         text     NOT NULL DEFAULT '',
    created_at       timestamptz,
    updated_at       timestamptz,
    state            text     NOT NULL,
    pinned           boolean,
    mode             text     NOT NULL DEFAULT '',
    kind             text     NOT NULL DEFAULT '',
    reuse            text     NOT NULL,
    ts_source        text     NOT NULL,              -- a registry (spec §2, principle 7)
    aliases          jsonb    NOT NULL DEFAULT '[]',   -- [{id, kind}]
    fingerprint      text[]   NOT NULL DEFAULT '{}',   -- ordered cmp_sha
    setup            jsonb,                             -- sessions-model §2.1 setup; null unless recorded
    content_sha      char(64) NOT NULL,
    adapter          text     NOT NULL,
    adapter_ver      text     NOT NULL,
    model_version    text     NOT NULL,
    rev              numeric(20,0) NOT NULL,           -- UInt64 range
    is_deleted       boolean  NOT NULL DEFAULT false,
    removed          smallint NOT NULL DEFAULT 0,
    ingested_at      timestamptz NOT NULL DEFAULT now(),
    writer           text     NOT NULL DEFAULT current_user,
    PRIMARY KEY (host, harness, harness_path, session_id, incarnation)
);

-- One row per part, each carrying its message's columns, so a message reads without a join.
-- A message with no parts: one row, part_id = '' and kind = 'none'.
CREATE TABLE session_parts (
    host                 text NOT NULL CHECK (host ~ '^([rs]-)?[0-9a-f]{32}$' OR adapter = 'legacy'),
    harness              text NOT NULL,
    harness_path         text NOT NULL,
    session_id           text NOT NULL,
    incarnation          text NOT NULL DEFAULT '',
    message_id           text NOT NULL,
    part_id              text NOT NULL,
    part_index           integer NOT NULL,
    parent_id            text NOT NULL DEFAULT '',
    order_key            text NOT NULL,
    agent_id             text NOT NULL DEFAULT '',
    role                 text NOT NULL,
    source               text NOT NULL DEFAULT '',  -- '' = null (sessions-model 2.2)
    to_user              boolean,
    to_model             boolean,
    status               text NOT NULL,
    state                text NOT NULL,
    on_active_branch     boolean,
    ts                   timestamptz,
    requested_model      text NOT NULL DEFAULT '',
    served_model         text NOT NULL DEFAULT '',
    effort               text NOT NULL DEFAULT '',
    response_id          text NOT NULL DEFAULT '',
    message_aliases      jsonb NOT NULL DEFAULT '[]',
    cmp_sha              char(64) NOT NULL,
    message_content_sha  char(64) NOT NULL,
    kind                 text NOT NULL,
    text                 text NOT NULL DEFAULT '',
    call_id              text NOT NULL DEFAULT '',
    tool_name            text NOT NULL DEFAULT '',
    args                 jsonb,
    server               text NOT NULL DEFAULT '',
    is_error             boolean,
    result_status        text NOT NULL DEFAULT '',
    output               text NOT NULL DEFAULT '',
    output_ref           text NOT NULL DEFAULT '',
    output_ref_sha256    text NOT NULL DEFAULT '',  -- '' when the content is no longer stored
    output_ref_bytes     bigint,
    output_len           bigint,
    truncated            boolean,
    exit_code            integer,                   -- a shell tool's, where the store keeps it apart
    media_type           text NOT NULL DEFAULT '',
    inline_b64           text NOT NULL DEFAULT '',
    ref                  text NOT NULL DEFAULT '',
    bytes_len            bigint,
    opaque               boolean,
    signature_len        integer,
    replaces_form        text NOT NULL DEFAULT '',
    replaces_value       text NOT NULL DEFAULT '',
    error_kind           text NOT NULL DEFAULT '',
    error_message        text NOT NULL DEFAULT '',
    http_status          integer,
    level                text NOT NULL DEFAULT '',
    native_type          text NOT NULL DEFAULT '',
    part_source          text NOT NULL DEFAULT '',  -- the part's own source, '' = its message's
    part_state           text NOT NULL DEFAULT '',  -- the part's own state, '' = its message's
    content_sha          char(64) NOT NULL,
    adapter              text NOT NULL,
    adapter_ver          text NOT NULL,
    model_version        text NOT NULL,
    rev                  numeric(20,0) NOT NULL,
    is_deleted           boolean NOT NULL DEFAULT false,
    removed              smallint NOT NULL DEFAULT 0,
    ingested_at          timestamptz NOT NULL DEFAULT now(),
    writer               text NOT NULL DEFAULT current_user,
    PRIMARY KEY (host, harness, harness_path, session_id, incarnation, message_id, part_id)
);

CREATE TABLE session_usage (
    host           text NOT NULL CHECK (host ~ '^([rs]-)?[0-9a-f]{32}$' OR adapter = 'legacy'),
    harness        text NOT NULL,
    harness_path   text NOT NULL,
    session_id     text NOT NULL,
    incarnation    text NOT NULL DEFAULT '',
    usage_id       text NOT NULL,
    anchor_kind    text NOT NULL,
    anchor_id      text NOT NULL DEFAULT '',
    input          bigint,             -- null = unknown; never 0 for unknown
    output         bigint,
    cache_read     bigint,
    cache_write    bigint,
    reasoning      bigint,
    tool_prompt    bigint,            -- input counted apart from input and output (Gemini)
    cost           numeric(18,9),
    input_includes_cache      boolean,   -- null = not established (sessions-model §2.4)
    output_includes_reasoning boolean,
    granularity    text NOT NULL,     -- per_response | per_message | per_turn | per_session | per_record
    model          text NOT NULL DEFAULT '',
    content_sha    char(64) NOT NULL,
    adapter        text NOT NULL,
    adapter_ver    text NOT NULL,
    model_version  text NOT NULL,
    rev            numeric(20,0) NOT NULL,
    is_deleted     boolean NOT NULL DEFAULT false,
    removed        smallint NOT NULL DEFAULT 0,
    ingested_at    timestamptz NOT NULL DEFAULT now(),
    writer         text NOT NULL DEFAULT current_user,
    PRIMARY KEY (host, harness, harness_path, session_id, incarnation, usage_id)
);

-- owner = 'adapter': statements, reconciled against live. owner = 'engine': edges, keyed on the child.
CREATE TABLE session_links (
    host                text NOT NULL CHECK (host ~ '^([rs]-)?[0-9a-f]{32}$' OR adapter = 'legacy'),
    harness             text NOT NULL,
    harness_path        text NOT NULL,
    session_id          text NOT NULL,
    incarnation         text NOT NULL DEFAULT '',
    owner               text NOT NULL,
    kind                text NOT NULL,
    other_host          text NOT NULL DEFAULT '' CHECK (other_host = '' OR other_host ~ '^([rs]-)?[0-9a-f]{32}$' OR adapter = 'legacy'),   -- '': the stating session's own harness store
    other_harness_path  text NOT NULL DEFAULT '',
    other_harness       text NOT NULL,
    other_session_id    text NOT NULL,
    other_incarnation   text NOT NULL DEFAULT '',    -- '': unknown, or the empty incarnation
    at                  text NOT NULL DEFAULT '',
    stated_on           text NOT NULL,
    child_host          text NOT NULL DEFAULT '' CHECK (child_host = '' OR child_host ~ '^([rs]-)?[0-9a-f]{32}$' OR adapter = 'legacy'),
    child_harness_path  text NOT NULL DEFAULT '',
    child_harness       text NOT NULL,
    child_session_id    text NOT NULL,
    child_incarnation   text,
    origin_host         text NOT NULL DEFAULT '' CHECK (origin_host = '' OR origin_host ~ '^([rs]-)?[0-9a-f]{32}$' OR adapter = 'legacy'),
    origin_harness_path text NOT NULL DEFAULT '',
    origin_harness      text NOT NULL,
    origin_session_id   text NOT NULL,
    origin_incarnation  text,
    through_message_id  text NOT NULL DEFAULT '',
    ids_preserved       boolean,
    marked              boolean,
    usage_copied        boolean,
    child_stored        boolean,                     -- null: unknown (a statement that does not say)
    evidence            text NOT NULL DEFAULT 'explicit',
    verified            boolean,
    statements          jsonb NOT NULL DEFAULT '[]',
    content_sha         char(64) NOT NULL,
    adapter             text NOT NULL,
    adapter_ver         text NOT NULL,
    model_version       text NOT NULL,
    rev                 numeric(20,0) NOT NULL,
    is_deleted          boolean NOT NULL DEFAULT false,
    removed             smallint NOT NULL DEFAULT 0,
    ingested_at         timestamptz NOT NULL DEFAULT now(),
    writer              text NOT NULL DEFAULT current_user,
    PRIMARY KEY (host, harness, harness_path, session_id, incarnation, owner, kind, other_host, other_harness_path, other_harness, other_session_id, other_incarnation, at)
);

CREATE TABLE session_lifecycle (
    host            text NOT NULL CHECK (host ~ '^([rs]-)?[0-9a-f]{32}$' OR adapter = 'legacy'),
    harness         text NOT NULL,
    harness_path    text NOT NULL,
    session_id      text NOT NULL,
    incarnation     text NOT NULL DEFAULT '',
    lifecycle_id    text NOT NULL,
    op              text NOT NULL,
    target_kind     text NOT NULL,
    target_id       text NOT NULL DEFAULT '',
    target_from     text NOT NULL DEFAULT '',
    target_through  text NOT NULL DEFAULT '',
    at              text NOT NULL DEFAULT '',
    ts              timestamptz,
    evidence        text NOT NULL DEFAULT 'explicit',
    content_sha     char(64) NOT NULL,
    adapter         text NOT NULL,
    adapter_ver     text NOT NULL,
    model_version   text NOT NULL,
    rev             numeric(20,0) NOT NULL,
    is_deleted      boolean NOT NULL DEFAULT false,
    removed         smallint NOT NULL DEFAULT 0,
    ingested_at     timestamptz NOT NULL DEFAULT now(),
    writer          text NOT NULL DEFAULT current_user,
    PRIMARY KEY (host, harness, harness_path, session_id, incarnation, lifecycle_id)
);


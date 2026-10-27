// The positive controls. Each fault breaks one thing the reference does right, in its engine or in
// the DDL it loads; the kit's self-test runs every check against each fault the check names, and
// the check must fail. A DDL fault is a text change to schema/<profile>.sql before it loads, and
// throws when its pattern is not found, so a DDL edit never voids a control silently.

const once = (text, re, to, what) => {
  if (!re.test(text)) throw new Error(`DDL fault ${what}: pattern not found`);
  return text.replace(re, to);
};

export const DDL_FAULTS = {
  // A key column dropped from session_units' identity.
  'drop-key-column': (t, p) => (p === 'clickhouse'
    ? once(t, /unit_key, chunk, sha256\);/, 'unit_key, sha256);', 'drop-key-column')
    : once(t, /unit_key, chunk, sha256\)\n/, 'unit_key, sha256)\n', 'drop-key-column')),

  // session_parts' sort key prefixed with the day of ingestion (ClickHouse): a column that
  // changes between versions of a key, so they never collapse. §3 allows only columns that never
  // change for a key, such as toDate(ts).
  'sort-prefix-ingested-at': (t) => once(t, /(ENGINE = ReplacingMergeTree\(rev, is_deleted\)\n)ORDER BY \((host, harness, harness_path, session_id, incarnation, message_id, part_id)\);/, '$1ORDER BY (toDate(ingested_at), $2);', 'sort-prefix-ingested-at'),

  // Registries as closed lists: harness, ts_source and enc constrained to the values seen so far.
  'registry-enum': (t, p) => {
    const lists = {
      harness: "'claude-code','codex','copilot-cli','vscode','cursor','cursor-agent','agy','antigravity','opencode','goose','gemini-cli','commandcode','droid','devin','zed','kiro','jetbrains-copilot','pi','reference-harness'",
      ts_source: "'event','write','reset_on_save','seconds','none','first_seen','legacy'",
      enc: "'utf8','b64','row-json','rows-json','pb-json','manifest'",
    };
    if (p === 'clickhouse') {
      t = once(t, /(\n\s*ts_source\s+LowCardinality\(String\),)/, `$1\n    CONSTRAINT ts_source_known CHECK ts_source IN (${lists.ts_source}),\n    CONSTRAINT harness_known CHECK harness IN (${lists.harness}),`, 'registry-enum');
      return once(t, /(\n\s*enc\s+LowCardinality\(String\),)/, `$1\n    CONSTRAINT enc_known CHECK enc IN (${lists.enc}),`, 'registry-enum');
    }
    t = once(t, /(\n\s*ts_source\s+text\s+NOT NULL),/, `$1 CHECK (ts_source IN (${lists.ts_source}) AND harness IN (${lists.harness})),`, 'registry-enum');
    return once(t, /(\n\s*enc\s+text\s+NOT NULL),/, `$1 CHECK (enc IN (${lists.enc})),`, 'registry-enum');
  },

  // No host form check at all.
  'no-host-check': (t, p) => (p === 'clickhouse'
    ? once(t, /\n\s*CONSTRAINT \w*host_form CHECK [^\n]*/g, '', 'no-host-check')
    : once(t, / CHECK \((?:host|other_host|child_host|origin_host) [^\n]*?\)(?=,)/g, '', 'no-host-check')),

  // session_parts partitioned by month of ingestion (ClickHouse).
  'partition-by-time': (t) => once(t, /(ENGINE = ReplacingMergeTree\(rev, is_deleted\)\n)(ORDER BY \(host, harness, harness_path, session_id, incarnation, message_id, part_id\);)/, '$1PARTITION BY toYYYYMM(ingested_at)\n$2', 'partition-by-time'),

  // The host form checks without their anchors: a value holding 32 hex digits anywhere passes.
  'host-check-unanchored': (t, p) => (p === 'clickhouse'
    ? once(t, /'\^\(\[rs\]-\)\?\[0-9a-f\]\{32\}\$'/g, "'([rs]-)?[0-9a-f]{32}'", 'host-check-unanchored')
    : once(t, /'\^\(\[rs\]-\)\?\[0-9a-f\]\{32\}\$'/g, "'([rs]-)?[0-9a-f]{32}'", 'host-check-unanchored')),

  // A message's ts that cannot be null.
  'ts-not-null': (t, p) => (p === 'clickhouse'
    ? once(t, /\n(\s*)ts(\s+)Nullable\(DateTime64\(3, 'UTC'\)\),/g, "\n$1ts$2DateTime64(3, 'UTC'),", 'ts-not-null')
    : once(t, /\n(\s*)ts(\s+)timestamptz,/g, '\n$1ts$2timestamptz NOT NULL,', 'ts-not-null')),

  // Usage counters and exit_code that cannot hold null: ClickHouse turns a null into 0 on
  // insert (input_format_null_as_default), PostgreSQL refuses it.
  'counters-not-null': (t, p) => {
    for (const c of ['input', 'output', 'cache_read', 'cache_write', 'reasoning', 'tool_prompt']) {
      t = p === 'clickhouse'
        ? once(t, new RegExp(`\\n(\\s*)${c}(\\s+)Nullable\\(UInt64\\),`), `\n$1${c}$2UInt64 DEFAULT 0,`, 'counters-not-null')
        : once(t, new RegExp(`\\n(\\s*)${c}(\\s+)bigint,`), `\n$1${c}$2bigint NOT NULL DEFAULT 0,`, 'counters-not-null');
    }
    return p === 'clickhouse'
      ? once(t, /exit_code(\s+)Nullable\(Int32\),/, 'exit_code$1Int32 DEFAULT 0,', 'counters-not-null')
      : once(t, /exit_code(\s+)integer,/, 'exit_code$1integer NOT NULL DEFAULT 0,', 'counters-not-null');
  },

  // Two columns of sessions swapped (title and cwd), and two of session_parts (text and call_id):
  // a different DDL order gives a different legacy line (ClickHouse).
  'reorder-columns': (t) => {
    t = once(t, /(\n\s*title\s+String DEFAULT '',)(\n\s*title_set_by[^\n]*)(\n\s*cwd\s+String DEFAULT '',)/, '$3$2$1', 'reorder-columns');
    return once(t, /(\n\s*text\s+String DEFAULT '' CODEC\(ZSTD\(3\)\),)(\n\s*call_id\s+String DEFAULT '',)/, '$2$1', 'reorder-columns');
  },
};

// The profiles a DDL fault applies to, where not both (its pattern exists only there).
export const DDL_FAULT_PROFILES = {
  'partition-by-time': ['clickhouse'],
  'reorder-columns': ['clickhouse'],
  'sort-prefix-ingested-at': ['clickhouse'],
};

// The profiles an engine fault breaks anything in, where not both.
export const ENGINE_FAULT_PROFILES = {
  'pg-partial-upsert': ['postgres'],
};

// What each fault breaks, for the self-test's report.
export const FAULT_NOTES = {
  'ddl:drop-key-column': "session_units' key loses `chunk`",
  'ddl:registry-enum': 'harness, ts_source and enc constrained to the values known today',
  'ddl:no-host-check': 'no host/v0 form check',
  'ddl:partition-by-time': 'session_parts partitioned by month',
  'ddl:ts-not-null': '`ts` not Nullable',
  'ddl:counters-not-null': 'usage counters and exit_code not Nullable, default 0',
  'ddl:reorder-columns': 'two column pairs swapped in sessions and session_parts',
  'ddl:host-check-unanchored': 'the host form checks without ^ and $',
  'ddl:sort-prefix-ingested-at': "session_parts' sort key prefixed with toDate(ingested_at), which changes between versions",
  'engine:regenerate': 'a re-delivered read opens a new generation',
  'engine:cursor-early': 'the cursor advances right after the archive write',
  'engine:skip-removed': 'no removed versions',
  'engine:delete-removed': 'a key that leaves live is physically deleted',
  'engine:edges-from-pass': "edges recomputed from the pass's own statements only",
  'engine:drop-empty': 'a message with no parts is not written',
  'engine:fill-ts': 'a null ts is filled with the first-seen time',
  'engine:archive-held-back': 'a held-back partial line is archived',
  'engine:host-merge': 'one session across two hosts',
  'engine:no-manifest': 'no read manifests',
  'engine:ignore-policy': 'replay treats every vanished source as removed',
  'engine:replay-last-manifest': "replay takes a generation's last manifest as its whole content",
  'engine:rederive-keep-stale': 're-derive keeps keys the new version no longer produces',
  'engine:zero-nulls': 'null counters and exit_code written as 0',
  'engine:unredact': 'redaction markers replaced by the planted value',
  'engine:pg-skew': 'PostgreSQL part shas computed without null members',
  'engine:sql-tsv-no-trim': "the legacy line SQL keeps formatRow's trailing newline",
  'engine:policy-kept-as-removed': 'a vanished source the consumer keeps is removed, live and in its manifest',
  'engine:private-manifest': "manifests in a layout of the engine's own, which only its replay reads",
  'engine:ignore-crash': 'every pass runs to its end whatever crashAfter says (manifests of reads that change nothing omitted)',
  'engine:no-rerun-bump': 'a re-run that reads other content after a crash writes its manifest beside the crashed one, at the same generation and progress',
  'engine:part-sha-no-nulls': "a part's content_sha computed without its null members (both profiles)",
  'engine:chunk-drop': 'a unit stored in several chunks loses its last chunk',
  'engine:pg-partial-upsert': 'a PostgreSQL upsert sets only the columns the new version has, so one it lost keeps its old value',
  'engine:removed-rewrite': 'a removed version loses its text and its adapter-set state, its shas kept',
  'engine:edge-needs-all': 'an edge ends when any one of its supporting statements is removed',
  'engine:unredact-b64': 'a redacted unit stored with its planted value put back, as base64',
  'engine:host-merge-messages': "a second host's messages, usage, links and lifecycle written under the first host",
  'engine:fill-ts-lifecycle': "a lifecycle record's null ts filled with the first-seen time",
  'engine:manifest-whole-generation': "a read's manifest lists the whole generation after the read, not the units the read delivered (the fold is unchanged)",
};

-- Example 02: revisions, a removed version and a physical deletion (PostgreSQL).
-- Load schema/postgres.sql into an empty schema first, and set search_path to it.
-- clickhouse.sql is the same story in the ClickHouse profile.
--
-- One session record goes through four versions. PostgreSQL keeps one row per key, so every
-- write is the profile's upsert (spec section 3, and the write rule atop schema/postgres.sql):
-- INSERT ... ON CONFLICT (primary key) DO UPDATE SET <every non-key column> = EXCLUDED.<column>
-- WHERE EXCLUDED.rev > sessions.rev. Columns the INSERT does not name take their defaults, so
-- the upsert replaces the whole row. The host is the host/v0 value of a synthetic machine id;
-- the shas are stand-ins of the right length (example 03 computes real ones).

-- 1. The session, at rev 1.
INSERT INTO sessions
    (host, harness, harness_path, session_id, incarnation,
     title, state, reuse, ts_source, content_sha, adapter, adapter_ver, model_version, rev, removed)
VALUES
    ('dd20281dfd2171973d41a8686efeb11e', 'example-harness', '/home/user/.example-harness', 'example-session-1', '',
     'Draft plan', 'active', 'impossible', 'event', repeat('1', 64), 'example-adapter', '0.1.0', 'sessions-model/1', 1, 0)
ON CONFLICT (host, harness, harness_path, session_id, incarnation) DO UPDATE SET
    host_label = EXCLUDED.host_label, engine = EXCLUDED.engine, client = EXCLUDED.client,
    harness_version = EXCLUDED.harness_version, title = EXCLUDED.title,
    title_set_by = EXCLUDED.title_set_by, cwd = EXCLUDED.cwd, last_cwd = EXCLUDED.last_cwd,
    created_at = EXCLUDED.created_at, updated_at = EXCLUDED.updated_at, state = EXCLUDED.state,
    pinned = EXCLUDED.pinned, mode = EXCLUDED.mode, kind = EXCLUDED.kind, reuse = EXCLUDED.reuse,
    ts_source = EXCLUDED.ts_source, aliases = EXCLUDED.aliases, fingerprint = EXCLUDED.fingerprint,
    setup = EXCLUDED.setup, content_sha = EXCLUDED.content_sha, adapter = EXCLUDED.adapter,
    adapter_ver = EXCLUDED.adapter_ver, model_version = EXCLUDED.model_version, rev = EXCLUDED.rev,
    is_deleted = EXCLUDED.is_deleted, removed = EXCLUDED.removed,
    ingested_at = EXCLUDED.ingested_at, writer = EXCLUDED.writer
WHERE EXCLUDED.rev > sessions.rev;

-- 2. A revision: the user renamed the session. A changed row takes a strictly higher rev
--    (spec section 2, principle 4).
INSERT INTO sessions
    (host, harness, harness_path, session_id, incarnation,
     title, state, reuse, ts_source, content_sha, adapter, adapter_ver, model_version, rev, removed)
VALUES
    ('dd20281dfd2171973d41a8686efeb11e', 'example-harness', '/home/user/.example-harness', 'example-session-1', '',
     'Release plan', 'active', 'impossible', 'event', repeat('2', 64), 'example-adapter', '0.1.0', 'sessions-model/1', 2, 0)
ON CONFLICT (host, harness, harness_path, session_id, incarnation) DO UPDATE SET
    host_label = EXCLUDED.host_label, engine = EXCLUDED.engine, client = EXCLUDED.client,
    harness_version = EXCLUDED.harness_version, title = EXCLUDED.title,
    title_set_by = EXCLUDED.title_set_by, cwd = EXCLUDED.cwd, last_cwd = EXCLUDED.last_cwd,
    created_at = EXCLUDED.created_at, updated_at = EXCLUDED.updated_at, state = EXCLUDED.state,
    pinned = EXCLUDED.pinned, mode = EXCLUDED.mode, kind = EXCLUDED.kind, reuse = EXCLUDED.reuse,
    ts_source = EXCLUDED.ts_source, aliases = EXCLUDED.aliases, fingerprint = EXCLUDED.fingerprint,
    setup = EXCLUDED.setup, content_sha = EXCLUDED.content_sha, adapter = EXCLUDED.adapter,
    adapter_ver = EXCLUDED.adapter_ver, model_version = EXCLUDED.model_version, rev = EXCLUDED.rev,
    is_deleted = EXCLUDED.is_deleted, removed = EXCLUDED.removed,
    ingested_at = EXCLUDED.ingested_at, writer = EXCLUDED.writer
WHERE EXCLUDED.rev > sessions.rev;

-- @ after the revision, the current state
SELECT session_id, title, rev FROM sessions
WHERE NOT is_deleted AND removed = 0
ORDER BY session_id;

-- 3. A late re-send of rev 1, as a replayed pass delivers it: the upsert's WHERE refuses a row
--    whose rev is not higher than the stored one.
INSERT INTO sessions
    (host, harness, harness_path, session_id, incarnation,
     title, state, reuse, ts_source, content_sha, adapter, adapter_ver, model_version, rev, removed)
VALUES
    ('dd20281dfd2171973d41a8686efeb11e', 'example-harness', '/home/user/.example-harness', 'example-session-1', '',
     'Draft plan', 'active', 'impossible', 'event', repeat('1', 64), 'example-adapter', '0.1.0', 'sessions-model/1', 1, 0)
ON CONFLICT (host, harness, harness_path, session_id, incarnation) DO UPDATE SET
    host_label = EXCLUDED.host_label, engine = EXCLUDED.engine, client = EXCLUDED.client,
    harness_version = EXCLUDED.harness_version, title = EXCLUDED.title,
    title_set_by = EXCLUDED.title_set_by, cwd = EXCLUDED.cwd, last_cwd = EXCLUDED.last_cwd,
    created_at = EXCLUDED.created_at, updated_at = EXCLUDED.updated_at, state = EXCLUDED.state,
    pinned = EXCLUDED.pinned, mode = EXCLUDED.mode, kind = EXCLUDED.kind, reuse = EXCLUDED.reuse,
    ts_source = EXCLUDED.ts_source, aliases = EXCLUDED.aliases, fingerprint = EXCLUDED.fingerprint,
    setup = EXCLUDED.setup, content_sha = EXCLUDED.content_sha, adapter = EXCLUDED.adapter,
    adapter_ver = EXCLUDED.adapter_ver, model_version = EXCLUDED.model_version, rev = EXCLUDED.rev,
    is_deleted = EXCLUDED.is_deleted, removed = EXCLUDED.removed,
    ingested_at = EXCLUDED.ingested_at, writer = EXCLUDED.writer
WHERE EXCLUDED.rev > sessions.rev;

-- @ after the late re-send of rev 1, the current state
SELECT session_id, title, rev FROM sessions
WHERE NOT is_deleted AND removed = 0
ORDER BY session_id;

-- 4. The session left live (its derive no longer lists it). Its removed version is a full copy
--    of its last row at a higher rev, with removed = 1: the same upsert (spec section 2,
--    principle 3). It leaves the current state and stays as history.
INSERT INTO sessions
    (host, harness, harness_path, session_id, incarnation,
     title, state, reuse, ts_source, content_sha, adapter, adapter_ver, model_version, rev, removed)
VALUES
    ('dd20281dfd2171973d41a8686efeb11e', 'example-harness', '/home/user/.example-harness', 'example-session-1', '',
     'Release plan', 'active', 'impossible', 'event', repeat('2', 64), 'example-adapter', '0.1.0', 'sessions-model/1', 3, 1)
ON CONFLICT (host, harness, harness_path, session_id, incarnation) DO UPDATE SET
    host_label = EXCLUDED.host_label, engine = EXCLUDED.engine, client = EXCLUDED.client,
    harness_version = EXCLUDED.harness_version, title = EXCLUDED.title,
    title_set_by = EXCLUDED.title_set_by, cwd = EXCLUDED.cwd, last_cwd = EXCLUDED.last_cwd,
    created_at = EXCLUDED.created_at, updated_at = EXCLUDED.updated_at, state = EXCLUDED.state,
    pinned = EXCLUDED.pinned, mode = EXCLUDED.mode, kind = EXCLUDED.kind, reuse = EXCLUDED.reuse,
    ts_source = EXCLUDED.ts_source, aliases = EXCLUDED.aliases, fingerprint = EXCLUDED.fingerprint,
    setup = EXCLUDED.setup, content_sha = EXCLUDED.content_sha, adapter = EXCLUDED.adapter,
    adapter_ver = EXCLUDED.adapter_ver, model_version = EXCLUDED.model_version, rev = EXCLUDED.rev,
    is_deleted = EXCLUDED.is_deleted, removed = EXCLUDED.removed,
    ingested_at = EXCLUDED.ingested_at, writer = EXCLUDED.writer
WHERE EXCLUDED.rev > sessions.rev;

-- @ after the removal, the current state
SELECT session_id, title, rev FROM sessions
WHERE NOT is_deleted AND removed = 0
ORDER BY session_id;

-- @ after the removal, the removed versions (history: removed = 1)
SELECT session_id, title, rev, removed FROM sessions
WHERE NOT is_deleted AND removed = 1
ORDER BY session_id;

-- 5. A second session row that turns out to be a true duplicate (say, a converted row that
--    matches a captured one). Physical deletion is only for true duplicates and for keys an
--    upgraded adapter no longer produces (spec section 2, principle 3). In PostgreSQL it is a
--    DELETE.
INSERT INTO sessions
    (host, harness, harness_path, session_id, incarnation,
     title, state, reuse, ts_source, content_sha, adapter, adapter_ver, model_version, rev, removed)
VALUES
    ('dd20281dfd2171973d41a8686efeb11e', 'example-harness', '/home/user/.example-harness', 'example-session-2', '',
     'Duplicate', 'active', 'impossible', 'event', repeat('3', 64), 'example-adapter', '0.1.0', 'sessions-model/1', 1, 0)
ON CONFLICT (host, harness, harness_path, session_id, incarnation) DO UPDATE SET
    host_label = EXCLUDED.host_label, engine = EXCLUDED.engine, client = EXCLUDED.client,
    harness_version = EXCLUDED.harness_version, title = EXCLUDED.title,
    title_set_by = EXCLUDED.title_set_by, cwd = EXCLUDED.cwd, last_cwd = EXCLUDED.last_cwd,
    created_at = EXCLUDED.created_at, updated_at = EXCLUDED.updated_at, state = EXCLUDED.state,
    pinned = EXCLUDED.pinned, mode = EXCLUDED.mode, kind = EXCLUDED.kind, reuse = EXCLUDED.reuse,
    ts_source = EXCLUDED.ts_source, aliases = EXCLUDED.aliases, fingerprint = EXCLUDED.fingerprint,
    setup = EXCLUDED.setup, content_sha = EXCLUDED.content_sha, adapter = EXCLUDED.adapter,
    adapter_ver = EXCLUDED.adapter_ver, model_version = EXCLUDED.model_version, rev = EXCLUDED.rev,
    is_deleted = EXCLUDED.is_deleted, removed = EXCLUDED.removed,
    ingested_at = EXCLUDED.ingested_at, writer = EXCLUDED.writer
WHERE EXCLUDED.rev > sessions.rev;

-- @ with the duplicate written, every row a reader can see (current and removed)
SELECT session_id, title, rev, removed FROM sessions
WHERE NOT is_deleted
ORDER BY session_id;

DELETE FROM sessions
WHERE host = 'dd20281dfd2171973d41a8686efeb11e' AND harness = 'example-harness'
  AND harness_path = '/home/user/.example-harness' AND session_id = 'example-session-2'
  AND incarnation = '';

-- @ after the duplicate's physical deletion, every row a reader can see
SELECT session_id, title, rev, removed FROM sessions
WHERE NOT is_deleted
ORDER BY session_id;

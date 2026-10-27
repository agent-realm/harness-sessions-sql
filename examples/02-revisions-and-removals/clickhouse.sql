-- Example 02: revisions, a removed version and a physical deletion (ClickHouse).
-- Load schema/clickhouse.sql into an empty database first. postgres.sql is the same story in
-- the PostgreSQL profile.
--
-- One session record goes through four versions. Every version is a whole row: in ClickHouse a
-- write is a plain INSERT, and ReplacingMergeTree(rev, is_deleted) keeps, per key, the row with
-- the highest rev (spec section 3). The host is the host/v0 value of a synthetic machine id; the
-- shas are stand-ins of the right length (example 03 computes real ones).

-- 1. The session, at rev 1.
INSERT INTO sessions
    (host, harness, harness_path, session_id, incarnation,
     title, state, reuse, ts_source, content_sha, adapter, adapter_ver, model_version, rev, removed)
VALUES
    ('dd20281dfd2171973d41a8686efeb11e', 'example-harness', '/home/user/.example-harness', 'example-session-1', '',
     'Draft plan', 'active', 'impossible', 'event', repeat('1', 64), 'example-adapter', '0.1.0', 'sessions-model/1', 1, 0);

-- 2. A revision: the user renamed the session. A changed row takes a strictly higher rev
--    (spec section 2, principle 4).
INSERT INTO sessions
    (host, harness, harness_path, session_id, incarnation,
     title, state, reuse, ts_source, content_sha, adapter, adapter_ver, model_version, rev, removed)
VALUES
    ('dd20281dfd2171973d41a8686efeb11e', 'example-harness', '/home/user/.example-harness', 'example-session-1', '',
     'Release plan', 'active', 'impossible', 'event', repeat('2', 64), 'example-adapter', '0.1.0', 'sessions-model/1', 2, 0);

-- @ after the revision, the current state
SELECT session_id, title, rev FROM sessions FINAL
WHERE is_deleted = 0 AND removed = 0
ORDER BY session_id;

-- 3. A late re-send of rev 1, as a replayed pass delivers it: a row with a lower rev never
--    replaces one with a higher rev.
INSERT INTO sessions
    (host, harness, harness_path, session_id, incarnation,
     title, state, reuse, ts_source, content_sha, adapter, adapter_ver, model_version, rev, removed)
VALUES
    ('dd20281dfd2171973d41a8686efeb11e', 'example-harness', '/home/user/.example-harness', 'example-session-1', '',
     'Draft plan', 'active', 'impossible', 'event', repeat('1', 64), 'example-adapter', '0.1.0', 'sessions-model/1', 1, 0);

-- @ after the late re-send of rev 1, the current state
SELECT session_id, title, rev FROM sessions FINAL
WHERE is_deleted = 0 AND removed = 0
ORDER BY session_id;

-- 4. The session left live (its derive no longer lists it). Its removed version is a full copy
--    of its last row at a higher rev, with removed = 1 and is_deleted = 0 (spec section 2,
--    principle 3): it leaves the current state and stays as history.
INSERT INTO sessions
    (host, harness, harness_path, session_id, incarnation,
     title, state, reuse, ts_source, content_sha, adapter, adapter_ver, model_version, rev, removed)
VALUES
    ('dd20281dfd2171973d41a8686efeb11e', 'example-harness', '/home/user/.example-harness', 'example-session-1', '',
     'Release plan', 'active', 'impossible', 'event', repeat('2', 64), 'example-adapter', '0.1.0', 'sessions-model/1', 3, 1);

-- @ after the removal, the current state
SELECT session_id, title, rev FROM sessions FINAL
WHERE is_deleted = 0 AND removed = 0
ORDER BY session_id;

-- @ after the removal, the removed versions (history: removed = 1)
SELECT session_id, title, rev, removed FROM sessions FINAL
WHERE is_deleted = 0 AND removed = 1
ORDER BY session_id;

-- 5. A second session, written by an older adapter version under a key that the upgraded
--    adapter no longer produces (say, the new version folds it into another session). Such a key,
--    and a true duplicate, are the only rows deleted physically (spec section 2, principle 3; a
--    re-derive from the archive deletes exactly those keys, section 8). This example writes the
--    row and deletes it by hand; it runs no adapter. In ClickHouse the deletion is a version
--    with is_deleted = 1 at a higher rev, which FINAL drops.
INSERT INTO sessions
    (host, harness, harness_path, session_id, incarnation,
     title, state, reuse, ts_source, content_sha, adapter, adapter_ver, model_version, rev, removed)
VALUES
    ('dd20281dfd2171973d41a8686efeb11e', 'example-harness', '/home/user/.example-harness', 'example-session-2', '',
     'Old key', 'active', 'impossible', 'event', repeat('3', 64), 'example-adapter', '0.1.0', 'sessions-model/1', 1, 0);

-- @ with the old key written, every row a reader can see (current and removed)
SELECT session_id, title, rev, removed FROM sessions FINAL
WHERE is_deleted = 0
ORDER BY session_id;

INSERT INTO sessions
    (host, harness, harness_path, session_id, incarnation,
     title, state, reuse, ts_source, content_sha, adapter, adapter_ver, model_version, rev, removed, is_deleted)
VALUES
    ('dd20281dfd2171973d41a8686efeb11e', 'example-harness', '/home/user/.example-harness', 'example-session-2', '',
     'Old key', 'active', 'impossible', 'event', repeat('3', 64), 'example-adapter', '0.1.0', 'sessions-model/1', 2, 0, 1);

-- @ after the old key's physical deletion, every row a reader can see
SELECT session_id, title, rev, removed FROM sessions FINAL
WHERE is_deleted = 0
ORDER BY session_id;

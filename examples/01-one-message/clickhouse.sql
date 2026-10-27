-- Example 01: one session with one message, written by hand and read back (ClickHouse).
-- Load schema/clickhouse.sql into an empty database first: every table below is that DDL's.
--
-- Every row carries the session key (host, harness, harness_path, session_id, incarnation),
-- spec section 3. The host is the host/v0 value of a synthetic machine id
-- (0e0e0e0e0e0e4e0e8e0e0e0e0e0e0e01, sessions-model section 1), never a hostname.
-- The shas are stand-ins of the right length: a writer computes them from the records
-- (example 03 does).

-- The session record, at rev 1.
INSERT INTO sessions
    (host, harness, harness_path, session_id, incarnation,
     title, state, reuse, ts_source,
     content_sha, adapter, adapter_ver, model_version, rev)
VALUES
    ('dd20281dfd2171973d41a8686efeb11e', 'example-harness', '/home/user/.example-harness', 'example-session-1', '',
     'Hello world', 'active', 'impossible', 'event',
     repeat('a', 64), 'example-adapter', '0.1.0', 'sessions-model/1', 1);

-- One message with one text part: one row of session_parts, which carries its message's
-- columns (role, status, ts, ...) beside the part's (kind, text).
INSERT INTO session_parts
    (host, harness, harness_path, session_id, incarnation,
     message_id, part_id, part_index, order_key, role, source, status, state, ts,
     cmp_sha, message_content_sha, kind, text,
     content_sha, adapter, adapter_ver, model_version, rev)
VALUES
    ('dd20281dfd2171973d41a8686efeb11e', 'example-harness', '/home/user/.example-harness', 'example-session-1', '',
     'm-1', '0', 0, '0001', 'user', 'user', 'complete', 'current', '2026-01-02 09:00:00.000',
     repeat('b', 64), repeat('c', 64), 'text', 'Say hello.',
     repeat('d', 64), 'example-adapter', '0.1.0', 'sessions-model/1', 1);

-- Current state (spec section 6): read with FINAL, keeping is_deleted = 0 and removed = 0.

-- @ the session, current state
SELECT session_id, title, state, rev
FROM sessions FINAL
WHERE is_deleted = 0 AND removed = 0;

-- @ its message, current state, in order
SELECT message_id, part_id, role, kind, text, ts
FROM session_parts FINAL
WHERE is_deleted = 0 AND removed = 0
ORDER BY order_key, ts, message_id, part_index;

-- The same read with argMax(..., rev) instead of FINAL (spec section 3): per key, the values of
-- the row with the highest rev. The filter is on that row's flags, so it goes in HAVING.

-- @ its message, current state, read with argMax
SELECT message_id, part_id, argMax(text, rev) AS current_text, max(rev) AS current_rev
FROM session_parts
GROUP BY host, harness, harness_path, session_id, incarnation, message_id, part_id
HAVING argMax(is_deleted, rev) = 0 AND argMax(removed, rev) = 0;

-- Why HAVING: the message leaves live (a rewind removed it), so it gets a removed version, a full
-- copy of its last row at a higher rev with removed = 1 (spec section 2, principle 3; example 02
-- shows more).
INSERT INTO session_parts
    (host, harness, harness_path, session_id, incarnation,
     message_id, part_id, part_index, order_key, role, source, status, state, ts,
     cmp_sha, message_content_sha, kind, text,
     content_sha, adapter, adapter_ver, model_version, rev, removed)
VALUES
    ('dd20281dfd2171973d41a8686efeb11e', 'example-harness', '/home/user/.example-harness', 'example-session-1', '',
     'm-1', '0', 0, '0001', 'user', 'user', 'complete', 'current', '2026-01-02 09:00:00.000',
     repeat('b', 64), repeat('c', 64), 'text', 'Say hello.',
     repeat('d', 64), 'example-adapter', '0.1.0', 'sessions-model/1', 2, 1);

-- @ after the removal, read with argMax and the filter in HAVING (no message is current)
SELECT message_id, part_id, argMax(text, rev) AS current_text, max(rev) AS current_rev
FROM session_parts
GROUP BY host, harness, harness_path, session_id, incarnation, message_id, part_id
HAVING argMax(is_deleted, rev) = 0 AND argMax(removed, rev) = 0;

-- With the filter in WHERE instead, it drops the removed version before argMax picks one, so the
-- older version comes back as if it were current: wrong.

-- @ after the removal, the filter in WHERE instead (wrong, rev 1 comes back)
SELECT message_id, part_id, argMax(text, rev) AS current_text, max(rev) AS current_rev
FROM session_parts
WHERE is_deleted = 0 AND removed = 0
GROUP BY host, harness, harness_path, session_id, incarnation, message_id, part_id;

-- A key's host is a host/v0 value; both profiles refuse any other form (spec section 2,
-- principle 2): here ClickHouse's host_form constraint refuses a hostname, and the same row with
-- a host/v0 value, the control, is accepted.

-- @error a session whose host is a hostname
INSERT INTO sessions
    (host, harness, harness_path, session_id, incarnation,
     title, state, reuse, ts_source,
     content_sha, adapter, adapter_ver, model_version, rev)
VALUES
    ('my-laptop', 'example-harness', '/home/user/.example-harness', 'example-session-2', '',
     'Hello again', 'active', 'impossible', 'event',
     repeat('e', 64), 'example-adapter', '0.1.0', 'sessions-model/1', 1);

INSERT INTO sessions
    (host, harness, harness_path, session_id, incarnation,
     title, state, reuse, ts_source,
     content_sha, adapter, adapter_ver, model_version, rev)
VALUES
    ('dd20281dfd2171973d41a8686efeb11e', 'example-harness', '/home/user/.example-harness', 'example-session-2', '',
     'Hello again', 'active', 'impossible', 'event',
     repeat('e', 64), 'example-adapter', '0.1.0', 'sessions-model/1', 1);

-- @ the same row with a host/v0 value is accepted, the sessions now
SELECT session_id, title, host
FROM sessions FINAL
WHERE is_deleted = 0 AND removed = 0
ORDER BY session_id;

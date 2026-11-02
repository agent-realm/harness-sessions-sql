-- harness-sessions-sql v1.1, PostgreSQL database profile: the reading function of §6.
-- Loaded after schema/postgres.sql, as one statement (its body holds semicolons). A deployment
-- that prefixes its tables (§3) prefixes the table this function reads in the same way.

-- 6. One row per turn of one session (plan), the shape of ClickHouse's session_turns view. A turn
-- starts at a message a person sent in the main conversation (role 'user', source 'user',
-- agent_id '') and runs to the next one; messages before the first prompt are turn 0. Current
-- state only (a PostgreSQL row is its key's current version), on the active branch where the
-- harness store keeps branches.
--   SELECT * FROM session_turns('…', '…', '…', '…', '')
CREATE FUNCTION session_turns(p_host text, p_harness text, p_harness_path text, p_session_id text, p_incarnation text)
RETURNS TABLE (
  turn              bigint,
  prompt_message_id text,
  started_at        timestamptz,
  ended_at          timestamptz,
  messages          bigint,
  tool_calls        bigint,
  tool_errors       bigint,
  served_models     text[]
)
LANGUAGE sql STABLE AS $$
  WITH
    parts AS (
      SELECT * FROM session_parts
      WHERE host = p_host AND harness = p_harness AND harness_path = p_harness_path
        AND session_id = p_session_id AND incarnation = p_incarnation
        AND NOT is_deleted AND removed = 0
        AND state = 'current' AND part_state IN ('', 'current')
        AND coalesce(on_active_branch, true)
    ),
    messages AS (
      SELECT message_id,
             min(order_key COLLATE "C") AS order_key,
             (bool_or(role = 'user') AND bool_or(source = 'user') AND bool_and(agent_id = ''))::int AS is_prompt
      FROM parts
      GROUP BY message_id
    ),
    numbered AS (
      SELECT message_id, is_prompt,
             -- byte order, as ClickHouse compares strings, whatever the database's collation
             sum(is_prompt) OVER (ORDER BY order_key COLLATE "C", message_id COLLATE "C"
                                  ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS turn
      FROM messages
    )
  SELECT n.turn::bigint,
         min(p.message_id) FILTER (WHERE n.is_prompt = 1),
         min(p.ts),
         max(p.ts),
         count(DISTINCT p.message_id),
         count(*) FILTER (WHERE p.kind = 'tool_call'),
         count(*) FILTER (WHERE p.kind = 'tool_result' AND p.is_error),
         -- byte order, as ClickHouse's arraySort
         coalesce(array_agg(DISTINCT p.served_model COLLATE "C" ORDER BY p.served_model COLLATE "C") FILTER (WHERE p.served_model <> ''), '{}')
  FROM parts AS p
  JOIN numbered AS n USING (message_id)
  GROUP BY n.turn
  ORDER BY n.turn
$$;

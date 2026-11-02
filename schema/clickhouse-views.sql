-- harness-sessions-sql v1.1, ClickHouse database profile: the reading view of §6.
-- Loaded after schema/clickhouse.sql. A deployment that prefixes its tables (§3) prefixes the
-- tables this view reads in the same way.

-- 6. One row per turn of one session (plan). A turn starts at a message a person sent in the
-- main conversation (role 'user', source 'user', agent_id '') and runs to the next one; messages
-- before the first prompt are turn 0. Current state only, on the active branch where the harness
-- store keeps branches. The session key is the view's parameters, so the filter on the sort-key
-- prefix of session_parts comes before FINAL, and a read touches one session's granules:
--   SELECT * FROM session_turns(host = '…', harness = '…', harness_path = '…',
--                               session_id = '…', incarnation = '')
CREATE VIEW session_turns AS
WITH
  parts AS (
    SELECT * FROM session_parts FINAL
    WHERE host = {host:String} AND harness = {harness:String}
      AND harness_path = {harness_path:String}
      AND session_id = {session_id:String} AND incarnation = {incarnation:String}
      AND is_deleted = 0 AND removed = 0
      AND state = 'current' AND part_state IN ('', 'current')
      AND ifNull(on_active_branch, true)
  ),
  messages AS (
    SELECT message_id,
           min(order_key) AS order_key,
           toUInt32(any(role) = 'user' AND any(source) = 'user' AND any(agent_id) = '') AS is_prompt
    FROM parts
    GROUP BY message_id
  ),
  numbered AS (
    SELECT message_id, is_prompt,
           sum(is_prompt) OVER (ORDER BY order_key, message_id
                                ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS turn
    FROM messages
  )
SELECT n.turn                                                AS turn,
       anyIf(p.message_id, n.is_prompt = 1)                  AS prompt_message_id,
       min(p.ts)                                             AS started_at,
       max(p.ts)                                             AS ended_at,
       uniqExact(p.message_id)                               AS messages,
       countIf(p.kind = 'tool_call')                         AS tool_calls,
       countIf(p.kind = 'tool_result' AND ifNull(p.is_error, false)) AS tool_errors,
       arraySort(groupUniqArrayIf(p.served_model, p.served_model != '')) AS served_models
FROM parts AS p
INNER JOIN numbered AS n USING (message_id)
GROUP BY n.turn
ORDER BY n.turn;

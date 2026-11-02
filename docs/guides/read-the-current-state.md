# Read the current state

The current state is every entity row that is neither deleted nor removed ([§6][s6]). How to read
it depends on the profile, and in ClickHouse on the form of the query. The SQL below is that of
[example 01](../../examples/01-one-message/) and [example 02](../../examples/02-revisions-and-removals/),
which run it.

## ClickHouse: `FINAL`

The entity tables are `ReplacingMergeTree(rev, is_deleted)`. Read with `FINAL`, which collapses
each key to its row with the highest `rev`, and keep `is_deleted = 0` and `removed = 0`
([§3][s3]):

```sql
SELECT session_id, title, rev
FROM sessions FINAL
WHERE is_deleted = 0 AND removed = 0;
```

## ClickHouse: `argMax`, with the filter in `HAVING`

`argMax(…, rev)` reads the same state without `FINAL`: per key, the values of its row with the
highest `rev`. The filter must test that row's flags, so it goes in `HAVING`:

```sql
SELECT message_id, part_id, argMax(text, rev) AS current_text, max(rev) AS current_rev
FROM session_parts
GROUP BY host, harness, harness_path, session_id, incarnation, message_id, part_id
HAVING argMax(is_deleted, rev) = 0 AND argMax(removed, rev) = 0;
```

The same filter in `WHERE` drops a removed version before `argMax` picks a row, and brings an
older version of a removed key back as if it were current. Example 01 shows both placements on an
inline set of two versions. The specification does not yet say where the filter goes:
[SPEC-QUESTIONS.md, question 32](../../conformance/SPEC-QUESTIONS.md#reading-the-current-state).

## PostgreSQL

PostgreSQL keeps one row per key: the upsert replaces it only with a higher `rev` ([§3][s3]). There
is nothing to collapse, so the filter is the whole rule:

```sql
SELECT session_id, title, rev
FROM sessions
WHERE NOT is_deleted AND removed = 0;
```

## History: removed content

A key that left `live` keeps a removed version, `removed = 1`: history, searchable, never counted
([§2][s2], principle 3; [§6][s6]). Read it as above (with `FINAL` in ClickHouse), keeping the
`is_deleted` filter and taking `removed = 1` in place of `removed = 0`;
[example 02](../../examples/02-revisions-and-removals/) prints it.

## Why the other reads come and go

Until a background merge collapses them, a ClickHouse table holds every version of a key that has
not merged away ([§6][s6]). A read without `FINAL`, or an `argMax` read filtered in `WHERE`, sees
those versions: the older version of a revised or removed key is there before a merge and gone
after one, so the same query gives different answers at different times. Only `FINAL` and the
`HAVING` form give the current state whatever the merges have done. A read of history without
`FINAL` is best-effort; the archive is the guaranteed path ([§6][s6], and
[example 04](../../examples/04-raw-and-derived/)).

To read a session whole, join the entity tables on the session key, each read as above
([example 03](../../examples/03-records-to-rows/)).

## A record's raw units (v1.1)

A session row's `units` and a part row's `message_units` name the units the record came from, as
`(source_key, generation, unit_key)` triples ([§4.2][s42], [§4.3][s43]). Join them to
`session_units` on the session key and the triple, with a `LEFT JOIN`: a source removed under the
`removed` vanish policy leaves its triples naming nothing ([§6][s6]). In ClickHouse, unnest the
named tuples with `ARRAY JOIN`:

```sql
SELECT m.source_key, m.generation, m.unit_key, u.chunk, u.enc, u.raw
FROM (SELECT DISTINCT host, harness, harness_path, session_id, incarnation,
             tupleElement(t, 'source_key') AS source_key,
             tupleElement(t, 'generation') AS generation,
             tupleElement(t, 'unit_key') AS unit_key
      FROM session_parts FINAL ARRAY JOIN message_units AS t
      WHERE session_id = {session_id:String} AND message_id = {message_id:String}
        AND is_deleted = 0 AND removed = 0) AS m
LEFT JOIN (SELECT * FROM session_units FINAL WHERE session_id = {session_id:String}) AS u
  ON u.host = m.host AND u.harness = m.harness AND u.harness_path = m.harness_path
 AND u.incarnation = m.incarnation AND u.source_key = m.source_key
 AND u.generation = m.generation AND u.unit_key = m.unit_key
ORDER BY m.source_key, m.generation, m.unit_key, u.chunk;
```

In PostgreSQL, `jsonb_array_elements(message_units)` gives one object per triple. Join a unit's
chunks in `chunk` order; `enc` says how to read them (`utf8` as text, `b64` as base64).
`units` is outside `content_sha`, so a row may keep the triples of an earlier generation after a
reset that changed nothing else: they still name units of the archive. Where a snapshot or delta
source keeps several versions of one slot, the record's is the latest archived at or before its
revision. [Example 06](../../examples/06-turns-and-native/) runs this read, with the whole session
key in the subqueries, on both profiles.

## A session's turns (v1.1, plan)

Load `schema/clickhouse-views.sql` (or `schema/postgres-views.sql`) after the tables, then:

```sql
-- ClickHouse: a parameterized view, filtered on the sort-key prefix before FINAL
SELECT * FROM session_turns(host = '…', harness = 'claude-code', harness_path = '…',
                            session_id = '…', incarnation = '');
-- PostgreSQL: a SQL function of the same shape
SELECT * FROM session_turns('…', 'claude-code', '…', '…', '');
```

One row per turn: a turn starts at a person's prompt in the main conversation and runs to the
next one ([§6][s6]). Turn 0, the messages before the first prompt, has no prompt: `''` in
ClickHouse, null in PostgreSQL. The view is (plan) until it is measured on a house of realistic
size.

[s2]: ../../01-SESSIONS-SQL-SPEC.md#2-core-principles
[s3]: ../../01-SESSIONS-SQL-SPEC.md#3-keys-and-versioning
[s42]: ../../01-SESSIONS-SQL-SPEC.md#42-sessions
[s43]: ../../01-SESSIONS-SQL-SPEC.md#43-session_parts
[s6]: ../../01-SESSIONS-SQL-SPEC.md#6-reading-extraction

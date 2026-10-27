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

[s2]: ../../01-SESSIONS-SQL-SPEC.md#2-core-principles
[s3]: ../../01-SESSIONS-SQL-SPEC.md#3-keys-and-versioning
[s6]: ../../01-SESSIONS-SQL-SPEC.md#6-reading-extraction

# Questions for the specification

Points where `01-SESSIONS-SQL-SPEC.md` (v0) was ambiguous, or where a §8 item could not be checked
as it was written. For each: what the kit or the reference engine did, so nothing here was
invented silently, and the question the specification should settle.

**Status against v1 of the specification.** v1 answers 1 to 5, 7 to 17 and 29; 6 and
18 belong to the session-adapters package. 19 to 28, 30 and 31 are open: v1 does not settle them, 27
and 28 came from the kit's last review, 29 and 30 from v1's derived columns (§3), and 31 from
the first production engine's inferred edges. Each answered item ends with its answer and the section that now
holds it, and each open one says so. The questions stay as they were asked, so
the answers can be read against them.

| # | Answered in | Kit change |
|---|---|---|
| 1 | §8 Redaction holds | none: the check already held the engine to it |
| 2 | §4.1, §8 Twice is once | No-op manifests strips every manifest that changes nothing in the fold |
| 3 | §8 Legacy content_sha, whole rows | the check names the conversion half in its report |
| 4 | §4.8, §8 (ClickHouse database profile items) | none: both items were already n/a on PostgreSQL |
| 5 | §8 Removed equals not live | none |
| 6 | not a spec question (package) | none |
| 7 | §4, schema | the reference engine stores the version string; Re-derive checks it |
| 8 | §4.5, schema | the reference engine keeps null; Null is unknown checks it |
| 9 | §4.1, schema | the reference engine writes null; Null is unknown checks it |
| 10 | §4.1 | none |
| 11 | §4.1, §5 | none |
| 12 | §4.3 | none |
| 13 | §4.1 | none |
| 14 | §4.5, §5 | none |
| 15 | §8 Absences replay | none |
| 16 | §8 (Envelopes) | none |
| 17 | §8 Crash-safe | none |
| 18 | not a spec question (package) | README: a checkout pinned to the package's release tag |
| 19 to 26 | open | none |
| 27 | open | none |
| 28 | open (a kit convention) | none |
| 29 | §3 Derived columns, §8 Redaction holds | Redaction holds judges a column the deployment adds against the records of the row's session; a second pass removes a message that holds a planted value; two faults and three test engines |
| 30 | §2 principles 1 and 3, §3 Derived columns | none: the kit already judges history rows against the session's records, current or removed; forgotten content is not checked until an engine honours forget notices |
| 31 | open (v1.x) | none |

## Checks that cannot run as §8 words them

1. **Redaction holds (§8).** "The sentinel-secret fixtures leave no sentinel value in any table."
   All three sentinel fixtures (Goose, Zed, OpenCode) also plant a value in free text, which no
   redaction path covers and which the adapter keeps on purpose (sessions-model §4 rule 6). Read
   literally, no engine can pass. *The kit checks:* no row holds a planted value unless the unit
   or record it was written from holds it, and the values redacted on declared paths are in no
   table. *Question:* should §8 say "no value the adapter redacted", or "no sentinel on a declared
   path"?

   *Answered (§8):* no value the adapter redacted on a declared redaction path is in any table, and
   no row holds a planted value that the unit or record it was written from did not hold. Free text
   an adapter keeps on purpose is the adapter's contract, not storage's.

2. **Twice is once (§8).** "No duplicate logical rows" is not defined. A re-delivered `unchanged`
   read, or a delta read whose position did not move (a delta position is only a hint, sessions
   §1), cannot be told from a new read by its position, so an engine that writes no-op manifests
   writes another one. *The kit checks:* a repeat adds no row to the entity tables or the cursor,
   no unit and no generation to session_units; it may add read manifests that deliver nothing new
   (in an existing generation, not `source_gone`, listing only units the generation already holds
   and only gone keys already reported). It repeats each pass right after itself, as §5 re-runs a
   pass, and never delivers an earlier pass after a later one (19). *Question:* is that the
   meaning, and should §4.1 also let an engine omit the manifest of a read that changes nothing in
   the fold (not only one that delivers nothing)?

   *Answered (§8, §4.1):* a repeat adds no entity row version, no cursor row version, no unit and
   no generation; it may add read manifests that deliver nothing new, as the kit checks. §4.1 now
   lets an engine omit the manifest of any read that changes nothing in the fold, and the No-op
   manifests check strips exactly those. Which deliveries count as the same envelopes again stays
   open (19).

3. **Legacy content_sha, whole rows (§8).** "The conversion of that row gives that line." The kit
   has no memhouse 0.18 input and cannot run an implementation's conversion. *The kit checks* the
   half the database profile owns: each vector's fields, named by the committed DDL order, loaded
   by name into the deployed table, format back in the deployed DDL order into the line and the
   sha, through §4.8's own expression (the database part: the DDL) and through the engine's own
   legacy SQL (`legacySha`, the engine part). An engine that supplies no legacy SQL has the
   engine parts of both legacy items skipped, never passed on §4.8's expression. *Question:*
   should the engine interface gain a conversion hook (a 0.18-shaped input row in, the converted
   row out), or is the conversion proved by the implementation's own tests?

   *Answered (§8):* the item has two halves. The database half (DDL order, line, sha) is the kit's,
   through §4.8's expression and through the engine's legacy SQL as before; the conversion half is
   proved by the implementation's own known-answer tests, named in its conformance report. v1 has
   no conversion hook.

4. **Legacy content_sha on PostgreSQL (§8, §4.8).** §4.8 computes the sha "where the conversion
   runs" and gives the SQL for ClickHouse only, and a conversion reads a ClickHouse database. *The
   kit reports* both legacy items `n/a` on PostgreSQL. *Question:* are they ClickHouse-only items,
   or should §4.8 give a PostgreSQL rendering of the same line?

   *Answered (§4.8, §8):* legacy conversion exists only for ClickHouse houses, so both legacy items
   are ClickHouse database profile items.

5. **Removed equals not live (§8).** "Current keys are exactly that pass's live sets." A key in
   `held` keeps its last written version (sessions §2), so it is current without being in `live`.
   *The kit expects* `live`, plus each held key that was written before. *Question:* should §8 say
   so?

   *Answered (§8):* current keys are exactly the pass's `live` sets plus each held key written
   before (sessions §2).

6. **Null is unknown (§8).** No fixture emits a null `input`, `output` or `output_ref_bytes`. *The
   kit covers* those with synthetic rows in the database part only; the engine part covers the
   counters, flags and `exit_code` the fixtures do emit as null. Not a spec question: a note that
   a fixture with those nulls would let an engine prove them.

   *Not a spec question.* A synthetic package fixture with those nulls is a package follow-up;
   until then the database part covers them.

## Shapes the DDL and the records disagree on

7. **`adapter_ver`.** Both DDL files store an integer (`UInt32`, `integer`); the session adapters
   state a version string (`0.2.0`). *The reference engine* stores `a.b.c` as a·10⁶ + b·10³ + c,
   through one encoder for every table, and refuses a version it cannot encode. *Question:* should
   the column be a string, or should §4 fix the encoding?

   *Answered (§4, both DDL files):* a string column (`LowCardinality(String)`, `text`) holding the
   version as the adapter states it. The reference engine's integer encoding is gone; the Re-derive
   check now requires every row the new version writes to carry that version string exactly, with
   the controls `engine:encode-adapter-ver` and `ddl:adapter-ver-integer`.

8. **`child_stored`.** Both DDL files make it a non-nullable boolean, default true; an
   origin-side statement may carry `child_stored: null` (OpenCode's `task` part). *The reference
   engine* writes the default, which turns "unknown" into "stored". *Question:* `Nullable(Bool)` /
   nullable `boolean`?

   *Answered (§4.5, both DDL files):* `Nullable(Bool)` / nullable `boolean`, null = unknown. The
   reference engine keeps a statement's null, and an edge's `child_stored` is false when a
   supporting statement says false, true when one says true, null when none says. The Null is
   unknown check covers it, with the controls `ddl:unknowns-not-null` and
   `engine:child-stored-default`.

9. **`orig_sha256` in ClickHouse.** `FixedString(64) DEFAULT ''` stores 64 zero bytes, not an empty
   value, for a unit with no original sha; PostgreSQL stores null. *Question:* `String`, or
   `Nullable(FixedString(64))`, so the two profiles mean the same thing?

   *Answered (§4.1, ClickHouse DDL):* `Nullable(FixedString(64))`, so both database profiles store
   null for no original sha, and for a manifest. The Null is unknown check covers it, with the
   controls `ddl:unknowns-not-null` and `engine:orig-sha-zero`. No fixture unit carries a
   unit-level `orig_sha256` today (the Zed adapter keeps it inside the row-json body), so the
   engine part proves the null path and the database part the column.

## Semantics the reference engine had to choose

10. **The continuity of a manifest (§4.1).** The manifest's `continuity` lists `appended`, `delta`,
    `reset`, `snapshot`. A no-op read returns `unchanged` (sessions §3), and a vanished source has
    no read at all. *The reference engine* writes `unchanged` for the first and `reset` for the
    second (a vanished source opens a generation). *The kit accepts* those five values in a
    manifest, and checks every other key of §4.1's object (23). *Question:* which values belong
    there?

    *Answered (§4.1):* `continuity` is the read's sessions §3 value as the seam returned it,
    `unchanged` included, from a list closed in v1; a vanished source opens a generation as `reset`
    does, and `source_gone` stays a flag, not a continuity value. This is what the reference engine
    writes and what the kit accepts.

11. **`progress` (§4.1, §4.6, §7).** A manifest carries "the cursor progress after this read", the
    cursor's `ver` is per source, and `rev` is described from the progress "for the session".
    Replay folds manifests "in progress order". If progress is per source, a replay cannot tell
    which reads of several sources belonged to one pass, and deriving after each read can produce
    removed versions of keys that were live only between two sources' reads, which the live pass
    never wrote ("removed versions included" in §8 would then differ). *The reference engine* uses
    a per-session pass counter, shared by every manifest of one pass, and replays pass by pass.
    *Question:* should §4.1 say that the manifests of one pass share a progress value (or carry a
    pass id)?

    *Answered (§4.1, §5):* `progress` is the session's pass counter, shared by every manifest of
    one pass, and replay derives once per pass. This is what the reference engine does.

12. **A part its message no longer has (§4.3).** "A message-level change revises every part row of
    that message at the new rev", but a revised message can lose a part, and a message that had
    none (its header row, `part_id ''`) can gain one. *The reference engine* writes a removed
    version of the stale part row. *Question:* removed version, or physical deletion (it is not a
    key the adapter's `live` names)?

    *Answered (§4.3):* a removed version, as for any key that left `live`; never a physical
    deletion.

13. **A vanished source under `"policy": "removed"` (§4.1).** The kit replays it as empty, as §4.1
    says, and derives the session over what is left. Derived over no units, an adapter can still
    list the session record itself (Codex does), so the session's row stays current while its
    messages are removed. *Question:* is that intended, or should "removed" also remove the session
    row?

    *Answered (§4.1):* intended. `"policy": "removed"` removes the source's units and what derives
    from them; whether the session itself stays current is the adapter's derive over what is left.

14. **Edges (§4.5).** *The reference engine* writes an edge only when both ends resolve to exactly
    one held session; writes `other_host` and `other_harness_path` as `''` when the origin is in the
    child's own harness store (the statements' convention); takes `inherits` fields from the
    child-side statement first; and ends an edge with a removed version. *Questions:* is an edge
    with an unresolved end written at all; are its reference columns resolved values or `''`; and
    is an ended edge a removed version or a deletion?

    *Answered (§4.5, §5):* an edge is written only when both ends resolve to exactly one held
    session (the statements wait until then); its references use the statements' `''` convention
    for the child's own harness store; an ended edge is a removed version. v1 does not say which
    statement an edge takes its `inherits` fields from, so that stays the reference engine's
    choice.

15. **Replaying edges (§4.1, §8 Absences replay).** Replay folds each session alone, and the order
    of passes across sessions is not archived (progress is per session), so a replay rebuilds the
    current edges but not the removed versions of edges that ended. *The kit compares* current
    edges, and current and removed adapter-owned rows. *Question:* is an ended edge's removed
    version history a replay must rebuild?

    *Answered (§8):* not required. Replay rebuilds the current edges and the adapter-owned rows,
    current and removed.

## The kit's own conventions, which the specification may want to own

16. **The envelope.** §8 says "envelopes" without defining them. *The kit defines* one as one read
    of one source as the seam delivers it, plus the position it was read from (`from`), or a
    consumer's `source_gone` decision with its policy (README). *Question:* should §8, or the
    `sessions` seam, define the unit of input a conforming engine is fed?

    *Answered (§8):* §8 defines the envelope as the kit does; the `sessions` seam needs no change.

17. **The crash points.** §8 kills the pass "between the archive write and the cursor write". The
    kit stops it right after the archive write, and at every later point an engine declares
    (`crashPoints`; the reference: after the archive, the entity writes, the removed versions and
    the edges). It checks each stop instead of trusting it: the pass's units are archived, the
    cursor is as it was (so every declared point must lie before the cursor write), and right
    after the archive write the entity tables are untouched. A cursor is consumer policy (§4.6), so
    the kit reads it through an engine's `cursor()` where it has one, else from session_sources,
    and reports the item not proven when it sees neither change over a clean run.

    *Answered (§8):* the minimum point is right after the archive write, before the cursor write;
    an engine may declare more, and the item holds at each. How the kit sees an engine's cursor
    (`cursor()`, else session_sources) stays the kit's own convention (27).

18. **The session-adapters package before npm.** `SSQL_ADAPTERS` is a path or a package name; a
    published package does not ship `fixtures/`, which the engine checks need. Until the fixtures
    are published on their own, the kit needs a checkout.

    *Not a spec question.* The kit takes `SSQL_ADAPTERS` as a checkout of the package, pinned to
    its release tag once it has one (README). The fixtures ship as a package of their own only if a
    consumer without a checkout appears.

## More points the kit had to settle

19. **Stale re-deliveries and reads from scratch (§5, §8 Twice is once).** "Ingesting the same
    envelopes twice" can mean a pass re-run right after itself (what §5 does after a crash), or an
    earlier pass delivered again after a later one. A pass-1 read arriving after pass 2 cannot be
    told from a consumer that starts over, except by comparing its `from` with the cursor, and §5
    does not say an engine must; an engine that honours a read from scratch opens a generation for
    it. *The kit checks* only a pass delivered again right after itself. *The reference engine*
    ignores a read whose `from` is not its cursor's position, except a read from scratch (`from`
    null): when it delivers exactly the units the source holds it only moves the position,
    otherwise it opens a generation. It treats a null `from` and a null stored position as one
    position. *Question:* must an engine recognise a stale re-delivery, and how does a consumer that
    starts over say so?

    *Open:* v1 does not settle it.

20. **A crash, then other content (§4.1, §5).** A pass that crashes after its archive write leaves
    manifests the cursor never committed. When its re-run reads other content from the same
    positions (the harness store changed in between), the re-run's manifest sits beside the
    crashed one at the same generation and the same `progress`, so §4.1's fold, "in progress
    order", has no order between them, and a unit the crashed read delivered and the re-run never
    saw is folded in. *The kit checks* that the re-run gives the state of a clean run of what was
    committed, live, in its own fold of the archive and in the engine's replay. *The reference
    engine* gives such a re-run a generation of its own, holding the whole source as the re-run
    leaves it; a source the crashed pass read and the re-run does not gets its committed units
    again in a new generation (a source the crashed pass read first, and nobody reads again, stays
    as the crashed read left it). *Question:* should §4.1 say so, or should a manifest carry the
    read it records (its `from`, or a read id) so a replay can drop an uncommitted read?

    *Open:* v1 does not settle it.

21. **Chunks (§4.1).** A unit "stored in several chunks" is not specified further: how its raw is
    split, how the chunks are numbered, whether each carries the whole unit's `sha256` and `enc`.
    *The kit reads* the chunks of one `(source, generation, unit_key, sha256)` as one unit: numbered
    0, 1, … with one `enc`, their `raw` joined in chunk order is the unit's body. *The reference
    engine* (option `chunkBytes`) splits a long raw at character boundaries. *Question:* is that the
    layout, and does a manifest list a chunked unit once?

    *Open:* v1 does not settle it.

22. **The DDL a database check tests (§3, §8).** §8's database items test "the database profile's
    DDL, under the deployment's physical table names", and §3 lets a deployment's DDL differ from
    `schema/` (a prefix, extra columns, a sort-key prefix). *The kit tests* the DDL the engine makes
    through `createTables`; without it, it loads `schema/` and reports those rows as a self-check of
    `schema/`, outside the engine's verdict. *Question:* should §8 say how an implementation hands
    its DDL to a conformance run (§3's "say so in one place", for example its schema template)?

    *Open:* v1 does not settle it.

23. **The manifest's object, strictly (§4.1).** §4.1 lists the keys of a manifest's `raw`, but not
    whether others may be added, nor the type of `progress`. *The kit requires* `progress` (a
    non-negative integer, or its decimal string), `continuity` (10's five values), `units` (a list
    of `[unit_key, sha256]`), `gone`, `source_gone` (a boolean), `policy` only with `source_gone`,
    a row `continuity` equal to the object's, and `sha256` the sha of `raw`; it accepts other keys.
    *Question:* may a manifest carry keys of its own (20's read id would be one)?

    *Open:* v1 does not settle it.

24. **A part's own source or state equal to its message's (§4.3).** `part_source` and `part_state`
    hold a part's own values "where they differ from its message's", and `''` "where the part has
    none of its own". A part whose own value equals its message's has one of its own that does not
    differ. *The kit accepts* the value or `''` there. *The reference engine* writes the value. No
    fixture has such a part yet. *Question:* which one?

    *Open:* v1 does not settle it.

25. **A merged edge whose `at` came from the statement removed first (§4.5).** A merged edge takes
    `at` from the parent's call, while the child's statement has none; `at` is in the edge's key.
    Removing the parent's statement first leaves a child-only edge at `''`: a new key, so the
    merged edge ends though a supporting statement stands. *The kit checks* that an edge for the
    pair is still current while either statement stands, and removes the child's statement first.
    *Question:* does a merged edge keep its key when the statement that gave it `at` is removed?

    *Open:* v1 does not settle it.

26. **The sort-key prefix (§3).** "A consumer may prefix the sort key with columns that never change
    for a key, such as `toDate(ts)` for messages." Which columns never change for a key is not
    listed: sessions-model §1 rule 7 says so of `ts`, and nothing names another. *The kit accepts*,
    in ClickHouse, leading sort-key elements that are `ts` or one function of `ts` alone
    (`toDate(ts)`, `toStartOfHour(ts)`, …), before the identity columns, in any table that has
    `ts`; any other extra element fails Tables and keys (`toDate(ingested_at)` is one of its
    faults: it changes between versions, so they never collapse). A PostgreSQL primary key must be
    the identity exactly. *Question:* is that the allowance, or may a deployment prefix other
    columns, and is it limited to `session_parts`?

    *Open:* v1 does not settle it.

27. **A deployment with no `session_sources` (§8, §4.6).** §8's first item lets `session_sources`
    be absent ("informative and may be absent"), and §4.6 lets an engine keep its cursor elsewhere.
    *The kit* passes Tables and keys for such a DDL, noting the table absent, and Crash-safe reads
    the cursor through the engine's `cursor()` where it has one (17). Four checks still read or
    write the table itself: Twice is once and Redaction holds read every table, and Crash-safe
    counts the rows of every table, so each of them reports an error; Host form inserts its
    synthetic rows into every table with a key `host`, and reports the refused `session_sources`
    rows as valid hosts rejected, a fail. A test engine whose own DDL has no `session_sources` and
    whose cursor is a table of its own, exposed as `cursor()`, gets exactly those four, on both
    database profiles, and passes every other item that applies. *Question:* does a deployment without
    `session_sources` conform, as §8's first item implies, so that these checks should leave out a
    table §8 lets be absent; and is the host form check on `session_sources.host` normative when the
    table itself is informative?

28. **The disposable pair's PostgreSQL user (`compose.yml`).** Not a spec question: a kit
    convention. The pair makes the user `kit` with the image's defaults, so it is a PostgreSQL
    superuser, one that can run programs inside the container. The container holds nothing and
    lives for one run, its ports are published on `127.0.0.1` only, and the file refuses to start
    without `SSQL_KIT_PASSWORD`; README gives the same warning for a deployment file of one's own
    that publishes it anywhere else. A role without superuser would need an init script in the compose
    file, and the right to create schemas in the database `kit`, where the kit makes and drops a
    schema per check. *Question:* is a non-superuser role worth that setup cost, for a throwaway
    container?

## Columns a deployment adds

29. **A derived column (§3, §4.8, §8 Redaction holds).** §4.8 leaves "any column a deployment adds"
    out of a legacy line, so a deployment may add columns, but nothing said what they may hold.
    Redaction holds traced every column of a row to the unit or record the row was written from,
    so a derived column that copies a session's own free text (`sessions.first_prompt`, the text of
    its first user message) failed, though it held nothing the session's records do not hold: the
    session record does not hold its messages' text. *Question:* may a deployment add derived
    columns, and from what may they take their values?

    *Answered (§3 Derived columns, §8 Redaction holds):* a deployment may add derived columns to
    §3 tables. A derived column holds only values taken from its own session's records, never
    another session's, and the redaction rules hold for it; it is recomputed when a record it
    copies is revised, removed or forgotten, and never keeps a value the session's current records
    no longer hold; it never enters a key or a `content_sha`. Redaction holds now traces this
    specification's columns of a row to the unit or record it was written from, as before, and a
    column the deployment adds to the records of the row's session: in the current state, its
    current records. The sentinel scenario gained a second pass that deletes OpenCode's first user
    message, whose text holds a planted value. The controls are the faults `engine:derived-stale`
    (the column keeps a removed message's text) and `engine:derived-other-session` (it takes the
    next session's), and the test engines `derived-column.mjs` (accepted),
    `derived-column-stale.mjs` and `derived-column-copied.mjs` (caught).

30. **A derived column in a row that is history (§2 principles 1 and 3, §3 Derived columns).** §3
    says a derived column "never keeps a value the session's current records no longer hold: not a
    removed message's text". Principle 3 makes a removed version "a full copy of its last row", and
    Removed equals not live checks it column by column, a column the deployment adds included; the
    archive is append-only (principle 1), so a derived column on a unit row is never recomputed. A
    derived column on `session_parts` that copies a part's text (a search column, say) cannot meet
    both readings in a removed version: copied, it keeps the removed message's text; recomputed, it
    is not a copy of the last row. *The kit checks* a column the deployment adds against the
    session's current records in the current state (an entity row, not removed), and against the
    session's records, current or removed, in a removed version, a unit row and the cursor: never
    another session's, never a redacted value. *Question:* is a derived column in a removed version
    (and in the archive) a copy of the row it had, or recomputed from the current records?

    *Answered (§2 principles 1 and 3, §3):* the current state is judged against the session's current
    records; a history row (a removed version, an archive row, the cursor) is a copy by design and is
    judged against the session's records, current or removed. One exception holds for history too:
    forgotten content is held by no row (§2 principle 1). The kit has no forget scenario, so that
    sentence is not checked until an engine honours forget notices (sessions v1.1).

## Edges an engine infers

31. **`stated_on` of an inferred edge (§4.5).** An engine edge's `stated_on` is `child`, `origin`
    or `both`: which side's statement the edge rests on. An edge the engine infers (`evidence =
    'inferred'`, for example a fork nominated from copied content) rests on no statement, so none
    of the three is true. A production engine writes `''` for it today. `''` already reads as
    "unknown" or "the own harness store" elsewhere in the mapping (§4.5's references,
    `other_incarnation`), and here nothing is unknown: the edge has no statement, by construction.
    *Proposed:* a fourth value, `none`, meaning the edge rests on no statement; it occurs exactly
    when `evidence = 'inferred'`, and then the edge's supporting-statement keys are empty. Neither
    profile constrains `stated_on` by a `CHECK`, so the change is text only (§4.5's list and the
    schema comments), additive under v1.x. *Question:* `none`, or `''` documented as "no statement"?

    *Open:* for the next v1.x.


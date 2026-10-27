# Questions for the specification

Points where `01-SESSIONS-SQL-SPEC.md` (v0) is ambiguous, or where a §8 item cannot be checked as
it is written. For each: what the kit or the reference engine does today, so nothing here is
invented silently, and the question the specification should settle. None of them is a plain
error that a check proved; the spec text is unchanged.

## Checks that cannot run as §8 words them

1. **Redaction holds (§8).** "The sentinel-secret fixtures leave no sentinel value in any table."
   All three sentinel fixtures (Goose, Zed, OpenCode) also plant a value in free text, which no
   redaction path covers and which the adapter keeps on purpose (sessions-model §4 rule 6). Read
   literally, no engine can pass. *The kit checks:* no row holds a planted value unless the unit
   or record it was written from holds it, and the values redacted on declared paths are in no
   table. *Question:* should §8 say "no value the adapter redacted", or "no sentinel on a declared
   path"?

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

3. **Legacy content_sha, whole rows (§8).** "The conversion of that row gives that line." The kit
   has no memhouse 0.18 input and cannot run an implementation's conversion. *The kit checks* the
   half the database profile owns: each vector's fields, named by the committed DDL order, loaded
   by name into the deployed table, format back in the deployed DDL order into the line and the
   sha, through §4.8's own expression (the database part: the DDL) and through the engine's own
   legacy SQL (`legacySha`, the engine part). An engine that supplies no legacy SQL has the
   engine parts of both legacy items skipped, never passed on §4.8's expression. *Question:*
   should the engine interface gain a conversion hook (a 0.18-shaped input row in, the converted
   row out), or is the conversion proved by the implementation's own tests?

4. **Legacy content_sha on PostgreSQL (§8, §4.8).** §4.8 computes the sha "where the conversion
   runs" and gives the SQL for ClickHouse only, and a conversion reads a ClickHouse database. *The
   kit reports* both legacy items `n/a` on PostgreSQL. *Question:* are they ClickHouse-only items,
   or should §4.8 give a PostgreSQL rendering of the same line?

5. **Removed equals not live (§8).** "Current keys are exactly that pass's live sets." A key in
   `held` keeps its last written version (sessions §2), so it is current without being in `live`.
   *The kit expects* `live`, plus each held key that was written before. *Question:* should §8 say
   so?

6. **Null is unknown (§8).** No fixture emits a null `input`, `output` or `output_ref_bytes`. *The
   kit covers* those with synthetic rows in the database part only; the engine part covers the
   counters, flags and `exit_code` the fixtures do emit as null. Not a spec question: a note that
   a fixture with those nulls would let an engine prove them.

## Shapes the DDL and the records disagree on

7. **`adapter_ver`.** Both DDL files store an integer (`UInt32`, `integer`); the session adapters
   state a version string (`0.2.0`). *The reference engine* stores `a.b.c` as a·10⁶ + b·10³ + c,
   through one encoder for every table, and refuses a version it cannot encode. *Question:* should
   the column be a string, or should §4 fix the encoding?

8. **`child_stored`.** Both DDL files make it a non-nullable boolean, default true; an
   origin-side statement may carry `child_stored: null` (OpenCode's `task` part). *The reference
   engine* writes the default, which turns "unknown" into "stored". *Question:* `Nullable(Bool)` /
   nullable `boolean`?

9. **`orig_sha256` in ClickHouse.** `FixedString(64) DEFAULT ''` stores 64 zero bytes, not an empty
   value, for a unit with no original sha; PostgreSQL stores null. *Question:* `String`, or
   `Nullable(FixedString(64))`, so the two profiles mean the same thing?

## Semantics the reference engine had to choose

10. **The continuity of a manifest (§4.1).** The manifest's `continuity` lists `appended`, `delta`,
    `reset`, `snapshot`. A no-op read returns `unchanged` (sessions §3), and a vanished source has
    no read at all. *The reference engine* writes `unchanged` for the first and `reset` for the
    second (a vanished source opens a generation). *The kit accepts* those five values in a
    manifest, and checks every other key of §4.1's object (23). *Question:* which values belong
    there?

11. **`progress` (§4.1, §4.6, §7).** A manifest carries "the cursor progress after this read", the
    cursor's `ver` is per source, and `rev` is described from the progress "for the session".
    Replay folds manifests "in progress order". If progress is per source, a replay cannot tell
    which reads of several sources belonged to one pass, and deriving after each read can produce
    removed versions of keys that were live only between two sources' reads, which the live pass
    never wrote ("removed versions included" in §8 would then differ). *The reference engine* uses
    a per-session pass counter, shared by every manifest of one pass, and replays pass by pass.
    *Question:* should §4.1 say that the manifests of one pass share a progress value (or carry a
    pass id)?

12. **A part its message no longer has (§4.3).** "A message-level change revises every part row of
    that message at the new rev", but a revised message can lose a part, and a message that had
    none (its header row, `part_id ''`) can gain one. *The reference engine* writes a removed
    version of the stale part row. *Question:* removed version, or physical deletion (it is not a
    key the adapter's `live` names)?

13. **A vanished source under `"policy": "removed"` (§4.1).** The kit replays it as empty, as §4.1
    says, and derives the session over what is left. Derived over no units, an adapter can still
    list the session record itself (Codex does), so the session's row stays current while its
    messages are removed. *Question:* is that intended, or should "removed" also remove the session
    row?

14. **Edges (§4.5).** *The reference engine* writes an edge only when both ends resolve to exactly
    one held session; writes `other_host` and `other_harness_path` as `''` when the origin is in the
    child's own harness store (the statements' convention); takes `inherits` fields from the
    child-side statement first; and ends an edge with a removed version. *Questions:* is an edge
    with an unresolved end written at all; are its reference columns resolved values or `''`; and
    is an ended edge a removed version or a deletion?

15. **Replaying edges (§4.1, §8 Absences replay).** Replay folds each session alone, and the order
    of passes across sessions is not archived (progress is per session), so a replay rebuilds the
    current edges but not the removed versions of edges that ended. *The kit compares* current
    edges, and current and removed adapter-owned rows. *Question:* is an ended edge's removed
    version history a replay must rebuild?

## The kit's own conventions, which the specification may want to own

16. **The envelope.** §8 says "envelopes" without defining them. *The kit defines* one as one read
    of one source as the seam delivers it, plus the position it was read from (`from`), or a
    consumer's `source_gone` decision with its policy (README). *Question:* should §8, or the
    `sessions` seam, define the unit of input a conforming engine is fed?

17. **The crash points.** §8 kills the pass "between the archive write and the cursor write". The
    kit stops it right after the archive write, and at every later point an engine declares
    (`crashPoints`; the reference: after the archive, the entity writes, the removed versions and
    the edges). It checks each stop instead of trusting it: the pass's units are archived, the
    cursor is as it was (so every declared point must lie before the cursor write), and right
    after the archive write the entity tables are untouched. A cursor is consumer policy (§4.6), so
    the kit reads it through an engine's `cursor()` where it has one, else from session_sources,
    and reports the item not proven when it sees neither change over a clean run.

18. **The session-adapters package before npm.** `SSQL_ADAPTERS` is a path or a package name; a
    published package does not ship `fixtures/`, which the engine checks need. Until the fixtures
    are published on their own, the kit needs a checkout.

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

21. **Chunks (§4.1).** A unit "stored in several chunks" is not specified further: how its raw is
    split, how the chunks are numbered, whether each carries the whole unit's `sha256` and `enc`.
    *The kit reads* the chunks of one `(source, generation, unit_key, sha256)` as one unit: numbered
    0, 1, … with one `enc`, their `raw` joined in chunk order is the unit's body. *The reference
    engine* (option `chunkBytes`) splits a long raw at character boundaries. *Question:* is that the
    layout, and does a manifest list a chunked unit once?

22. **The DDL a database check tests (§3, §8).** §8's database items test "the database profile's
    DDL, under the deployment's physical table names", and §3 lets a deployment's DDL differ from
    `schema/` (a prefix, extra columns, a sort-key prefix). *The kit tests* the DDL the engine makes
    through `createTables`; without it, it loads `schema/` and reports those rows as a self-check of
    `schema/`, outside the engine's verdict. *Question:* should §8 say how an implementation hands
    its DDL to a conformance run (§3's "say so in one place", for example its schema template)?

23. **The manifest's object, strictly (§4.1).** §4.1 lists the keys of a manifest's `raw`, but not
    whether others may be added, nor the type of `progress`. *The kit requires* `progress` (a
    non-negative integer, or its decimal string), `continuity` (10's five values), `units` (a list
    of `[unit_key, sha256]`), `gone`, `source_gone` (a boolean), `policy` only with `source_gone`,
    a row `continuity` equal to the object's, and `sha256` the sha of `raw`; it accepts other keys.
    *Question:* may a manifest carry keys of its own (20's read id would be one)?

24. **A part's own source or state equal to its message's (§4.3).** `part_source` and `part_state`
    hold a part's own values "where they differ from its message's", and `''` "where the part has
    none of its own". A part whose own value equals its message's has one of its own that does not
    differ. *The kit accepts* the value or `''` there. *The reference engine* writes the value. No
    fixture has such a part yet. *Question:* which one?

25. **A merged edge whose `at` came from the statement removed first (§4.5).** A merged edge takes
    `at` from the parent's call, while the child's statement has none; `at` is in the edge's key.
    Removing the parent's statement first leaves a child-only edge at `''`: a new key, so the
    merged edge ends though a supporting statement stands. *The kit checks* that an edge for the
    pair is still current while either statement stands, and removes the child's statement first.
    *Question:* does a merged edge keep its key when the statement that gave it `at` is removed?

26. **The sort-key prefix (§3).** "A consumer may prefix the sort key with columns that never change
    for a key, such as `toDate(ts)` for messages." Which columns never change for a key is not
    listed: sessions-model §1 rule 7 says so of `ts`, and nothing names another. *The kit accepts*,
    in ClickHouse, leading sort-key elements that are `ts` or one function of `ts` alone
    (`toDate(ts)`, `toStartOfHour(ts)`, …), before the identity columns, in any table that has
    `ts`; any other extra element fails Tables and keys (`toDate(ingested_at)` is one of its
    faults: it changes between versions, so they never collapse). A PostgreSQL primary key must be
    the identity exactly. *Question:* is that the allowance, or may a deployment prefix other
    columns, and is it limited to `session_parts`?

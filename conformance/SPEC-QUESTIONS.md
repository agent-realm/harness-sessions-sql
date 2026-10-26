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
   and only gone keys already reported). *Question:* is that the meaning, and should §4.1 also let
   an engine omit the manifest of a read that changes nothing in the fold (not only one that
   delivers nothing)?

3. **Legacy content_sha, whole rows (§8).** "The conversion of that row gives that line." The kit
   has no memhouse 0.18 input and cannot run an implementation's conversion. *The kit checks* the
   half the database profile owns: each vector's fields, named by the committed DDL order, loaded
   by name into the deployed table, format back in the deployed DDL order into the line and the
   sha. *Question:* should the engine interface gain a conversion hook (a 0.18-shaped input row in,
   the converted row out), or is the conversion proved by the implementation's own tests?

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
   state a version string (`0.2.0`). *The reference engine* stores `a.b.c` as a·10⁶ + b·10³ + c.
   *Question:* should the column be a string, or should §4 fix the encoding?

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
    second (a vanished source opens a generation). *Question:* which values belong there?

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
    the edges).

18. **The session-adapters package before npm.** `SSQL_ADAPTERS` is a path or a package name; a
    published package does not ship `fixtures/`, which the engine checks need. Until the fixtures
    are published on their own, the kit needs a checkout.

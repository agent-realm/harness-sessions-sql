# Conformance (v0, not yet runnable)

These are the checks of `01-SESSIONS-SQL-SPEC.md` §8, as they will run.
- **Database:** one disposable deployment per database profile (ClickHouse, PostgreSQL), with the
  target taken from the environment.
- **Input:** the fixtures of the session-adapters package (`packages/session-adapters` in [agent-realm/harness-skeleton](https://github.com/agent-realm/harness-skeleton), package name `@agent-realm/session-adapters`) (`fixtures/<harness>/<case>/`), turned into sessions-model
  envelopes by its adapters or by a fixture loader.

| Check | Input | Pass when |
|---|---|---|
| Tables and keys | the database profile's DDL | every table and key of §3 exists (`session_sources` is informative); an entity row is `DELETE`d only as a true duplicate, a key an upgraded adapter no longer produces, or a tombstoning consumer's tombstone |
| Twice is once | the same envelopes ingested twice | no duplicate logical rows in any table |
| Crash-safe | the pass killed between the archive write and the cursor write, then re-run | row counts and current state are equal |
| Removed equals not live | a session before and after a rewind (an OpenCode revert, a Copilot rewind, the Gemini `$rewindTo` fixture) | current keys (not deleted, not removed) equal that pass's `live` sets; each key that left `live` has a `removed = 1` version, keeping its `state` (or a tombstone, for a tombstoning consumer), that no total counts; an append-only retraction stays current with `state = 'retracted'` |
| Edges outlive statements | the OpenCode child/task pair | re-deriving the child alone keeps the merged edge; removing both statements ends it |
| Absences replay | a still-listed source reset to empty; a vanished source with `"policy": "kept"`; a vanished source with `"policy": "removed"`; a delta read with `gone` keys; each then replayed from `session_units` alone | the live pass's current state in each case, removed versions included (kept: the last generation stays current; removed and empty reset: nothing current) |
| No-op manifests | the same passes with and without the manifests of reads that opened no generation and delivered nothing | equal replayed current state |
| Host form | a row keyed by a hostname (`my-laptop`), its `adapter` not `legacy` | rejected by both database profiles |
| Service-held host | a row keyed by `s-b8fdcc6d6c24b3fd5ad7e508e6143416` (claude.ai, sessions-model v1.3's known answer) with `harness_path` `https://claude.ai` | accepted by both database profiles |
| Two hosts, two sessions | one harness store's units under two `host` values | two sessions with the same `session_id` and different session keys |
| Re-derive from the archive | `session_units` alone, with a bumped `adapter_ver` | higher `rev`s; only keys the new version no longer produces are physically deleted |
| Null is unknown | usage with null counters | nulls stay null |
| Redaction holds | the Goose sentinel fixture (`fixtures/goose/conformance-goose-sentinel/` in the session-adapters package, `packages/session-adapters` of agent-realm/harness-skeleton) | no sentinel value in any table |
| Database profile parity | the same envelopes into both database profiles | equal sets of `(key, content_sha)` in current state |

**Engine-owned:** the cursor table and the derivation of `rev` (spec §7) belong to each engine.
The crash-safe check uses the engine's own cursor.

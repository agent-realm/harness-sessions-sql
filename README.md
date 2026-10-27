# harness-sessions-sql

**Status: v1.** The spec and both database profiles' DDL are written, and the DDL loads in both engines. The conformance kit runs the spec's checks; its reference engine passes them on both database profiles. memhouse, the first production implementation, has run it and does not pass every item yet.

## What it is

harness-sessions-sql is the reference for keeping agent-harness sessions in a database. It defines:
- which tables hold the records of **sessions-model v1**;
- the keys of those tables;
- how revisions and deletions are kept;
- how captured raw data stays apart from the tables derived from it.

The model lives in [sessions-model][sessions-model].
ClickHouse is the normative database profile. Postgres is a second database profile over the same logical tables.

## Why it exists

Every agent harness keeps its sessions in its own format. harness-sessions-sql was started on 2026-10-22
for two needs:
- a harness's state and history must stay easy to extract, for memhouse first but not only;
- there must be a reference for mapping session data into a database.

One model can have several mappings, and a mapping changes at its own pace. So the mapping is a
standard of its own, beside two others:
- **sessions-model** says what the records are;
- **sessions** says how an adapter reads a harness store.

## Where it fits

- **Reads** the records that session adapters produce through the [`sessions`][sessions] v1 seam.
  harness-skeleton's `sessions.read` is one such producer.
- **First implementation:** memhouse's capture engine. The standard is extracted from it once it
  works: written down from a working implementation, not designed ahead of one.
- **ClickHouse profile:** common conventions, namely ReplacingMergeTree versioned by `rev` with an
  `is_deleted` flag, `DateTime64` in UTC, and a server-stamped `writer` column.

## Start here

1. **The standard:** [`01-SESSIONS-SQL-SPEC.md`](01-SESSIONS-SQL-SPEC.md): tables, keys, revisions and tombstones, writing and reading, the open points, conformance.
2. **The tutorial:** [From an empty database to a conforming store](docs/tutorials/from-empty-database-to-conforming-store.md): one path through the examples, from loading the DDL to the conformance kit's verdict.
3. **The DDL:** [`schema/clickhouse.sql`](schema/clickhouse.sql) (the normative database profile) and [`schema/postgres.sql`](schema/postgres.sql).
4. **The examples:** [`examples/README.md`](examples/README.md): five runnable examples, from one session written by hand in SQL to the reference engine checked by the conformance kit.
5. **Conformance:** [`conformance/README.md`](conformance/README.md): the checks, and how to run them against a ClickHouse or PostgreSQL target taken from the environment.

## Where next

- [`examples/`](examples/README.md): run them all with `npm test` in `examples/`, against a disposable target.
- [`docs/`](docs/README.md): the documentation index, with the guides: running the kit against your engine, reading the current state, adding a column.
- [`AGENTS.md`](AGENTS.md): conventions for agents and humans working on this repo, and how to install and deploy.
- [`CHANGELOG.md`](CHANGELOG.md): what each version holds.

## License

Apache License 2.0: see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).

[sessions-model]: https://github.com/agent-realm/sessions-model/blob/main/contracts/sessions-model.md
[sessions]: https://github.com/agent-realm/sessions-model/blob/main/contracts/sessions.md

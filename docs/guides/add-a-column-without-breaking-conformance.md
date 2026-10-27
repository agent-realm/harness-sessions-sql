# Add a column without breaking conformance

A deployment's tables need not be exactly [`schema/`](../../schema/)'s. This page says what
[§3][s3] lets a deployment change, what the conformance kit accepts, what breaks conformance, and
shows a `tenant` column added on both profiles with the kit staying green.

## What a deployment may add

All of it is in [§3 Keys and versioning][s3]:

- **Physical names.** A prefix on every table name (one per tenant of a shared database, say), and
  `session_units` in a database of its own. The deployment says so in one place, such as its
  schema template.
- **A sort-key prefix (ClickHouse).** An `ORDER BY` holds a table's identity columns as a set, in
  the deployment's order, and may begin with columns that never change for a key, such as
  `toDate(ts)` for messages. A Nullable column there needs `SETTINGS allow_nullable_key = 1`.
- **Tables of its own** beside the §3 tables, such as a table of tool calls derived from
  `session_parts`.
- **Derived columns**, under §3's rules: values from the session's own current records only,
  recomputed when a record they copy changes, never in a key or a `content_sha`.
- **Columns of its own.** [§4.8][s48] leaves "any column a deployment adds" out of a legacy row's
  line, and the kit's test engine for such a column adds `tenant`.

## What the kit accepts

The kit checks your engine's own DDL, the tables its `createTables` makes
([Run the conformance kit against your engine](run-the-conformance-kit-against-your-engine.md)).
Its test engines in [`conformance/test/engines/`](../../conformance/test/engines/) cover each case:

| Addition | Kit check | Test engine |
|---|---|---|
| `toDate(ts)` before a ClickHouse sort key | 1, Tables and keys: `ts`, or one function of `ts`, before the identity columns; nothing else | `sort-key-prefix.mjs` |
| a column of the deployment's, with a default | 12, Legacy content_sha, whole rows: the column is left out of the line, and named in the notes | `added-column.mjs` |
| a table of the deployment's own | 9, No time partition: the table is left alone | `extra-table.mjs` |
| a derived column | 18, Redaction holds: the column is judged against the records of its row's session | `derived-column.mjs` |

A column the deployment adds needs a default, or the kit's own synthetic rows are refused
([conformance/README.md, Plugging in an engine][plug]).

## What breaks conformance

- **A key that is not the identity.** An extra column in an `ORDER BY` or a primary key (other than
  the `ts` prefix above), or a missing one, fails Tables and keys.
- **A `content_sha` with other inputs.** A record's `content_sha` is the sha256 of its canonical
  JSON ([§4][s4]); a column of the deployment's, derived or not, never enters it. A row whose shas
  are not those of its record fails Removed equals not live and Units only.
- **A derived column in a key**, which §3 rules out.
- **A derived column that keeps what its session no longer holds**, such as a removed message's
  text, or takes another session's values: Redaction holds fails (`derived-column-stale.mjs`,
  `derived-column-copied.mjs`).

## Worked: a `tenant` column on both profiles

The column, on `sessions` and `session_parts`, in each profile's SQL:

```sql
-- ClickHouse
ALTER TABLE sessions ADD COLUMN tenant String DEFAULT '';
ALTER TABLE session_parts ADD COLUMN tenant String DEFAULT '';
-- PostgreSQL
ALTER TABLE sessions ADD COLUMN tenant text NOT NULL DEFAULT '';
ALTER TABLE session_parts ADD COLUMN tenant text NOT NULL DEFAULT '';
```

The kit checks the DDL an engine makes, so the statements go into an engine's `createTables`. This
module wraps the reference engine, makes `schema/`'s tables, and adds the column under the physical
names the kit gives it. Save it as `tenant-engine.mjs` at the repository root:

```js
// The reference engine, with a `tenant` column added to sessions and session_parts.
import * as reference from './conformance/reference/engine.mjs';

export const { name, version, createEngine } = reference;

export async function createTables(options) {
  await reference.createTables(options);
  const column = options.profile === 'clickhouse' ? "tenant String DEFAULT ''" : "tenant text NOT NULL DEFAULT ''";
  for (const table of ['sessions', 'session_parts']) {
    await options.ns.exec(`ALTER TABLE ${options.tables[table]} ADD COLUMN ${column}`);
  }
}
```

Then run the kit on both profiles, with the targets and `SSQL_ADAPTERS` set as for
[example 05](../../examples/05-full-blown/):

```sh
SSQL_ENGINE=./tenant-engine.mjs node conformance/run.mjs --verbose
```

Look for `ddl: the engine's own (createTables)`, every row `pass` or `n/a`, and in Legacy
content_sha, whole rows (ClickHouse) the note `columns the deployment adds, left out of the line
(§4.8): session_parts.tenant, sessions.tenant`. The verdict is `exit 0`. The kit's own test engine
for this case, [`added-column.mjs`](../../conformance/test/engines/added-column.mjs), adds the same
column in the DDL text instead of by `ALTER`.

[s3]: ../../01-SESSIONS-SQL-SPEC.md#3-keys-and-versioning
[s4]: ../../01-SESSIONS-SQL-SPEC.md#4-schema
[s48]: ../../01-SESSIONS-SQL-SPEC.md#48-rows-no-adapter-derived-legacy-memhouse-bridge-memhouse-log
[plug]: ../../conformance/README.md#plugging-in-an-engine

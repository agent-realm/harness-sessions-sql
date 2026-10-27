# Add a column without breaking conformance

A deployment may add to [`schema/`](../../schema/)'s tables. This page lists what it may add and
where the specification says so, what it may leave out, what the conformance kit accepts, and what
breaks conformance, and shows a `tenant` column added on both profiles with the kit staying green.

## What a deployment may add

- **Physical names** ([§3][s3]). A prefix on every table name (one per tenant of a shared database,
  say), and `session_units` in a database of its own. The deployment says so in one place, such as
  its schema template.
- **A sort-key prefix, in ClickHouse** ([§3][s3]). An `ORDER BY` holds a table's identity columns
  as a set, in the deployment's order, and may begin with columns that never change for a key,
  such as `toDate(ts)` for messages; a Nullable column there needs
  `SETTINGS allow_nullable_key = 1`. Which columns qualify is still open
  ([SPEC-QUESTIONS.md, question 26][q26]).
- **Tables of its own** beside the §3 tables, such as a table of tool calls derived from
  `session_parts` ([§3][s3]).
- **Derived columns**, under [§3][s3]'s rules: values from the session's own current records only,
  recomputed when a record they copy changes, never in a key or a `content_sha`.
- **Columns of its own**, such as a tenant or a consumer's first-seen time. The specification
  expects them ([§4.8][s48] leaves "any column a deployment adds" out of a legacy row's line, and
  §3 keeps a first-seen time "in a column of its own"), but §3's rules are written for derived
  columns only, so what such a column may hold is an open question
  ([SPEC-QUESTIONS.md, question 35][q35]). The kit judges it as it judges a derived column, and the
  worked `tenant` column below rests on that reading.

## What a deployment may leave out

- **`writer`**, where the deployment does not use per-principal writes ([§2][s2], principle 5).
- **`session_sources`**, the informative cursor table ([§4.6][s46]; §8's first item lets it be
  absent). Some of the kit's checks still read or write it ([SPEC-QUESTIONS.md, question 27][q27]).

## What the kit accepts

The kit checks your engine's own DDL, the tables its `createTables` makes
([Run the conformance kit against your engine](run-the-conformance-kit-against-your-engine.md)).
Its test engines in [`conformance/test/engines/`](../../conformance/test/engines/) cover each case:

| Addition | Kit check | Test engine |
|---|---|---|
| `toDate(ts)` before a ClickHouse sort key | 1, Tables and keys: `ts`, or one function of `ts`, before the identity columns, and nothing else; the kit's reading of an open question ([26][q26]) | `sort-key-prefix.mjs` |
| a column of the deployment's, with a default | 12, Legacy content_sha, whole rows: the column is left out of the line, and named in the notes | `added-column.mjs` |
| a table of the deployment's own | 9, No time partition: the table is left alone | `extra-table.mjs` |
| a derived column | 18, Redaction holds: the column is judged against the records of its row's session | `derived-column.mjs` |

A column the deployment adds needs a default, or the kit's own synthetic rows are refused
([conformance/README.md, Plugging in an engine][plug]).

## What breaks conformance

- **A key that is not the identity.** A missing identity column, or an extra one in a primary key,
  fails Tables and keys. In a ClickHouse `ORDER BY`, the kit accepts `ts` or one function of `ts`
  before the identity columns and fails any other extra element: its reading of §3, while
  [question 26][q26] is open.
- **A `content_sha` with other inputs.** A record's `content_sha` is the sha256 of its canonical
  JSON ([§4][s4]); a column of the deployment's, derived or not, never enters it. A row whose shas
  are not those of its record fails Removed equals not live and Units only.
- **A derived column in a key**, which §3 rules out.
- **A derived column that keeps what its session no longer holds**, such as a removed message's
  text, or takes another session's values: Redaction holds fails (`derived-column-stale.mjs`,
  `derived-column-copied.mjs`).
- **The specification's columns in another order (ClickHouse).** The kit formats a legacy row's
  line in the deployed table's own column order, so a table whose specification columns are
  reordered fails Legacy content_sha, whole rows. §4.8 and §8 word the line in this
  specification's DDL order, so this is the kit's reading, left open as
  [question 36][q36]: keep `schema/`'s column order, adding columns where you like.

For more, every change the kit's self-test makes to the reference engine or to `schema/`, listed
in [`conformance/reference/faults.mjs`](../../conformance/reference/faults.mjs), breaks a check of
the kit: each check names the faults it must catch, and fails against each of them.

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
[s2]: ../../01-SESSIONS-SQL-SPEC.md#2-core-principles
[s46]: ../../01-SESSIONS-SQL-SPEC.md#46-session_sources-informative
[q26]: ../../conformance/SPEC-QUESTIONS.md#more-points-the-kit-had-to-settle
[q27]: ../../conformance/SPEC-QUESTIONS.md#more-points-the-kit-had-to-settle
[q35]: ../../conformance/SPEC-QUESTIONS.md#columns-a-deployment-adds-beyond-derived-ones
[q36]: ../../conformance/SPEC-QUESTIONS.md#legacy-lines

# Working on sessions-sql

Conventions for any coding agent (Claude Code, Codex, OpenCode, pi, Gemini, …) and any human
working on this repo.

## What this repo is

- **sessions-sql**: the reference for keeping agent-harness sessions in a database. It maps the
  records of sessions-model v1 to tables, keys, revisions and deletions.
- **Database profiles**: ClickHouse (normative) and Postgres, over the same logical tables. Both are
  drafted in `schema/`.
- **A conformance kit** (`conformance/`) that proves an implementation of the mapping, run against
  a ClickHouse or PostgreSQL target taken from the environment.
- **Examples** (`examples/`): five runnable examples, from one session written by hand in SQL to
  the reference engine checked by the kit, each README holding the output it prints.

**Status: v1**; begun 2026-10-22.

## The dependency rule

```
session adapters ──produce──▶ sessions-model records ──mapped by──▶ sessions-sql ◀──implement── stores (memhouse, …)
```

- sessions-sql depends on sessions-model and the `sessions` seam, cited by version. It never
  copies their text.
- It never depends on one implementation's internals. memhouse is the first implementation, not
  the definition.

## Rules

1. **One home for the text.** The mapping's text, DDL and tests live only here. Other
   repositories may summarise it and use its terms, never copy it.
2. **Empirical first.** Every table and key is backed by a working implementation or a fixture
   before it is called normative.
3. **Raw stays apart from derived.** Captured raw units are the truth for every derived table.
   A model or mapping change re-derives from them and loses nothing.
4. **Secrets by reference only.** Redaction belongs to the adapter (sessions-model §4). The
   mapping never adds a column that would hold a value the model redacts. Never print, log or
   commit a secret value.
5. **The spec comes first.** A change in behaviour changes the spec in the same PR. While the
   mapping is `v0` its shape may change; from `v1`, changes within a major are additive only.

## Git

- Work on a branch; an agent names it `<agent>/<description>` (`claude/…`, `codex/…`). A git
  worktree per branch, outside the checkout, keeps parallel work apart.
- Never commit to `main`: every change reaches it by pull request. Keep the primary checkout on
  `main`, clean.
- Delete merged branches with `git branch -d`, never `-D`.
- Review: every pull request is reviewed before it merges. Answer each review finding on its own
  thread, naming the commit that resolves it.

## Testing

- **The guard:** this repo is public, and a pushed branch is already published. Run
  `node scripts/guard.mjs --commits origin/main..HEAD` before you push; it must print
  `guard: clean`. CI (`.github/workflows/guard.yml`, check `guard`) runs it on every pull request
  and on every push to `main`.
  - It checks the tracked files' paths and lines, and each commit's author and committer names,
    message, every path it touches and every line it adds, for private detail: credential shapes,
    home paths with a user name (outside web URLs), private IP addresses, e-mail addresses other
    than noreply and reserved-name ones, machine numbers, and process wording. It prints file and
    line, or commit, never the matched text.
  - A false positive goes into the guard's `ALLOW` list (a line pattern, optionally limited to one
    path), in a pull request of its own: CI runs the base branch's copy of the guard. Never reword
    correct text, and never change a known-answer vector, to pass it.
  - The maintainer also runs it with `--names <file>`, a local list of names that never enters the
    repository in any form.
  - `node scripts/guard.mjs --self-test` runs the guard's own cases. Add a case with every fix to a
    check.
  - A push to `main` scans only the commits it brings. **Whenever the guard's rules tighten**, run
    it over the whole history once: `node scripts/guard.mjs --commits HEAD` locally, or the
    workflow by hand (Actions, guard, Run workflow). A hit in old history is reported to the
    maintainer; history is never rewritten to clear it.
- Tests that need a database take their target from the environment, so the same suite runs
  against any disposable ClickHouse or PostgreSQL deployment.
- **The examples:** `npm test` in `examples/` runs every example against those targets and checks
  its output against the expected output in its README (`examples/README.md`).
- Use throwaway containers only with `docker rm -f -v`.

## Installing and deploying

sessions-sql is a standard, not a service: deploying it means making its tables in a database and
checking the engine that writes them. The steps, with
[the tutorial](docs/tutorials/from-empty-database-to-conforming-store.md) and
[`conformance/README.md`](conformance/README.md) as the reference:

1. **The tables.** Load `schema/clickhouse.sql` or `schema/postgres.sql` into the deployment's
   database, each table under the deployment's prefix where it has one (spec §3, physical table
   names).
2. **A disposable pair, for tests.** `conformance/compose.yml` starts a ClickHouse and a PostgreSQL
   on `127.0.0.1`: `export SSQL_KIT_PASSWORD=…` (`…` is a placeholder for a password of your
   own), then `docker compose up -d` in `conformance/`; exported, the variable reaches every later
   `docker compose` call. Wait until both answer before anything runs against them; the tutorial's
   first step gives a bounded check for each.
3. **The variables.** `SSQL_CH_URL`, `SSQL_CH_USER` and `SSQL_CH_PASSWORD`, and/or `SSQL_PG_URL`,
   for the targets; `SSQL_ADAPTERS` for the session-adapters package (a checkout, for its
   fixtures); `SSQL_ENGINE`, `SSQL_PREFIX` and `SSQL_TIMEOUT_MS` to adjust a kit run
   (`conformance/README.md`, What it needs).
4. **Dependencies.** `npm ci` in `conformance/`. `examples/` has none of its own: it uses the kit's.
5. **Run.** `node conformance/run.mjs` checks an engine (the reference engine by default), and
   `npm test` in `conformance/` runs the kit's own tests; `npm test` in `examples/` runs the
   examples.
6. **Before every push**, the guard (Testing, above).

## Contract links

The links to sessions-model and sessions share one base, `https://github.com/agent-realm/sessions-model/blob/main/contracts/`,
defined once at the bottom of each file that uses them (README.md, 01-SESSIONS-SQL-SPEC.md,
examples/03-records-to-rows/README.md). To
move them to another repository name or pin a commit or tag, replace that base everywhere:

```sh
grep -rl 'agent-realm/sessions-model/blob/main/contracts' . | xargs sed -i.bak 's#agent-realm/sessions-model/blob/main/contracts#<repo>/blob/<ref>/contracts#' && find . -name '*.bak' -delete
```

## Where to report

Open an issue on this repo.

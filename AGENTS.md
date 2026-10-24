# Working on sessions-sql

Conventions for any coding agent (Claude Code, Codex, OpenCode, pi, Gemini, …) and any human
working on this repo.

## What this repo is

- **sessions-sql**: the reference for keeping agent-harness sessions in a database. It maps the
  records of sessions-model v1 to tables, keys, revisions and deletions.
- **Database profiles**: ClickHouse (normative) and Postgres, over the same logical tables. Both are
  drafted in `schema/`.
- **A conformance suite** that proves an implementation of the mapping. It is not written yet.

**Status: v0 draft,** begun 2026-10-22.

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

- Tests that need a database take their target from the environment, so the same suite runs
  against any disposable ClickHouse or PostgreSQL deployment.
- Use throwaway containers only with `docker rm -f -v`.

## Contract links

The links to sessions-model and sessions share one base, `https://github.com/agent-realm/sessions-model/blob/main/contracts/`,
defined once at the bottom of each file that uses them (README.md, 01-SESSIONS-SQL-SPEC.md). To
move them to another repository name or pin a commit or tag, replace that base everywhere:

```sh
grep -rl 'agent-realm/sessions-model/blob/main/contracts' . | xargs sed -i.bak 's#agent-realm/sessions-model/blob/main/contracts#<repo>/blob/<ref>/contracts#' && find . -name '*.bak' -delete
```

## Where to report

Open an issue on this repo.

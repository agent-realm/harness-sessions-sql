# Documentation

One line per page. The layout: `tutorials/`
(learning, in order), `guides/` (one task per page), `reference/` (complete and dry), plus
`design/` for design notes.

Tutorials:
- [From an empty database to a conforming store](tutorials/from-empty-database-to-conforming-store.md): one path through the examples, from loading the DDL to the conformance kit's verdict.

Guides:
- [Run the conformance kit against your engine](guides/run-the-conformance-kit-against-your-engine.md): what an engine module exports, the variables, and how to read the verdict.
- [Read the current state](guides/read-the-current-state.md): `FINAL`, `argMax` with the filter in `HAVING`, PostgreSQL, and why other reads come and go.
- [Add a column without breaking conformance](guides/add-a-column-without-breaking-conformance.md): what a deployment may add, what the kit accepts, and a `tenant` column with the kit green.

No pages yet in `reference/` or `design/`.

Elsewhere in the repository:
- [`examples/`](../examples/README.md): five runnable examples, in order, from one session written by hand in SQL to the reference engine checked by the conformance kit; each says what it shows, the spec sections it illustrates, and the output it prints.

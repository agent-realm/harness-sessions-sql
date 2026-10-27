// A test engine with no DDL of its own (no createTables) whose legacy SQL is wrong: it keeps
// formatRow's trailing newline (the reference's fault sql-tsv-no-trim). Its database rows are a
// self-check of schema/, but the legacy SQL is its own, so Legacy content_sha, whole rows must fail
// it, inside its verdict.
import * as reference from '../../reference/engine.mjs';

export const { name, version } = reference;
export const createEngine = (opts) => reference.createEngine({ ...opts, faults: [...(opts.faults ?? []), 'sql-tsv-no-trim'] });

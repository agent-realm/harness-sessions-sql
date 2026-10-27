// A test engine whose own DDL adds a derived column (spec §3) to sessions: `first_prompt`, the text
// of the session's first user message. The reference engine with its `firstPrompt` option, which
// computes the column from the session's current rows after every pass and writes a new version of
// the row where it changed. Its values are the session's own, current free text, so Redaction holds
// must pass. `variant` makes the other test engines: one whose column keeps the first value it
// computed (a removed message's text stays), and one that takes it from another session.
import * as reference from '../../reference/engine.mjs';
import { loadSchema } from '../../lib/db.mjs';

export function variant(firstPrompt) {
  return {
    name: `reference engine with a derived column (first_prompt: ${firstPrompt})`,
    version: reference.version,
    createTables: (opts) => loadSchema(opts.ns, { transforms: [reference.addFirstPromptColumn] }),
    createEngine: (opts) => reference.createEngine({ ...opts, firstPrompt }),
  };
}

export const { name, version, createTables, createEngine } = variant('current');

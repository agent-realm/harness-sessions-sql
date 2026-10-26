// A test engine that supplies no DDL: the reference engine's writer without its createTables.
// The kit then makes every namespace from this repository's schema/, and reports the database
// parts as a self-check of schema/, outside this engine's verdict.
export { createEngine, name, version } from '../../reference/engine.mjs';

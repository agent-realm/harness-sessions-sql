// A test engine that supplies no legacy SQL: the reference engine without its legacySha. The
// two legacy content_sha checks must be skipped for it, never passed on §4.8's own expression.
import * as reference from '../../reference/engine.mjs';

export const { name, version, createTables } = reference;
export function createEngine(opts) {
  const engine = reference.createEngine(opts);
  engine.legacySha = undefined;
  return engine;
}

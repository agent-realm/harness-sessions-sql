// A test engine whose pass throws with a connection URL of its own in the message, holding a
// password the kit was never given (an archive kept in a store of its own, §3 "Mixed"). The kit
// cannot know that password, so its URL net must cut the user info out whole, up to the last `@` of
// the URL, and print no part of the password.
import * as reference from '../../reference/engine.mjs';

export const { name, version, createTables } = reference;
export const PASSWORD = 'p@ssW0rdX';
const url = `postgres://fake-archive:${PASSWORD}@archive.invalid:5432/sessions`;

export function createEngine(opts) {
  const engine = reference.createEngine(opts);
  engine.pass = async () => {
    throw new Error(`the archive at ${url} refused the write`);
  };
  return engine;
}

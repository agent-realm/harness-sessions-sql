// A test engine whose derived column `sessions.first_prompt` (derived-column.mjs) is taken from
// another session's records: the next session's first prompt, sessions in key order. Redaction
// holds must fail (spec §3: a derived column holds only its own session's values).
import { variant } from './derived-column.mjs';

export const { name, version, createTables, createEngine } = variant('other-session');

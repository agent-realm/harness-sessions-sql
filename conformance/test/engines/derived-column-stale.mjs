// A test engine whose derived column `sessions.first_prompt` (derived-column.mjs) keeps the first
// value it computed for each session: after the session's first user message is removed, the
// column still holds its text, which no current record of the session holds. Redaction holds must
// fail (spec §3: a derived column follows its sources).
import { variant } from './derived-column.mjs';

export const { name, version, createTables, createEngine } = variant('stale');

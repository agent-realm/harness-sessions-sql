// A test engine that keeps every vanished source (vanish-kept-only.mjs) but declares no vanish
// policies: the kit checks it against both, so a missing declaration never skips a check, and its
// "removed" part fails.
import { variant } from './vanish-kept-only.mjs';

export const { name, version, createTables, createEngine } = variant({ declare: false });

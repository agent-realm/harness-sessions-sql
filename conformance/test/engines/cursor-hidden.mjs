// A test engine that keeps its cursor in a table of its own (cursor-own-table.mjs), exposes no
// cursor(), and ignores every crash point after the archive write though it declares them. The kit
// cannot see its cursor, so Crash-safe must report the stops not proven, never pass.
import { variant } from './cursor-own-table.mjs';

export const { name, version, createTables, createEngine } = variant({ exposeCursor: false, honourStops: false });

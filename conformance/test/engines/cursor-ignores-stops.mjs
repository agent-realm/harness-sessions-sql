// A test engine that keeps its cursor in a table of its own and exposes it as cursor()
// (cursor-own-table.mjs), but ignores every crash point after the archive write though it declares
// them. Crash-safe must fail it: each ignored stop moves the cursor.
import { variant } from './cursor-own-table.mjs';

export const { name, version, createTables, createEngine } = variant({ honourStops: false });

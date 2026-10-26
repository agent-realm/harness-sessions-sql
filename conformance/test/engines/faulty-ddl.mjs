// A test engine whose own DDL, supplied through createTables, has no host form check (the DDL
// fault `no-host-check`). The kit must test that DDL, not schema/, and fail Host form.
import { createTables as referenceTables } from '../../reference/engine.mjs';

export { createEngine, name, version } from '../../reference/engine.mjs';
export const createTables = (opts) => referenceTables({ ...opts, faults: [...(opts.faults ?? []), 'no-host-check'] });

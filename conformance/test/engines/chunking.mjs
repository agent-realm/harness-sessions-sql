// A test engine that stores every unit longer than 256 bytes in several chunks (§4.1 `chunk`):
// the reference engine with its `chunkBytes` option. A conforming way to archive, which the kit
// must accept: it puts a unit's chunks back together before it compares the unit.
import * as reference from '../../reference/engine.mjs';

export const { name, version, createTables } = reference;
export const createEngine = (opts) => reference.createEngine({ ...opts, chunkBytes: 256 });

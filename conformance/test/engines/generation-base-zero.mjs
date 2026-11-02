// A test engine that numbers each source's generations from 0 (the reference engine's
// `firstGeneration` option). Only their order is significant (sessions v1.4.4, spec §4.1), so the
// kit must accept it: Units resolve, Units only and Absences replay pass. `variant` also makes the
// same engine with every units triple one generation ahead (fault `units-shifted`), which names a
// generation its units are not in, so Units resolve must fail it.
import * as reference from '../../reference/engine.mjs';

export function variant({ shifted }) {
  return {
    name: `reference engine that numbers generations from 0${shifted ? ', its units triples one generation ahead' : ''}`,
    version: reference.version,
    createTables: reference.createTables,
    createEngine(opts) {
      return reference.createEngine({ ...opts, firstGeneration: 0, faults: [...(opts.faults ?? []), ...(shifted ? ['units-shifted'] : [])] });
    },
  };
}

export const { name, version, createTables, createEngine } = variant({ shifted: false });

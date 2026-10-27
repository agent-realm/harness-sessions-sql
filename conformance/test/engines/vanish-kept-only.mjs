// A test engine that implements one vanish policy (§4.1): it keeps every vanished source, whatever
// policy the consumer's decision names, and declares `vanishPolicies: ['kept']`. A consumer that
// only ever keeps conforms if it keeps correctly (§8), so Absences replay must pass, with its
// "removed" and "policy changed" parts n/a. `variant` makes the other test engine: the same
// behaviour with no declaration, which the kit checks against both policies, so "removed" fails.
import * as reference from '../../reference/engine.mjs';

export function variant({ declare }) {
  return {
    name: `reference engine that only keeps vanished sources (${declare ? "declares ['kept']" : 'declares nothing'})`,
    version: reference.version,
    createTables: reference.createTables,
    createEngine(opts) {
      const engine = reference.createEngine(opts);
      const pass = engine.pass.bind(engine);
      engine.pass = (envelopes, o) => pass(envelopes.map((e) => (e.source_gone ? { ...e, policy: 'kept' } : e)), o);
      if (declare) engine.vanishPolicies = ['kept'];
      else delete engine.vanishPolicies;
      return engine;
    },
  };
}

export const { name, version, createTables, createEngine } = variant({ declare: true });

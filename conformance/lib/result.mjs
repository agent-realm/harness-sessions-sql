// A check's result: pass, fail (with what failed), skipped (cannot run here, with why) or n/a (does
// not apply to this profile, with why). `notes` say what the check covered.

export const pass = (notes = []) => ({ status: 'pass', details: [], notes: [].concat(notes) });
export const fail = (details, notes = []) => ({ status: 'fail', details: [].concat(details), notes: [].concat(notes) });
export const skip = (reason) => ({ status: 'skipped', details: [], notes: [reason] });
export const na = (reason) => ({ status: 'n/a', details: [], notes: [reason] });
export const verdict = (problems, notes = []) => (problems.length ? fail(problems.slice(0, 20).concat(problems.length > 20 ? [`… and ${problems.length - 20} more`] : []), notes) : pass(notes));

// An engine call that threw: the check fails, with the engine's message.
export class EngineError extends Error {}

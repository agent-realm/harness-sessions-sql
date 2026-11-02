// A test engine that numbers generations from 0 (generation-base-zero.mjs) and writes every units
// triple one generation ahead of its unit: a starting number the kit accepts does not excuse a
// triple that names the wrong generation, so Units resolve fails.
import { variant } from './generation-base-zero.mjs';

export const { name, version, createTables, createEngine } = variant({ shifted: true });

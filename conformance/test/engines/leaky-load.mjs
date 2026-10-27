// A test engine that fails to load, its error quoting a connection URL of its own with a password
// the kit was never given (see leaky-errors.mjs). The kit reports it once, as a kit error, and must
// print no part of the password.
import { PASSWORD } from './leaky-errors.mjs';

throw new Error(`could not reach the archive at postgres://fake-archive:${PASSWORD}@archive.invalid:5432/sessions`);

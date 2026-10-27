// RFC 8785 (JCS) canonical JSON and sha256, as sessions-model §2 hashes records with them.
// Strings and numbers serialise as ECMAScript's JSON.stringify does, which is what JCS specifies;
// object keys sort by UTF-16 code units, which is what Array.prototype.sort does by default. An
// `undefined` member is left out, as JSON.stringify would; a non-finite number is refused.

import { createHash } from 'node:crypto';

export function jcs(value) {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
    case 'string':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError(`JCS: non-finite number ${value}`);
      return JSON.stringify(value);
    case 'object':
      if (Array.isArray(value)) return '[' + value.map((v) => (v === undefined ? 'null' : jcs(v))).join(',') + ']';
      return '{' + Object.keys(value)
        .filter((k) => value[k] !== undefined)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + jcs(value[k]))
        .join(',') + '}';
    default:
      throw new TypeError(`JCS: cannot serialise ${typeof value}`);
  }
}

export function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

export function jcsSha(value) {
  return sha256(Buffer.from(jcs(value), 'utf8'));
}

// The host/v0 value of a machine id (sessions-model §1): the first 32 lowercase hex digits of
// sha256("sessions-model/host/v0:" + id). The kit only ever passes synthetic ids.
export function hostOf(machineId) {
  return sha256(Buffer.from(`sessions-model/host/v0:${machineId}`, 'utf8')).slice(0, 32);
}

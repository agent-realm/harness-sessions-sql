// The session adapters, from the harness-session-adapters package (`@agent-realm/harness-session-adapters`, in
// harness-skeleton's packages/harness-session-adapters). Until it is on npm, SSQL_ADAPTERS names it: a
// path to the package directory, or a package name the kit can import. The fixture-based checks
// need the package's fixtures/ folder, which a checkout has and a published package may not.
//
// The kit also makes one adapter of its own from each real one: the same adapter at a higher
// `adapter_ver` that re-keys every usage record (the kind of key change sessions-model §1 rule 8
// allows a version bump to make). The "Re-derive from the archive" check replays with it.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { jcsSha } from './jcs.mjs';

export class AdapterSource {
  constructor(mod, root) {
    this.mod = mod;
    this.root = root;
    this.fixtures = root && fs.existsSync(path.join(root, 'fixtures')) ? path.join(root, 'fixtures') : null;
    this.describes = new Map();
    this.bumped = new Map();
  }

  describe(harness) {
    if (!this.describes.has(harness)) this.describes.set(harness, this.mod.adapterFor(harness).describe());
    return this.describes.get(harness);
  }

  // The adapter for `harness`; with `adapterVer`, the kit's bumped adapter of that version.
  adapterFor(harness, { adapterVer } = {}) {
    const base = this.mod.adapterFor(harness);
    if (adapterVer === undefined || adapterVer === this.describe(harness).adapter_ver) return base;
    const want = bumpVersion(this.describe(harness).adapter_ver);
    if (adapterVer !== want) throw new Error(`the kit has no ${harness} adapter at ${adapterVer} (it makes ${want})`);
    if (!this.bumped.has(harness)) this.bumped.set(harness, bumpedAdapter(base, want));
    return this.bumped.get(harness);
  }

  // { harness: version } of the kit's bumped adapters, for replay({ adapterVer }).
  bumpedVersions(harnesses) {
    return Object.fromEntries([...harnesses].map((h) => [h, bumpVersion(this.describe(h).adapter_ver)]));
  }
}

export function bumpVersion(v) {
  const m = String(v).match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) throw new Error(`adapter_ver ${v} is not a.b.c`);
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}

export const REKEY = '~rekeyed';

// The bumped adapter: describe and derive report `ver`, and every usage record's usage_id gains a
// suffix, so every old usage key is one this version no longer produces.
function bumpedAdapter(base, ver) {
  const rekey = (id) => `${id}${REKEY}`;
  const reseal = (r) => {
    const { content_sha: _c, cmp_sha: _m, ...rest } = r;
    return { ...r, content_sha: jcsSha(rest) };
  };
  return {
    ...base,
    HARNESS: base.HARNESS,
    describe: (...a) => ({ ...base.describe(...a), adapter_ver: ver }),
    derive(session, input, state) {
      const out = base.derive(session, input, state);
      const changed = out.changed.map((r) => (r.type === 'usage' ? reseal({ ...r, usage_id: rekey(r.usage_id) }) : r));
      const mapSets = (sets) => (sets ? { ...sets, usage: (sets.usage ?? []).map(rekey) } : sets);
      return { ...out, changed, live: mapSets(out.live), held: mapSets(out.held), adapter_ver: ver };
    },
  };
}

// Load the package. Returns { source } or { error } (the fixture checks are then skipped).
export async function loadAdapters(spec = process.env.SSQL_ADAPTERS) {
  if (!spec) return { error: 'SSQL_ADAPTERS is not set: name the harness-session-adapters package (a path to it, or its package name)' };
  try {
    let entry;
    let root;
    if (spec.startsWith('.') || spec.startsWith('/') || /^[A-Za-z]:[\\/]/.test(spec)) {
      root = path.resolve(spec);
      const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
      const main = typeof pkg.exports === 'string' ? pkg.exports : pkg.exports?.['.'] ?? pkg.main ?? 'index.js';
      entry = pathToFileURL(path.join(root, main)).href;
    } else {
      entry = import.meta.resolve(spec);
      root = path.dirname(fileURLToPath(entry));
      while (root !== path.dirname(root) && !fs.existsSync(path.join(root, 'package.json'))) root = path.dirname(root);
    }
    const mod = await import(entry);
    if (typeof mod.adapterFor !== 'function') return { error: `${spec} does not export adapterFor()` };
    return { source: new AdapterSource(mod, root) };
  } catch (e) {
    return { error: `cannot load the session adapters from SSQL_ADAPTERS: ${e.message}` };
  }
}

// A unit as `read` emitted it, rebuilt from an archive row: its bytes are the UTF-8 of `raw`, or
// the base64 they were written as (`enc: b64`).
export function unitFromArchive(row) {
  const body = row.raw;
  const bytes = row.enc === 'b64' ? Buffer.from(body, 'base64').length : Buffer.byteLength(body, 'utf8');
  const u = {
    source_key: row.source_key,
    unit_key: row.unit_key,
    enc: row.enc,
    bytes,
    sha256: row.sha256,
    redacted: row.redacted === true || row.redacted === 1 || row.redacted === 'true',
    body,
  };
  if (row.orig_sha256 && /^[0-9a-f]{64}$/.test(row.orig_sha256)) u.orig_sha256 = row.orig_sha256;
  return u;
}

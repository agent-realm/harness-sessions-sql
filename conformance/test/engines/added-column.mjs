// A test engine whose own DDL adds a column of the deployment's (`tenant`, with a default) to
// sessions and session_parts, in the middle of each table, as §3 and §4.8 allow. A legacy line
// leaves "any column a deployment adds" out (§4.8), so Legacy content_sha, whole rows must pass.
import * as reference from '../../reference/engine.mjs';

export const { name, version, createEngine } = reference;

function addTenant(text, profile) {
  const column = profile === 'clickhouse' ? "    tenant           String DEFAULT ''," : "    tenant           text NOT NULL DEFAULT '',";
  for (const table of ['sessions', 'session_parts']) {
    const at = text.search(new RegExp(`CREATE TABLE ${table}\\b`));
    const line = text.slice(at).search(/\n\s+incarnation\s[^\n]*\n/);
    if (at < 0 || line < 0) throw new Error(`added-column: no incarnation column in ${table}`);
    const end = text.indexOf('\n', at + line + 1) + 1;
    text = `${text.slice(0, end)}${column}\n${text.slice(end)}`;
  }
  return text;
}

export async function createTables(opts) {
  const { loadSchema } = await import('../../lib/db.mjs');
  await loadSchema(opts.ns, { transforms: [addTenant] });
}

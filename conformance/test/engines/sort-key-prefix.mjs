// A test engine whose own ClickHouse DDL prefixes session_parts' sort key with toDate(ts), which §3
// allows ("columns that never change for a key, such as toDate(ts) for messages"; a Nullable key
// column needs allow_nullable_key). Tables and keys must accept it.
import * as reference from '../../reference/engine.mjs';

export const { name, version, createEngine } = reference;

const PARTS_KEY = /(ENGINE = ReplacingMergeTree\(rev, is_deleted\)\n)ORDER BY \((host, harness, harness_path, session_id, incarnation, message_id, part_id)\);/;

export async function createTables(opts) {
  const { loadSchema } = await import('../../lib/db.mjs');
  const prefix = (text, profile) => {
    if (profile !== 'clickhouse') return text;
    if (!PARTS_KEY.test(text)) throw new Error('sort-key-prefix: session_parts ORDER BY not found');
    return text.replace(PARTS_KEY, '$1ORDER BY (toDate(ts), $2)\nSETTINGS allow_nullable_key = 1;');
  };
  await loadSchema(opts.ns, { transforms: [prefix] });
}

// The SQL-only examples (01, 02): one .sql file per profile, run statement by statement in a fresh
// namespace that holds schema/'s tables under their logical names, so each file reads as it would
// in clickhouse-client or psql after the DDL was loaded.
//
// The files follow three conventions:
// - a statement ends with `;` at the end of a line, and no string literal holds `;` or `--`;
// - a comment line `-- @ <caption>` before a statement prints `<caption>:` and the rows the
//   statement returns;
// - a comment line `-- @error <caption>` before a statement expects the database to refuse it,
//   and prints `<caption>: refused`. A statement it accepts fails the example.
// Every other statement runs silently; every other comment is for the reader.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runExample, inNamespace, table } from './example.mjs';

// The statements of a file: [{ sql, mark: null | { error, caption } }].
export function statementsOf(text) {
  const out = [];
  let lines = [];
  let mark = null;
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    const m = line.match(/^\s*--\s*@(error)?\s+(.*)$/);
    if (m) {
      mark = { error: !!m[1], caption: m[2].trim() };
      continue;
    }
    const code = line.replace(/--.*$/, '').trimEnd();
    if (!code.trim()) continue;
    lines.push(code);
    if (code.endsWith(';')) {
      out.push({ sql: lines.join('\n').slice(0, -1).trim(), mark });
      lines = [];
      mark = null;
    }
  }
  if (lines.length) throw new Error('the file ends inside a statement (no closing ;)');
  return out;
}

// `files`: { profile: file name in the example's folder }.
export async function runSqlExample(exampleUrl, files) {
  const dir = path.dirname(fileURLToPath(exampleUrl));
  await runExample({
    profiles: Object.keys(files),
    async run({ profile, target, namespace }) {
      const statements = statementsOf(fs.readFileSync(path.join(dir, files[profile]), 'utf8'));
      const ns = await namespace();
      const db = inNamespace(ns, target);
      try {
        for (const { sql, mark } of statements) {
          if (!mark) {
            await db.exec(sql);
          } else if (mark.error) {
            const accepted = await db.exec(sql).then(() => true, () => false);
            if (accepted) throw new Error(`"${mark.caption}": the database accepted a statement it must refuse`);
            console.log(`${mark.caption}: refused`);
          } else {
            console.log(`${mark.caption}:`);
            console.log(table(await db.query(sql)));
          }
        }
      } finally {
        await db.close();
      }
    },
  });
}

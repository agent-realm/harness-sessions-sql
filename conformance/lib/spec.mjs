// What the kit reads from 01-SESSIONS-SQL-SPEC.md itself, so the checks and the specification
// cannot drift apart (AGENTS.md rule 1, one home for the text):
// - §3's table of identities (logical table -> identity columns, informative or not);
// - §4.8's known-answer vectors (column expressions, TabSeparated line, sha256);
// - §4.8's full-row vectors (table, line, sha256).
// A parse that finds nothing throws: a check never passes on an empty list.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SPEC_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '01-SESSIONS-SQL-SPEC.md');

let cached = null;
function specText() {
  cached ??= fs.readFileSync(SPEC_PATH, 'utf8');
  return cached;
}

// The text of a section, from its heading to the next heading of the same or a higher level.
function section(text, heading) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.startsWith(heading));
  if (start < 0) throw new Error(`spec: no section "${heading}"`);
  const level = heading.match(/^#+/)[0].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#+) /);
    if (m && m[1].length <= level) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

const cells = (row) => row.split('|').slice(1, -1).map((c) => c.trim());
const unticked = (s) => s.replace(/^`|`$/g, '');

// §3: { sessionKey: [...], tables: { name: { identity: [...], informative } } }.
export function identities(text = specText()) {
  const s3 = section(text, '## 3. ');
  const sk = s3.match(/session key `S = \(([^)]*)\)`/);
  if (!sk) throw new Error('spec §3: no session key S');
  const sessionKey = sk[1].split(',').map((c) => c.trim());
  const tables = {};
  for (const line of s3.split('\n')) {
    if (!line.startsWith('| `')) continue;
    const [name, ident] = cells(line);
    const tname = name.match(/`([a-z_]+)`/)[1];
    const im = ident.match(/`S(?: \+ \(([^)]*)\))?`/);
    if (!im) throw new Error(`spec §3: cannot read the identity of ${tname}`);
    const own = im[1] ? im[1].split(',').map((c) => c.trim()) : [];
    tables[tname] = { identity: [...sessionKey, ...own], informative: /informative/.test(name) };
  }
  if (Object.keys(tables).length < 6) throw new Error('spec §3: fewer than six tables in the identity table');
  return { sessionKey, tables };
}

// §4.8's known-answer vectors: [{ exprs: [sql, ...], line, sha256 }].
// In the spec's table, `<TAB>` stands for a tab: inside a column expression it becomes the SQL
// escape \t, inside the line a real tab byte.
export function knownAnswerVectors(text = specText()) {
  const s48 = section(text, '### 4.8 ');
  const lines = s48.split('\n');
  const head = lines.findIndex((l) => /\|\s*Columns\s*\|\s*Line/.test(l));
  if (head < 0) throw new Error('spec §4.8: no known-answer table');
  const out = [];
  for (let i = head + 2; i < lines.length && lines[i].trim().startsWith('|'); i++) {
    const [cols, line, sha] = cells(lines[i].trim());
    const exprs = [];
    for (const m of cols.matchAll(/`([^`]*)`|([A-Za-z_][A-Za-z_0-9]*)/g)) exprs.push((m[1] ?? m[2]).replace(/<TAB>/g, '\\t'));
    out.push({ exprs, line: unticked(line).replace(/<TAB>/g, '\t'), sha256: unticked(sha) });
  }
  if (!out.length) throw new Error('spec §4.8: the known-answer table is empty');
  return out;
}

// §4.8's full-row vectors: [{ table, label, line, sha256 }]. Each is a bullet that names it and
// its sha, followed by a fenced block holding the line as a JSON string.
export function fullRowVectors(text = specText()) {
  const s48 = section(text, '### 4.8 ');
  const start = s48.indexOf('**Full-row vectors**');
  if (start < 0) throw new Error('spec §4.8: no full-row vectors');
  const region = s48.slice(start);
  const out = [];
  const fence = /```\n\s*("(?:[^"\\]|\\.)*")\s*\n\s*```/g;
  let last = 0;
  for (const m of region.matchAll(fence)) {
    const before = region.slice(last, m.index);
    last = m.index + m[0].length;
    const bullet = before.slice(before.lastIndexOf('\n    - ') + 1);
    const shas = [...bullet.matchAll(/`([0-9a-f]{64})`/g)];
    if (!shas.length) throw new Error('spec §4.8: a full-row vector without its sha256');
    const table = /^\s*- `sessions`/.test(bullet) ? 'sessions' : 'session_parts';
    out.push({ table, label: bullet.trim().split('\n')[0].replace(/^- /, '').replace(/:\s*`[0-9a-f]{64}`$/, ''), line: JSON.parse(m[1]), sha256: shas.at(-1)[1] });
  }
  if (!out.length) throw new Error('spec §4.8: no full-row vector parsed');
  return out;
}

// §4.8's own SQL of a legacy line and its sha ("In ClickHouse: `lower(hex(SHA256(…)))`"), and the
// settings that pin its bytes: a function of the column expressions -> { line, sql, settings },
// the shape of an engine's `legacySha`.
export function specLegacySha(text = specText()) {
  const s48 = section(text, '### 4.8 ');
  const m = s48.match(/`(lower\(hex\(SHA256\((trimRight\(formatRow\('TabSeparated', <columns>\), '\\n'\))\)\)\))`/);
  if (!m) throw new Error('spec §4.8: no ClickHouse expression of the legacy sha');
  const at = s48.indexOf('**What pins the bytes.**');
  if (at < 0) throw new Error('spec §4.8: no settings that pin the bytes');
  const pins = s48.slice(at, s48.indexOf('DateTime64', at));
  const settings = Object.fromEntries([...pins.matchAll(/`(\w+) = '([^']*)'`/g)].map(([, k, v]) => [k, v]));
  if (Object.keys(settings).length < 3) throw new Error('spec §4.8: fewer than three pinned settings');
  return (exprs) => ({ line: m[2].replace('<columns>', exprs.join(', ')), sql: m[1].replace('<columns>', exprs.join(', ')), settings });
}

// §4.8: the columns a legacy content_sha line leaves out, per table.
export const LEGACY_LINE_EXCLUDES = {
  common: ['content_sha', 'rev', 'is_deleted', 'removed', 'ingested_at', 'writer'],
  session_parts: ['message_content_sha', 'cmp_sha'],
};

// The columns of a table in the committed DDL of a profile (schema/<profile>.sql), in order,
// without constraints, and without MATERIALIZED columns unless `materialized` is set.
export function ddlColumns(profile, table, { materialized = false } = {}) {
  const text = fs.readFileSync(path.join(path.dirname(SPEC_PATH), 'schema', `${profile}.sql`), 'utf8')
    .split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');
  const start = text.search(new RegExp(`CREATE TABLE ${table}\\b`));
  if (start < 0) throw new Error(`schema/${profile}.sql: no table ${table}`);
  const body = text.slice(start, text.indexOf(';', start)).split('\n').slice(1);
  const cols = [];
  for (const line of body) {
    const m = line.match(/^\s{2,}([a-z_0-9]+)\s+(.*)$/);
    if (!m || m[1] === 'CONSTRAINT' || (!materialized && /\bMATERIALIZED\b/.test(m[2])) || m[1] === 'PRIMARY') continue;
    cols.push(m[1]);
  }
  return cols;
}

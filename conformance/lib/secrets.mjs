// The credentials the kit was given, so that no error path prints one.
//
// A target's credentials reach the kit in the environment: SSQL_CH_USER and SSQL_CH_PASSWORD, and
// the user info of SSQL_CH_URL or SSQL_PG_URL (and a PostgreSQL URL's `user` and `password`
// parameters). Each is registered here when a target is read or a client is made, and `scrub`
// takes every registered value out of a message before the kit prints it or writes it to JSON:
// - a password is replaced wherever it appears, in its plain and its URL-encoded spelling;
// - a user name is replaced where it stands as a word (a server's "authentication failed for
//   user …" names it), so that a short name does not blank out unrelated text;
// - any URL left in a message loses its user info (the `user:password@` after its scheme),
//   registered or not.
// Error messages are built from scrubbed parts in the first place (lib/ch.mjs, lib/pg.mjs); this
// is the net under them.

const values = new Set();
const words = new Set();

function spellings(v) {
  const out = new Set([v]);
  try {
    out.add(encodeURIComponent(v));
  } catch { /* not encodable: the plain spelling only */ }
  try {
    out.add(decodeURIComponent(v));
  } catch { /* not encoded */ }
  return [...out].filter(Boolean);
}

export function registerSecret(value, { word = false } = {}) {
  if (value === undefined || value === null || value === '') return;
  for (const s of spellings(String(value))) (word ? words : values).add(s);
}

// The user info and credential parameters of a URL, registered.
export function registerUrl(url) {
  if (!url) return;
  let u;
  try {
    u = new URL(url);
  } catch {
    // Unparsable: whatever sits between `//` and `@` is the user info.
    const m = String(url).match(/^[a-z][a-z0-9+.-]*:\/\/([^/@]*)@/i);
    if (m) {
      const [user, ...rest] = m[1].split(':');
      registerSecret(user, { word: true });
      registerSecret(rest.join(':'));
    }
    return;
  }
  registerSecret(u.username, { word: true });
  registerSecret(u.password);
  registerSecret(u.searchParams.get('user'), { word: true });
  registerSecret(u.searchParams.get('password'));
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const byLength = (a, b) => b.length - a.length;

export function scrub(text) {
  let s = String(text ?? '');
  s = s.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]*@/gi, '$1');
  for (const v of [...values].sort(byLength)) s = s.split(v).join('***');
  for (const w of [...words].sort(byLength)) s = s.replace(new RegExp(`(?<![A-Za-z0-9_-])${escape(w)}(?![A-Za-z0-9_-])`, 'g'), '***');
  return s;
}

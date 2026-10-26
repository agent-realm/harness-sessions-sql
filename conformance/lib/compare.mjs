// A namespace's adapter-owned records against the oracle's expectation for one pass (sessions §4):
// every key the pass leaves current is current with its derived content_sha, nothing else is
// current, and every key that left `live` is a removed version of its last row (or gone, for a
// tombstoning engine).

const show = (k) => k.replace(/\u0000/g, '/').slice(0, 200);

// The record's rows carry its content_sha (a message's parts: as message_content_sha). For a
// current record only its current rows count: a part its message dropped is a removed row beside.
// For a removed record, the rows of its latest version (the highest rev) count.
export function shaMatches(r, got, current) {
  const top = Math.max(...got.rows.map(({ row }) => Number(row.rev)));
  const rows = got.rows.filter(({ row }) => (current ? !Number(row.removed) : Number(row.rev) === top));
  if (r.type === 'message') return rows.every(({ row }) => row.message_content_sha === r.content_sha);
  return rows.every(({ row }) => row.content_sha === r.content_sha);
}

// `db`: lib/state.mjs records(ns). `expPass`: one pass of lib/oracle.mjs expectStates.
export function recordProblems(db, expPass, { tomb = false, at = '' } = {}) {
  const problems = [];
  const pre = at ? `${at}: ` : '';
  const want = new Map();
  for (const [sk, st] of expPass) for (const [rk, r] of st.current) want.set(`${sk}|${rk}`, r);
  for (const [k, r] of want) {
    const got = db.get(k);
    if (!got?.current) problems.push(`${pre}${show(k)} is live but not current`);
    else if (!shaMatches(r, got, true)) problems.push(`${pre}${show(k)} is current with another content_sha than its derived record`);
  }
  for (const [k, got] of db) if (got.current && !want.has(k)) problems.push(`${pre}${show(k)} is current but not live`);
  const removed = [];
  for (const [sk, st] of expPass) {
    for (const [rk, r] of st.removed) {
      const k = `${sk}|${rk}`;
      const got = db.get(k);
      removed.push({ k, r, got });
      if (tomb) {
        if (got && !got.removed) problems.push(`${pre}${show(k)} left live but is still current`);
      } else if (!got) problems.push(`${pre}${show(k)} left live and has no removed version`);
      else if (!got.removed) problems.push(`${pre}${show(k)} left live and is still current`);
      else if (!shaMatches(r, got, false)) problems.push(`${pre}the removed version of ${show(k)} is not a copy of its last row`);
    }
  }
  return { problems, want, removed };
}

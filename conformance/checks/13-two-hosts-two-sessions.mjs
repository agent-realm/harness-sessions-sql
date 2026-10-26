// §8: "Two hosts, two sessions: a data folder copied to a second host gives a second set of
// sessions, with the same session_ids and different session keys."
//
// One harness store of each of two fixtures read under two host/v0 values (two synthetic machine
// ids), at the same harness_path, as a copied data folder is. Every session must be current under
// both hosts: two session keys per session_id.

import { verdict } from '../lib/result.mjs';

export default {
  id: 'two-hosts-two-sessions',
  title: 'Two hosts, two sessions',
  kind: 'engine',
  faults: ['engine:host-merge'],

  async run(ctx) {
    const problems = [];
    const sc = ctx.scenario('twoHosts');
    const ns = await ctx.namespace();
    const engine = await ctx.engine(ns);
    for (const p of sc.passes) await engine.pass(p);
    const rows = await ns.current('sessions');
    const ids = new Set(sc.passes.flat().map((e) => `${e.store.harness}\u0000${e.store.harness_path}\u0000${e.session.session_id}\u0000${e.session.incarnation}`));
    for (const id of ids) {
      const [harness, hp, sid, inc] = id.split('\u0000');
      const hosts = new Set(rows.filter((r) => r.harness === harness && r.harness_path === hp && r.session_id === sid && r.incarnation === inc).map((r) => r.host));
      for (const h of sc.hosts) if (!hosts.has(h)) problems.push(`${harness} ${sid}: no current session under the host ${h.slice(0, 8)}…`);
    }
    return verdict(problems, [`${ids.size} sessions, each under ${sc.hosts.length} hosts`]);
  },
};

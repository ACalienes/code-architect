'use strict';
/**
 * Facade proof — the createSharedLayer() surface wires the modules together correctly: enroll →
 * authorize → sign+write (full door) → drain (heartbeat wired) → health, plus the claims path.
 * Exits non-zero on any failure.
 *
 *   node prototype/shared-layer/index.test.js
 */
const { createSharedLayer, openDb } = require('./index');

let failures = 0;
const check = (label, cond) => { console.log(`  ${cond ? '✓' : '✗ FAIL'}  ${label}`); if (!cond) failures++; };
const h = (s) => console.log(`\n\x1b[1m${s}\x1b[0m`);

(async () => {
  h('1. The facade wires the production path end to end');
  {
    const sl = createSharedLayer({ db: openDb() });
    const dag = sl.generateIdentity();
    sl.registerIdentity({ agent: 'dag-repo', publicKey: dag.publicKey, clientId: 'dagdc' });
    check('subscribe by an UNREGISTERED agent is refused', !sl.authorizeSubscribe('acd', 'client_feedback', '*').ok);
    const acd = sl.generateIdentity();
    sl.registerIdentity({ agent: 'acd', publicKey: acd.publicKey });
    check('acd subscription authorized after enrollment', sl.authorizeSubscribe('acd', 'client_feedback', '*').ok);

    const fact = { fact_type: 'client_feedback', client_id: 'dagdc', subject_id: 'm', visibility: 'client', data_class: 'client_confidential', source_agent: 'dag-repo', observed_at: '2026-05-25T00:00:00Z', payload: { sentiment: 'loved' } };
    const r = sl.write(fact, sl.sign(dag.privateKey, fact));
    check('write through the full door routes', r.ok && r.routed === 1);

    const got = [];
    const runner = sl.drainer('acd', async (f) => got.push(f.subject_id));
    await runner.tickOnce();
    check('facade drainer delivers (and heartbeat was wired)', got.length === 1);
    const hh = sl.health();
    check('facade health reports OK + the fact + acd liveness', hh.ok && hh.flow.facts === 1 && hh.agents.find(a => a.agent === 'acd').last_seen_ms_ago !== null);
  }

  h('2. The facade enforces the same guards as the modules');
  {
    const sl = createSharedLayer({ db: openDb() });
    const dag = sl.generateIdentity();
    sl.registerIdentity({ agent: 'dag-repo', publicKey: dag.publicKey, clientId: 'dagdc' });
    check('cross-client subscribe still refused through the facade', !sl.authorizeSubscribe('dag-repo', 'client_feedback', 'tdb').ok);
    const bad = { fact_type: 'client_feedback', client_id: 'tdb', subject_id: 'x', visibility: 'client', data_class: 'client_confidential', source_agent: 'dag-repo', observed_at: '2026-05-25T00:00:00Z', payload: { sentiment: 'loved' } };
    check('cross-client produce still refused through the facade', !sl.write(bad, sl.sign(dag.privateKey, bad)).ok);
  }

  h('3. Claims path is reachable from the facade');
  {
    const sl = createSharedLayer({ db: openDb() });
    const c = sl.ingestClaim({ fact_type: 'decision', subject_id: 'd', visibility: 'internal', data_class: 'internal', source_ref: 'm.md:1', payload: { text: 'x' } });
    check('claim ingested + quarantined (invisible until promoted)', c.ok && sl.listClaims().length === 1);
  }

  h(failures === 0 ? '\x1b[32mFACADE HOLDS ✓\x1b[0m' : `\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`);
  process.exit(failures === 0 ? 0 : 1);
})();

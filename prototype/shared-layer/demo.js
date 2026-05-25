'use strict';
/**
 * The Shared Layer — runnable proof.
 * Runs the real DAG→ACD/NAMI flow + the adversarial cross-client isolation test
 * + preflight + fail-closed + retraction. Exits non-zero if any invariant breaks.
 *
 *   node prototype/shared-layer/demo.js
 */
const { openDb, subscribe, writeFact, drain, revoke } = require('./shared-layer');

let failures = 0;
const check = (label, cond) => {
  console.log(`  ${cond ? '✓' : '✗ FAIL'}  ${label}`);
  if (!cond) failures++;
};
const h = (s) => console.log(`\n\x1b[1m${s}\x1b[0m`);

const db = openDb(); // in-memory

// ── Subscriptions: internal agents see all clients ('*'); client repos see ONLY their own ──
h('Setup — who subscribes to what (client repos scoped to their own client only)');
subscribe(db, 'acd',      'client_feedback', '*');      // internal: concept owner, all clients
subscribe(db, 'nami',     'client_feedback', '*');      // internal: captioning/delivery, all clients
subscribe(db, 'dag-repo', 'client_feedback', 'dagdc');  // CLIENT repo: only DAGDC
subscribe(db, 'dag-repo', 'decision',        'dagdc');
subscribe(db, 'tdb-repo', 'client_feedback', 'tdb');    // CLIENT repo: only TDB
console.log('  acd, nami → all clients   |   dag-repo → dagdc only   |   tdb-repo → tdb only');

// ── 1. The real moment: Alex tells DAG "Dan loved the Memorial Day posts" ──
h('1. DAG records "Dan loved the Memorial Day posts" (one write)');
const r1 = writeFact(db, {
  fact_type: 'client_feedback', client_id: 'dagdc',
  subject_type: 'campaign', subject_id: 'memorial-day',
  visibility: 'client', data_class: 'client_confidential',
  source_agent: 'dag-repo',
  payload: { sentiment: 'loved', note: 'Dan approved; posts published successfully' },
});
check('write accepted', r1.ok);
check('routed to exactly 3 subscribers (acd, nami, dag-repo)', r1.routed === 3);

// ── 2. Each agent drains its OWN inbox ──
h('2. Each agent checks its inbox (drains only its own deliveries)');
const acd = drain(db, 'acd');
const nami = drain(db, 'nami');
const dag = drain(db, 'dag-repo');
const tdb = drain(db, 'tdb-repo');
check('ACD got the feedback (concept validated)', acd.length === 1 && acd[0].subject_id === 'memorial-day');
check('NAMI got the feedback (delivery confirmed)', nami.length === 1);
check('DAG repo got its own client feedback', dag.length === 1 && dag[0].client_id === 'dagdc');
check('TDB repo got NOTHING (not its client)', tdb.length === 0);

// ── 3. ADVERSARIAL: a TDB fact must never reach the DAG repo ──
h('3. Adversarial — write a TDB-confidential fact; can DAG ever see it?');
writeFact(db, {
  fact_type: 'client_feedback', client_id: 'tdb',
  subject_type: 'campaign', subject_id: 'tdb-secret-launch',
  visibility: 'client', data_class: 'client_confidential',
  source_agent: 'tdb-repo',
  payload: { sentiment: 'confidential TDB info DAG must never see' },
});
// Internal agents are cross-client BY DESIGN (scope '*') — they see every client's feedback:
const acdSeesTdb = drain(db, 'acd');
const namiSeesTdb = drain(db, 'nami');
check('ACD/NAMI (internal) DO see the TDB fact — internal agents are cross-client by design', acdSeesTdb.length === 1 && namiSeesTdb.length === 1);
// ...but a CLIENT repo cannot cross into another client. This is the whole game:
const dagAfter = drain(db, 'dag-repo');
check('DAG repo drain returns NOTHING for the TDB fact (structural isolation holds)', dagAfter.length === 0);
const tdbOwn = drain(db, 'tdb-repo');
check('TDB repo DOES get its own fact', tdbOwn.length === 1 && tdbOwn[0].client_id === 'tdb');

// ── 4. Preflight: bad writes rejected at the door ──
h('4. Preflight — bad writes are refused before they ever persist');
const badType = writeFact(db, { fact_type: 'gossip', visibility: 'internal', data_class: 'internal', source_agent: 'x', payload: {} });
check('unknown fact_type rejected', !badType.ok && /unknown fact_type/.test(badType.error));
const noScope = writeFact(db, { fact_type: 'client_feedback', visibility: 'client', data_class: 'client_confidential', source_agent: 'x', payload: {} });
check('client-confidential fact with no client_id rejected', !noScope.ok && /missing client_id/.test(noScope.error));

// ── 5. Fail-closed: an unroutable fact is dead-lettered, never silently dropped ──
h('5. Fail-closed — a fact nobody subscribes to lands in dead_letter (no silent drop)');
const orphan = writeFact(db, {
  fact_type: 'work_order', client_id: 'dagdc', visibility: 'internal', data_class: 'internal',
  source_agent: 'ca', payload: { task: 'nobody subscribes to work_order yet' },
});
check('orphan write accepted but routed to 0', orphan.ok && orphan.routed === 0);
const dl = db.prepare('SELECT COUNT(*) AS n FROM dead_letter').get();
check('it is captured in dead_letter (recoverable, alertable)', dl.n === 1);

// ── 6. Retraction: "that fact was wrong" reaches everyone who got it ──
h('6. Retraction — revoke the DAG feedback; recipients get a correction');
const corrections = revoke(db, r1.fact_id, 'entered against wrong campaign');
check('corrections issued to the 3 original recipients', corrections === 3);
const acdCorrection = drain(db, 'acd');
check('ACD receives the correction on its next drain', acdCorrection.length === 1 && acdCorrection[0].kind === 'correction');

// ── result ──
h(failures === 0 ? '\x1b[32mALL INVARIANTS HOLD ✓\x1b[0m' : `\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`);
const audits = db.prepare('SELECT COUNT(*) AS n FROM audit_log').get();
console.log(`  (every write/route/drain/revoke audited — ${audits.n} audit rows)\n`);
process.exit(failures === 0 ? 0 : 1);

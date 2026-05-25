'use strict';
/**
 * Integration capstone — the whole Shared Layer composed as ONE system. This is the #8 pilot
 * (DAG → ACD/NAMI) rehearsed in-process, exercising every module together: identity (#4) →
 * registry (#6) → core route → projection (#3) → runner (#1) + wake → health (#5), plus the
 * adversarial cases the system must catch. Proves the pieces compose, not just that each works
 * alone. Deterministic; cleans up its temp dir. Exits non-zero on any failure.
 *
 *   node prototype/shared-layer/integration.test.js
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb } = require('./shared-layer');
const { defaultRegistry } = require('./registry');
const { generateIdentity, registerIdentity, signFact, writeSignedFact, authorizeSubscribe } = require('./identity');
const { projectClient, openProjectionDb } = require('./projection');
const { createDrainer } = require('./runner');
const { health, recordHeartbeat } = require('./health');

let failures = 0;
const check = (label, cond) => { console.log(`  ${cond ? '✓' : '✗ FAIL'}  ${label}`); if (!cond) failures++; };
const h = (s) => console.log(`\n\x1b[1m${s}\x1b[0m`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-int-'));
const handles = [];

(async () => {
  // ── BOOTSTRAP (privileged): identities + authorized subscriptions ──
  h('Bootstrap — enroll identities and authorize subscriptions');
  const db = openDb();
  const ids = {};
  for (const [agent, clientId] of [['dag-repo', 'dagdc'], ['tdb-repo', 'tdb'], ['acd', null], ['nami', null]]) {
    const kp = generateIdentity(); ids[agent] = kp;
    registerIdentity(db, { agent, publicKey: kp.publicKey, clientId });
  }
  authorizeSubscribe(db, 'acd', 'client_feedback', '*');
  authorizeSubscribe(db, 'nami', 'client_feedback', '*');
  authorizeSubscribe(db, 'dag-repo', 'client_feedback', 'dagdc');
  authorizeSubscribe(db, 'tdb-repo', 'client_feedback', 'tdb');
  check('4 identities enrolled, 4 subscriptions authorized', db.prepare('SELECT COUNT(*) AS n FROM identities').get().n === 4 && db.prepare('SELECT COUNT(*) AS n FROM subscriptions').get().n === 4);

  // ── THE MOMENT: DAG records "Dan loved the Memorial Day posts" — signed, schema-checked ──
  h('The moment — DAG signs the fact; it goes verify → authZ → schema → route');
  const fact = {
    fact_type: 'client_feedback', client_id: 'dagdc', subject_type: 'campaign', subject_id: 'memorial-day',
    visibility: 'client', data_class: 'client_confidential', source_agent: 'dag-repo',
    observed_at: '2026-05-25T12:00:00.000Z', payload: { sentiment: 'loved', note: 'Dan approved' },
  };
  const w = writeSignedFact(db, fact, signFact(ids['dag-repo'].privateKey, fact), { registry: defaultRegistry });
  check('written through the full door, routed to acd+nami+dag-repo', w.ok && w.routed === 3);

  // ── PROJECT to per-client files, then drain everyone via the runner ──
  h('Deliver — project client files, run each agent\'s drainer');
  const dagProj = projectClient(db, { dir: tmp, agent: 'dag-repo', clientId: 'dagdc' });
  projectClient(db, { dir: tmp, agent: 'tdb-repo', clientId: 'tdb' });
  const got = { acd: [], nami: [], dag: [], tdb: [] };
  const acdRunner = createDrainer({ db, agent: 'acd', handler: async (f) => got.acd.push(f.subject_id), onTick: (s) => recordHeartbeat(db, 'acd', s) });
  const namiRunner = createDrainer({ db, agent: 'nami', handler: async (f) => got.nami.push(f.subject_id), onTick: (s) => recordHeartbeat(db, 'nami', s) });
  const dagPdb = openProjectionDb(dagProj.file); handles.push(dagPdb);
  const dagRunner = createDrainer({ db: dagPdb, agent: 'dag-repo', handler: async (f) => got.dag.push(f.subject_id) });
  await acdRunner.tickOnce(); await namiRunner.tickOnce(); await dagRunner.tickOnce();
  check('ACD received it (internal, central)', got.acd.length === 1 && got.acd[0] === 'memorial-day');
  check('NAMI received it (internal, central)', got.nami.length === 1);
  check('DAG received it from its OWN projection file', got.dag.length === 1 && got.dag[0] === 'memorial-day');
  const tdbRaw = fs.readFileSync(path.join(tmp, 'tdb-repo', 'inbox.db')).toString('latin1');
  check('TDB\'s file has zero trace of the DAGDC fact (isolation across the whole stack)', !tdbRaw.includes('memorial-day') && !tdbRaw.includes('Dan approved'));

  // ── ADVERSARIAL: the system catches the bad cases ──
  h('Adversarial — the door rejects forgery, cross-client, and bad schema');
  const xClientFact = { ...fact, client_id: 'tdb', subject_id: 'steal' };
  const xClient = writeSignedFact(db, xClientFact, signFact(ids['dag-repo'].privateKey, xClientFact), { registry: defaultRegistry });
  check('dag-repo CANNOT produce a TDB fact (client binding)', !xClient.ok && /client_binding/.test(xClient.error));
  const forged = { ...fact, source_agent: 'nami', subject_id: 'forged' };
  const imp = writeSignedFact(db, forged, signFact(ids['dag-repo'].privateKey, forged), { registry: defaultRegistry });
  check('cannot forge nami\'s attribution', !imp.ok && /unauthenticated/.test(imp.error));
  const badSchema = { ...fact, subject_id: 's2', payload: { sentiment: 'ecstatic' } };
  const bs = writeSignedFact(db, badSchema, signFact(ids['dag-repo'].privateKey, badSchema), { registry: defaultRegistry });
  check('a bad payload is rejected by the schema door', !bs.ok && /schema/.test(bs.error));
  const xSub = authorizeSubscribe(db, 'dag-repo', 'client_feedback', 'tdb');
  check('dag-repo cannot subscribe to TDB', !xSub.ok);

  // ── HEALTH: re-audit the whole system ──
  h('Observe — health re-audits the composed system');
  const hh = health(db, { registry: defaultRegistry, projections: [{ agent: 'dag-repo', file: dagProj.file }], open: openProjectionDb });
  check('system is OK — no critical alerts after a clean run', hh.ok === true);
  check('flow counts the one real fact (the bad writes never persisted)', hh.flow.facts === 1);
  check('acd/nami liveness is known (heartbeats recorded)', hh.agents.find(a => a.agent === 'acd').last_seen_ms_ago !== null);

  // simulate an isolation breach upstream → health raises the alarm
  db.prepare('INSERT INTO audit_log (ts, event, detail) VALUES (?, ?, ?)').run(new Date().toISOString(), 'projection_refused_cross_client', '{"agent":"dag-repo","fact_client":"tdb"}');
  const hh2 = health(db);
  check('a cross-client refusal flips health to CRITICAL', hh2.ok === false && hh2.alerts.some(a => a.code === 'cross_client_refused'));

  for (const hdl of handles) { try { hdl.close(); } catch (_) {} }
  fs.rmSync(tmp, { recursive: true, force: true });
  h(failures === 0 ? '\x1b[32mFULL-SYSTEM INTEGRATION HOLDS ✓\x1b[0m' : `\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`);
  process.exit(failures === 0 ? 0 : 1);
})();

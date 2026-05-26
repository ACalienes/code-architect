'use strict';
/**
 * Observability proof. Seeds representative fleet states into a central store and asserts the
 * re-audited health report + synthesized alerts: isolation violations are CRITICAL, dead-letters
 * warn/critical by age, internal-agent lag is attributed to the drainer while client-repo backlog
 * is attributed to the PROJECTOR, heartbeats drive liveness. Exits non-zero on any failure.
 *
 *   node prototype/shared-layer/health.test.js
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { openDb, subscribe, writeFact } = require('./shared-layer');
const { ingestClaim } = require('./backfill');
const { openProjectionDb } = require('./projection');
const { health, recordHeartbeat, renderHealthText, renderHealthHtml } = require('./health');

let failures = 0;
const check = (label, cond) => {
  console.log(`  ${cond ? '✓' : '✗ FAIL'}  ${label}`);
  if (!cond) failures++;
};
const h = (s) => console.log(`\n\x1b[1m${s}\x1b[0m`);
const isoAgo = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const hasAlert = (hh, code, level) => hh.alerts.some(a => a.code === code && (!level || a.level === level));
const agentOf = (hh, name) => hh.agents.find(a => a.agent === name);
const clientFeedback = (client_id, subject_id) => ({
  fact_type: 'client_feedback', client_id, subject_id, visibility: 'client',
  data_class: 'client_confidential', source_agent: 'test', payload: { subject_id },
});

// ── 1. Healthy: a drained inbox → OK, no critical alerts ──
h('1. Healthy — flow counted, drained inbox, no critical alerts');
{
  const db = openDb();
  subscribe(db, 'acd', 'client_feedback', '*');
  const r = writeFact(db, clientFeedback('dagdc', 'memorial-day'));
  db.prepare("UPDATE deliveries SET status='read' WHERE recipient_agent='acd'").run(); // acd consumed it
  const hh = health(db);
  check('flow counts the fact', hh.flow.facts === 1);
  check('report is OK (no critical)', hh.ok === true);
  check('no alerts', hh.alerts.length === 0);
  check('acd shows idle (nothing pending)', agentOf(hh, 'acd').status === 'idle');
}

// ── 2. Dead-letter present (young) → WARN, still OK ──
h('2. Dead-letter — a fresh dead letter warns but is not critical');
{
  const db = openDb();
  writeFact(db, { fact_type: 'work_order', client_id: 'dagdc', visibility: 'internal', data_class: 'internal', source_agent: 'ca', payload: {} }); // no subscriber → dead_letter
  const hh = health(db);
  check('dead_letter counted', hh.dead_letter.count === 1);
  check('WARN alert raised', hasAlert(hh, 'dead_letter', 'warn'));
  check('still OK (warn is not critical)', hh.ok === true);
}

// ── 3. Stale dead-letter → CRITICAL ──
h('3. Dead-letter — a stale (>1h) dead letter is critical');
{
  const db = openDb();
  db.prepare('INSERT INTO dead_letter (fact_id, reason, ts) VALUES (?, ?, ?)').run('f1', 'no_subscribers', isoAgo(2 * 3600_000));
  const hh = health(db);
  check('stale dead-letter is CRITICAL', hasAlert(hh, 'dead_letter_stale', 'critical'));
  check('report not OK', hh.ok === false);
}

// ── 4. Isolation violation → CRITICAL (the alarm) ──
h('4. Isolation — any cross-client refusal is CRITICAL');
{
  const db = openDb();
  db.prepare('INSERT INTO audit_log (ts, event, detail) VALUES (?, ?, ?)').run(
    new Date().toISOString(), 'projection_refused_cross_client',
    JSON.stringify({ agent: 'dag-repo', clientId: 'dagdc', fact_client: 'tdb' }));
  const hh = health(db);
  check('isolation refusal counted', hh.isolation.refused_count === 1);
  check('CRITICAL alert raised', hasAlert(hh, 'cross_client_refused', 'critical'));
  check('report not OK', hh.ok === false);
}

// ── 5. Internal-agent lag → wedged, attributed to the DRAINER ──
h('5. Lag attribution — an internal agent\'s old backlog blames its drainer');
{
  const db = openDb();
  subscribe(db, 'acd', 'client_feedback', '*');
  writeFact(db, clientFeedback('dagdc', 'old'));
  db.prepare("UPDATE deliveries SET created_at=? WHERE recipient_agent='acd'").run(isoAgo(40 * 60_000)); // 40m old
  const hh = health(db);
  const acd = agentOf(hh, 'acd');
  check('acd is internal', acd.internal === true);
  check('acd status wedged', acd.status === 'wedged');
  check('lag attributed to agent_drainer', acd.lag_attributed_to === 'agent_drainer');
  check('CRITICAL agent_wedged alert', hasAlert(hh, 'agent_wedged', 'critical'));
}

// ── 6. Client-repo backlog → blamed on the PROJECTOR, not the client ──
h('6. Lag attribution — a client repo\'s old backlog blames the projector, not the client');
{
  const db = openDb();
  subscribe(db, 'dag-repo', 'client_feedback', 'dagdc');
  writeFact(db, clientFeedback('dagdc', 'old'));
  db.prepare("UPDATE deliveries SET created_at=? WHERE recipient_agent='dag-repo'").run(isoAgo(40 * 60_000));
  const hh = health(db);
  const dag = agentOf(hh, 'dag-repo');
  check('dag-repo is a client repo', dag.internal === false && dag.clients.includes('dagdc'));
  check('status projector_behind (not wedged)', dag.status === 'projector_behind');
  check('lag attributed to projector', dag.lag_attributed_to === 'projector');
  check('alert is projector_behind, NOT agent_wedged', hasAlert(hh, 'projector_behind') && !hasAlert(hh, 'agent_wedged'));
}

// ── 7. Heartbeat liveness ──
h('7. Liveness — heartbeat drives "runner silent" detection');
{
  const db = openDb();
  subscribe(db, 'acd', 'client_feedback', '*');
  writeFact(db, clientFeedback('dagdc', 'p'));
  db.prepare("UPDATE deliveries SET created_at=? WHERE recipient_agent='acd'").run(isoAgo(20 * 60_000)); // pending, lag warn-ish
  recordHeartbeat(db, 'acd', { pending: 1, lagMs: 0, ticks: 10, wakes: 2 });
  check('heartbeat row written', db.prepare("SELECT COUNT(*) AS n FROM runner_heartbeat WHERE agent='acd'").get().n === 1);
  let hh = health(db);
  check('recent heartbeat → NOT flagged runner_silent', !hasAlert(hh, 'runner_silent'));
  // backdate the heartbeat → silent while work is pending → critical
  db.prepare("UPDATE runner_heartbeat SET ts=? WHERE agent='acd'").run(isoAgo(60 * 60_000));
  hh = health(db);
  check('stale heartbeat + pending → CRITICAL runner_silent', hasAlert(hh, 'runner_silent', 'critical'));
}

// ── 8. Claims backlog warn ──
h('8. Claims — an unreviewed backlog warns (threshold configurable)');
{
  const db = openDb();
  ingestClaim(db, { fact_type: 'decision', subject_id: 'x', visibility: 'internal', data_class: 'internal', source_ref: 'm.md:1', payload: { t: 'a' } });
  const hh = health(db, { claimsWarn: 0 });
  check('claims summarized', hh.claims && hh.claims.quarantined === 1);
  check('WARN claims_backlog raised when over threshold', hasAlert(hh, 'claims_backlog', 'warn'));
}

// ── 9. Renderers ──
h('9. Renderers — text briefing and HTML dashboard');
{
  const db = openDb();
  db.prepare('INSERT INTO audit_log (ts, event, detail) VALUES (?, ?, ?)').run(new Date().toISOString(), 'projection_refused_cross_client', '{"agent":"dag-repo"}');
  const hh = health(db);
  const txt = renderHealthText(hh);
  check('text briefing names the state + a critical alert', /ATTENTION/.test(txt) && /CRITICAL/.test(txt));
  const html = renderHealthHtml(hh);
  check('HTML dashboard is a full doc with the attention banner', /<html/.test(html) && /Attention required/.test(html));
}

// ── 10. A wedged client PROJECTION is caught (central looks fine; the client isn't draining) ──
h('10. No false-OK — a stale client projection (central says projected) raises a CRITICAL');
{
  const db = openDb();
  subscribe(db, 'dag-repo', 'client_feedback', 'dagdc'); // classified as a client repo
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-h-'));
  const file = path.join(tmp, 'inbox.db');
  const pdb = openProjectionDb(file);
  // a fact delivered to dag-repo's projection, still pending, OLD → its drainer is stalled
  pdb.prepare(`INSERT INTO facts (fact_id, fact_type, client_id, visibility, data_class, payload, source_agent, created_at) VALUES (?,?,?,?,?,?,?,?)`)
    .run('f1', 'client_feedback', 'dagdc', 'client', 'client_confidential', '{}', 'x', isoAgo(40 * 60_000));
  pdb.prepare(`INSERT INTO deliveries (delivery_id, fact_id, recipient_agent, scope, kind, status, created_at) VALUES (?,?,?,?,?,?,?)`)
    .run(randomUUID(), 'f1', 'dag-repo', 'dagdc', 'fact', 'pending', isoAgo(40 * 60_000));
  pdb.close();

  const blind = health(db); // no projections passed → central only → looks fine (the bug Codex hit)
  check('central-only health is unaware (would have waved it through)', blind.ok === true);
  const seen = health(db, { projections: [{ agent: 'dag-repo', file }], open: openProjectionDb });
  check('with projection consumption, the wedged client is CRITICAL', hasAlert(seen, 'client_consumer_wedged', 'critical'));
  check('report flips to not-OK', seen.ok === false);
  check('agent status reflects the stalled consumer', agentOf(seen, 'dag-repo').status === 'consumer_wedged');
  fs.rmSync(tmp, { recursive: true, force: true });
}

h(failures === 0 ? '\x1b[32mALL HEALTH INVARIANTS HOLD ✓\x1b[0m' : `\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`);
process.exit(failures === 0 ? 0 : 1);

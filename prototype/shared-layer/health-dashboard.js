'use strict';
/**
 * Emits a live health dashboard from a representative fleet state — the "briefing/dashboard" the
 * design owes (roadmap #5). Demonstrates wiring: seed → re-audit with health() → renderHealthHtml().
 * Writes the HTML next to the other explainers and prints the path + a text briefing.
 *
 *   node prototype/shared-layer/health-dashboard.js
 */
const fs = require('node:fs');
const path = require('node:path');
const { openDb, subscribe, writeFact } = require('./shared-layer');
const { ingestClaim } = require('./backfill');
const { health, recordHeartbeat, renderHealthText, renderHealthHtml } = require('./health');

const isoAgo = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const db = openDb();

// A realistic mixed fleet: internal agents + client repos, with a couple of things going wrong.
subscribe(db, 'acd', 'client_feedback', '*');
subscribe(db, 'nami', 'client_feedback', '*');
subscribe(db, 'dag-repo', 'client_feedback', 'dagdc');
subscribe(db, 'tdb-repo', 'client_feedback', 'tdb');

// healthy traffic, mostly consumed by acd/nami
for (let i = 0; i < 3; i++) {
  writeFact(db, { fact_type: 'client_feedback', client_id: 'dagdc', subject_id: `post-${i}`, visibility: 'client', data_class: 'client_confidential', source_agent: 'dag-repo', payload: {} });
}
db.prepare("UPDATE deliveries SET status='read' WHERE recipient_agent IN ('acd','nami')").run();
db.prepare("UPDATE deliveries SET status='projected' WHERE recipient_agent='dag-repo'").run(); // dag externalized fine

// a TDB fact whose projection is lagging (projector behind)
writeFact(db, { fact_type: 'client_feedback', client_id: 'tdb', subject_id: 'tdb-launch', visibility: 'client', data_class: 'client_confidential', source_agent: 'tdb-repo', payload: {} });
db.prepare("UPDATE deliveries SET created_at=? WHERE recipient_agent='tdb-repo'").run(isoAgo(12 * 60_000));

// an orphan → dead_letter; a quarantined claim; healthy heartbeats for the internal agents
writeFact(db, { fact_type: 'work_order', client_id: 'dagdc', visibility: 'internal', data_class: 'internal', source_agent: 'ca', payload: {} });
ingestClaim(db, { fact_type: 'decision', subject_id: 'backfilled', visibility: 'internal', data_class: 'internal', source_ref: 'memory/session.md:1', payload: { t: 'history' } });
recordHeartbeat(db, 'acd', { pending: 0, lagMs: 0, ticks: 42, wakes: 7, totalHandled: 39 });
recordHeartbeat(db, 'nami', { pending: 0, lagMs: 0, ticks: 41, wakes: 5, totalHandled: 38 });

const hh = health(db);
const out = path.join(__dirname, '..', '..', 'explainers', 'shared-layer-health-2026-05-25.html');
fs.writeFileSync(out, renderHealthHtml(hh));

console.log(renderHealthText(hh));
console.log(`\nDashboard written: ${out}`);

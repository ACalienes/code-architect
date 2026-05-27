'use strict';
/**
 * Wave 2 — connect Code Architect + the two client account-managers (DAG, Dental Boutique).
 *
 * CRITICAL: client managers are walled. dag-repo/tdb-repo subscribe with client_scope = their OWN
 * client_id (dagdc / tdb), NEVER '*'. That single rule is the cubicle isolation boundary — DAG must
 * never receive Dental's facts. code-architect is a fleet-internal agent (client_id null) → scope '*'.
 * client_ids are read from the live identities table (authoritative), not guessed.
 *
 *   node connect-wave2.js [--dry]
 */
const { openDb, subscribe } = require('./shared-layer');
const ALL = ['client_feedback', 'creative_brief', 'decision', 'status_update', 'work_order'];

const PLAN = [
  { agent: 'code-architect', scope: '*',     types: ['decision', 'status_update', 'work_order'] }, // engineering/audit — coordination facts
  { agent: 'dag-repo',       scope: 'dagdc', types: ALL },  // client cubicle — all fact-types, DAG client only
  { agent: 'tdb-repo',       scope: 'tdb',   types: ALL },  // client cubicle — all fact-types, Dental Boutique only
];

const dry = process.argv.includes('--dry');
const db = openDb(process.env.HOME + '/.kameha/kameha-mesh.db');

// Guard: confirm each identity's recorded client_id matches the scope we're about to use (no leak).
for (const p of PLAN) {
  const id = db.prepare('SELECT client_id FROM identities WHERE agent = ?').get(p.agent);
  if (!id) { console.error(`ABORT: ${p.agent} is not an enrolled identity`); process.exit(1); }
  const expect = id.client_id ?? '*';
  if (p.scope !== expect) {
    console.error(`ABORT: ${p.agent} scope mismatch — plan='${p.scope}' but identity.client_id implies '${expect}' (isolation guard)`);
    process.exit(1);
  }
}

const before = db.prepare('SELECT COUNT(*) n FROM subscriptions').get().n;
console.log(`pre-check: ${before} rows; serviced = ` +
  db.prepare('SELECT DISTINCT agent FROM subscriptions ORDER BY agent').all().map(r => r.agent).join(', '));

for (const p of PLAN) for (const t of p.types) {
  if (!dry) subscribe(db, p.agent, t, p.scope);
  console.log(`  ${dry ? 'WOULD ADD' : 'subscribe'}  ${p.agent}  ←  ${t}  (scope ${p.scope})`);
}

if (dry) { console.log('\n[dry] nothing written.'); process.exit(0); }
const after = db.prepare('SELECT COUNT(*) n FROM subscriptions').get().n;
const agents = db.prepare('SELECT DISTINCT agent FROM subscriptions ORDER BY agent').all().map(r => r.agent);
console.log(`\npost-check: ${after} rows (+${after - before}). Board services ${agents.length} agents: ${agents.join(', ')}`);

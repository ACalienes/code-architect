'use strict';
/**
 * Connect agents to The Board = add their subscription rows.
 * board-drainer derives its serviced-agent list live (`SELECT DISTINCT agent FROM subscriptions`),
 * so inserting rows here auto-enrolls each agent on the next 30s tick — no new process, no restart.
 * Idempotent: subscribe() is INSERT OR IGNORE, so re-running is a no-op for existing rows.
 *
 * client_scope='*' is correct ONLY for fleet-internal agents (these). Client-repo agents MUST pass
 * their own client_id as scope — that single rule is the isolation boundary (see shared-layer.js).
 *
 *   node subscribe-agents.js          # apply
 *   node subscribe-agents.js --dry    # print plan, write nothing
 */
const { openDb, subscribe } = require('./shared-layer');

// Role-grounded fact-type mapping for the 6 agents being connected (the trio kai/cfo/enso already on).
// Registry: client_feedback, creative_brief, decision, status_update, work_order.
const PLAN = {
  conductor:        ['decision', 'status_update', 'work_order', 'creative_brief', 'client_feedback'], // project tracker — sees all coordination
  acd:              ['decision', 'work_order', 'creative_brief', 'client_feedback'],                  // Asst. Creative Director
  nami:             ['decision', 'work_order', 'creative_brief'],                                     // Content & Social
  framer:           ['decision', 'work_order', 'creative_brief'],                                     // Visual Production
  'offer-architect':['decision', 'status_update', 'work_order', 'client_feedback'],                   // Pricing/Research
  'lead-engine':    ['decision', 'status_update', 'work_order', 'client_feedback'],                   // Lead Gen/Pipeline
};

const dry = process.argv.includes('--dry');
const db = openDb(process.env.HOME + '/.kameha/kameha-mesh.db');

const before = db.prepare('SELECT COUNT(*) n FROM subscriptions').get().n;
console.log(`pre-check: ${before} subscription rows; serviced agents = ` +
  db.prepare('SELECT DISTINCT agent FROM subscriptions ORDER BY agent').all().map(r => r.agent).join(', '));

let planned = 0;
for (const [agent, types] of Object.entries(PLAN)) {
  for (const t of types) {
    planned++;
    if (!dry) subscribe(db, agent, t, '*');
    console.log(`  ${dry ? 'WOULD ADD' : 'subscribe'}  ${agent}  ←  ${t}  (scope *)`);
  }
}

if (dry) { console.log(`\n[dry] ${planned} rows planned; nothing written.`); process.exit(0); }

const after = db.prepare('SELECT COUNT(*) n FROM subscriptions').get().n;
const agents = db.prepare('SELECT DISTINCT agent FROM subscriptions ORDER BY agent').all().map(r => r.agent);
console.log(`\npost-check: ${after} subscription rows (was ${before}, +${after - before} net new).`);
console.log(`board-drainer now services ${agents.length} agents: ${agents.join(', ')}`);

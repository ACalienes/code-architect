'use strict';
/**
 * Connect-everyone — full mutual awareness on The Board (Alex's goal: every agent contextually
 * aware of the others). Two parts:
 *   (a) ENROLL the live working agents still missing a Board identity (mints Ed25519 keys, 0600),
 *   (b) SUBSCRIBE them + complete the awareness baseline (every fleet agent hears decision + status_update).
 *
 * Credential note (T3): enrollFleet is insert-only — already-enrolled agents are REFUSED, never
 * re-keyed. Private keys are written 0600 and never logged. Client repos are NOT touched here, so the
 * cubicle wall is untouched. nami-bridge (transport) + kmg (phantom, no process) are intentionally excluded.
 *
 *   node connect-everyone.js [--dry]
 */
const { openDb, subscribe } = require('./shared-layer');
const { enrollFleet } = require('./enroll');
const ALL = ['client_feedback', 'creative_brief', 'decision', 'status_update', 'work_order'];
const KEYS_DIR = process.env.HOME + '/.kameha/keystore';

// (a) New fleet-internal identities to mint (live working agents, client_id null → scope '*').
const ENROLL = [
  { agent: 'pitch-deck', clientId: null },
  { agent: 'chronicle',  clientId: null },
];
// (b) Subscriptions to add (scope '*' for all of these — fleet-internal). subscribe() is INSERT OR IGNORE.
const SUBS = {
  'pitch-deck': ALL,                          // order-driven creative engine — full awareness
  'chronicle':  ALL,                          // the historian — hears everything
  'acd':        ['status_update'],            // baseline top-up (already has decision)
  'nami':       ['status_update'],            // baseline top-up
  'framer':     ['status_update'],            // baseline top-up
};

const dry = process.argv.includes('--dry');
const db = openDb(process.env.HOME + '/.kameha/kameha-mesh.db');

const before = db.prepare('SELECT COUNT(*) n FROM subscriptions').get().n;
const idsBefore = db.prepare('SELECT COUNT(*) n FROM identities').get().n;
console.log(`pre-check: ${idsBefore} identities, ${before} subscriptions; serviced = ` +
  db.prepare('SELECT DISTINCT agent FROM subscriptions ORDER BY agent').all().map(r => r.agent).join(', '));

if (dry) {
  console.log('\n[ENROLL] would mint:');
  ENROLL.forEach(e => console.log(`  + identity ${e.agent} (internal, scope *)`));
  console.log('[SUBSCRIBE] would add:');
  for (const [a, ts] of Object.entries(SUBS)) ts.forEach(t => console.log(`  + ${a} ← ${t} (scope *)`));
  console.log('\n[dry] nothing written.'); process.exit(0);
}

// (a) Enroll — insert-only; reports skips for any already present.
const summary = enrollFleet(db, ENROLL, { keysDir: KEYS_DIR });
summary.forEach(s => console.log(s.skipped
  ? `  enroll SKIP ${s.agent}: ${s.reason}`
  : `  enroll OK   ${s.agent} (internal) · pub ${s.pubkey_fp}`));

// (b) Subscribe.
for (const [a, ts] of Object.entries(SUBS)) for (const t of ts) {
  subscribe(db, a, t, '*');
  console.log(`  subscribe   ${a} ← ${t} (scope *)`);
}

const after = db.prepare('SELECT COUNT(*) n FROM subscriptions').get().n;
const idsAfter = db.prepare('SELECT COUNT(*) n FROM identities').get().n;
const agents = db.prepare('SELECT DISTINCT agent FROM subscriptions ORDER BY agent').all().map(r => r.agent);
console.log(`\npost-check: ${idsAfter} identities (+${idsAfter - idsBefore}), ${after} subscriptions (+${after - before}).`);
console.log(`Board services ${agents.length} agents: ${agents.join(', ')}`);

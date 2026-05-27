'use strict';
/**
 * Subscribe every board agent to the new coordination fact types (objective, question, task).
 * Fleet-internal agents (client_id null) → scope '*' (broad fan-out, like decision/status_update).
 * Client managers (dag-repo, tdb-repo) → scope = their own client_id (the wall holds — they only get
 * objectives/questions/tasks scoped to their client). Derived from the identities table, so it's
 * self-correct. Excludes mesh-adapter (bridge) and chronicle (off-board, personal health domain).
 *
 *   node connect-newtypes.js [--dry]
 */
const { openDb, subscribe } = require('./shared-layer');
const NEW_TYPES = ['objective', 'question', 'task'];
const EXCLUDE = new Set(['mesh-adapter', 'chronicle']);

const dry = process.argv.includes('--dry');
const db = openDb(process.env.HOME + '/.kameha/kameha-mesh.db');

const ids = db.prepare('SELECT agent, client_id FROM identities ORDER BY agent').all().filter(r => !EXCLUDE.has(r.agent));
const before = db.prepare('SELECT COUNT(*) n FROM subscriptions').get().n;

for (const id of ids) {
  const scope = id.client_id || '*';
  for (const t of NEW_TYPES) {
    if (!dry) subscribe(db, id.agent, t, scope);
    console.log(`  ${dry ? 'WOULD' : 'sub'}  ${id.agent} ← ${t} (scope ${scope})`);
  }
}
const after = db.prepare('SELECT COUNT(*) n FROM subscriptions').get().n;
console.log(dry ? `\n[dry] would add for ${ids.length} agents × ${NEW_TYPES.length} types` : `\nsubscriptions ${before} → ${after} (+${after - before}) across ${ids.length} agents`);

'use strict';
/**
 * Seed The Board with project context = give agents shared context.
 * Reads the ACTIVE projects from Conductor (the project store) and posts each as a
 * status_update fact, attributed to `conductor` (Conductor folds in as the project tracker).
 * Routes to every agent subscribed to status_update. Idempotent-ish: re-running adds fresh posts.
 *
 *   node seed-board.js
 */
const { DatabaseSync } = require('node:sqlite');
const { openDb, writeFact } = require('./shared-layer');

const c = new DatabaseSync(process.env.HOME + '/.kameha/conductor.db', { readOnly: true });
const projs = c.prepare("SELECT name, client_slug, type, stage FROM projects WHERE status = 'active' ORDER BY stage DESC").all();
const b = openDb(process.env.HOME + '/.kameha/kameha-mesh.db');

let ok = 0, routed = 0;
for (const p of projs) {
  const r = writeFact(b, {
    fact_type: 'status_update', visibility: 'internal', data_class: 'internal',
    source_agent: 'conductor', subject_type: 'project', subject_id: p.client_slug,
    payload: { status: 'active · stage ' + p.stage + '/10', detail: p.name + ' — ' + String(p.type).replace(/_/g, ' ') },
  });
  if (r.ok) { ok++; routed += (r.routed || 0); }
  else console.log('REJECT', p.client_slug, r.error);
}
console.log('seeded ' + ok + ' active-project facts; total deliveries routed: ' + routed);

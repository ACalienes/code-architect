'use strict';
/**
 * Enrich the seeded project facts with the REAL detail Conductor holds — scope + the current
 * retainer cycle's open deliverables — so the ledger shows specifics ("DAG: monthly content
 * calendar — submit for approval"), not just a project name. Updates the existing status_update
 * facts in place (no re-routing churn); the board-ledger reads payload.detail.
 *
 *   node enrich-board.js [--dry]
 */
const { DatabaseSync } = require('node:sqlite');
const dry = process.argv.includes('--dry');

const c = new DatabaseSync(process.env.HOME + '/.kameha/conductor.db', { readOnly: true });
const b = new DatabaseSync(process.env.HOME + '/.kameha/kameha-mesh.db'); // read-write

const projs = c.prepare("SELECT id, name, client_slug, type, stage, scope_description FROM projects WHERE status = 'active'").all();
const cyclesFor = c.prepare("SELECT month, deliverables FROM retainer_cycles WHERE project_id = ? ORDER BY month").all.bind(c.prepare("SELECT month, deliverables FROM retainer_cycles WHERE project_id = ? ORDER BY month"));

const buildDetail = (p) => {
  const parts = [];
  if (p.scope_description) parts.push(p.scope_description.replace(/\s+/g, ' ').trim().slice(0, 240));
  const cycles = cyclesFor(p.id);
  if (cycles.length) {
    const latest = cycles[cycles.length - 1];
    let dels = []; try { dels = JSON.parse(latest.deliverables || '[]'); } catch (_) {}
    const open = dels.filter(d => d.status && d.status !== 'completed').map(d => d.title);
    if (open.length) parts.push(`Open this cycle (${latest.month}): ${open.join('; ')}`);
  }
  return parts.join('  ·  ');
};

const findFact = b.prepare("SELECT fact_id FROM facts WHERE subject_id = ? AND fact_type = 'status_update' AND source_agent = 'conductor' AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1");
const upd = b.prepare("UPDATE facts SET payload = ? WHERE fact_id = ?");

let done = 0, miss = 0;
for (const p of projs) {
  const row = findFact.get(p.client_slug);
  if (!row) { miss++; continue; }
  const detail = buildDetail(p) || (p.name + ' — ' + String(p.type).replace(/_/g, ' '));
  const payload = JSON.stringify({ status: `active · stage ${p.stage}/10`, detail, project: p.name });
  if (dry) { console.log(`WOULD enrich ${p.client_slug}:\n    ${detail.slice(0, 160)}`); done++; continue; }
  upd.run(payload, row.fact_id);
  done++;
  if (p.client_slug.includes('dag')) console.log(`✓ ${p.client_slug}\n    detail: ${detail}`);
}
console.log(`\n${dry ? '[dry] ' : ''}enriched ${done} project facts (${miss} had no matching board fact).`);

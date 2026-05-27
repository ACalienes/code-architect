'use strict';
/**
 * Conductor → The Board auto-sync. The first emit hook: an always-on watcher that turns real
 * Conductor changes into Board posts, so the ledger fills on its own (no manual posting).
 *
 * How: each tick it snapshots Conductor (active projects + their retainer-cycle deliverables),
 * diffs against the last saved snapshot, and posts ONLY what changed as plain-English status_update
 * facts. First run = silent baseline (no dump). Value-based diff (ignores timestamp churn) keeps it
 * quiet. DAG updates are client-scoped (route to the DAG manager too); others are internal.
 *
 *   pm2 start board-sync.js --name board-sync
 *
 * Reads conductor.db (read-only); writes kameha-mesh.db via the shared-layer facade.
 */
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const { openDb, writeFact } = require('./shared-layer');

const HOME = process.env.HOME;
const CDB = HOME + '/.kameha/conductor.db';
const STATE = HOME + '/.kameha/board-sync-state.json';
const INTERVAL = 30000;

const cdb = new DatabaseSync(CDB, { readOnly: true });   // long-lived reader; WAL → sees latest commits
const bdb = openDb(HOME + '/.kameha/kameha-mesh.db');    // shared-layer board db (WAL + busy_timeout)

const loadState = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch (_) { return null; } };
const saveState = s => { const tmp = STATE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(s)); fs.renameSync(tmp, STATE); };

function snapshot() {
  const projects = cdb.prepare("SELECT id, name, client_slug, type, status, stage FROM projects WHERE status = 'active'").all();
  const state = { projects: {}, cycles: {} };
  for (const p of projects) {
    state.projects[p.id] = { stage: p.stage, status: p.status, name: p.name, slug: p.client_slug };
    const cycles = cdb.prepare('SELECT month, deliverables FROM retainer_cycles WHERE project_id = ?').all(p.id);
    for (const cy of cycles) {
      let dels = []; try { dels = JSON.parse(cy.deliverables || '[]'); } catch (_) {}
      const key = p.id + '::' + cy.month;
      state.cycles[key] = {};
      for (const d of dels) if (d && d.title) state.cycles[key][d.title] = d.status || 'todo';
    }
  }
  return state;
}

const prettyStatus = s => s === 'completed' ? 'done ✓'
  : (s === 'in-progress' || s === 'in_progress') ? 'now in progress'
  : s === 'blocked' ? 'blocked' : `now “${s}”`;

function diffAndEmit(prev, cur) {
  const emits = [];
  const slugOf = id => (cur.projects[id] || prev.projects[id] || {}).slug || id;
  const nameOf = id => (cur.projects[id] || prev.projects[id] || {}).name || id;

  // Projects: new, stage change, status change.
  for (const id in cur.projects) {
    const c = cur.projects[id], p = prev.projects[id];
    if (!p) { emits.push({ slug: c.slug, detail: `new project added — “${c.name}” (stage ${c.stage}/10)` }); continue; }
    if (c.stage !== p.stage) emits.push({ slug: c.slug, detail: `advanced to stage ${c.stage} of 10 (was ${p.stage})` });
    if (c.status !== p.status) emits.push({ slug: c.slug, detail: `status changed to “${c.status}” (was “${p.status}”)` });
  }
  // Projects that left the active set (completed/archived).
  for (const id in prev.projects) if (!cur.projects[id]) emits.push({ slug: prev.projects[id].slug, detail: `“${prev.projects[id].name}” is no longer active (completed or archived)` });

  // Cycles: new cycle, deliverable status change.
  for (const key in cur.cycles) {
    const month = key.split('::')[1], pid = key.split('::')[0];
    const curD = cur.cycles[key], prevD = (prev.cycles || {})[key];
    if (!prevD) { const n = Object.keys(curD).length; emits.push({ slug: slugOf(pid), detail: `opened the ${month} cycle (${n} deliverable${n !== 1 ? 's' : ''})` }); continue; }
    for (const title in curD) if (curD[title] !== prevD[title] && prevD[title] !== undefined) emits.push({ slug: slugOf(pid), detail: `${month}: “${title}” — ${prettyStatus(curD[title])}` });
  }

  for (const e of emits) {
    const client_id = /dag/.test(e.slug) ? 'dagdc' : null;
    writeFact(bdb, { fact_type: 'status_update', visibility: 'internal', data_class: 'internal',
      client_id, source_agent: 'conductor', subject_type: 'project', subject_id: e.slug,
      payload: { status: 'update', detail: e.detail } });
  }
  return emits.length;
}

function tick() {
  try {
    const cur = snapshot();
    const prev = loadState();
    if (!prev) { saveState(cur); console.log(`[board-sync] baseline set (${Object.keys(cur.projects).length} active projects) — will post changes from here`); return; }
    const n = diffAndEmit(prev, cur);
    saveState(cur);
    if (n) console.log(`[board-sync] posted ${n} Conductor change(s) to The Board`);
  } catch (e) { console.error('[board-sync] tick error:', e.message); }
}

tick();
setInterval(tick, INTERVAL);
console.log('[board-sync] watching Conductor → posting changes to The Board every 30s');

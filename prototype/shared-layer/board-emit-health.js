'use strict';
/**
 * board-emit-health — Phase-1 boardroom emitter: watch the system of record itself.
 *
 * Now that the boardroom is the SoR, something has to notice when a board process dies, flaps, or an
 * agent's inbox backs up — the exact failure mode (board-emit-cfo flapping) that prompted the pivot.
 * This emitter reads PM2 process health + per-agent mesh backlog and emits `health_alert` facts on
 * STATE TRANSITIONS (newly-broken → fire once; recovered → fire an info once). It does NOT re-emit a
 * standing alert every cycle — transition-only, so the Board isn't spammed.
 *
 * Same two write modes as the other emitters:
 *   - LOCAL  (default): writes kameha-mesh.db via the shared-layer facade.
 *   - REMOTE (BOARD_URL set): POSTs through the gateway via board-post.js.
 *
 *   node board-emit-health.js --dry-run
 *   node board-emit-health.js --once
 *   pm2 start ecosystem.config.js --only board-emit-health        # (entry added after review)
 *
 * The decision logic (evaluateHealth) is PURE + injectable → fully unit-tested with fixtures, no PM2/DB.
 */
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const HOME = process.env.HOME;
const STATE = path.join(HOME, '.kameha', 'board-emit-health-state.json');
const INTERVAL = 60000;
const DRY = process.argv.includes('--dry-run');
const ONCE = process.argv.includes('--once');
const WATCH = process.argv.includes('--watch');
const REMOTE = process.env.BOARD_URL || null;
const THRESHOLDS = {
  backlog: Number(process.env.HEALTH_BACKLOG_MAX) || 50,   // an agent's pending inbox over this → warn
  flapping: Number(process.env.HEALTH_FLAP_DELTA) || 5,    // restart-count jump within one cycle → warn
};
// Processes we don't alert on being "stopped" (deliberately paused per the boardroom pivot 2026-05-30).
const PAUSED_OK = new Set((process.env.HEALTH_PAUSED_OK || 'kai-bot,kai-dashboard').split(',').map(s => s.trim()).filter(Boolean));
// Drained sink for health_alert. A subscriber MUST exist or route() writes a dead_letter, which health.js
// counts as warn / critical-after-1h — i.e. an emitted alert would poison the SoR health signal (Codex).
// board-listener auto-enrolls + drains every subscribed agent, so this sink never accumulates pending rows.
const SINK_AGENT = process.env.HEALTH_SINK_AGENT || 'health-log';

// ── PURE CORE ───────────────────────────────────────────────────────────────────────────────────
/**
 * Decide which health_alert facts to emit THIS cycle, transition-only.
 *   procs    : [{ name, status, restarts }]           (from pm2 jlist)
 *   backlogs : [{ agent, pending }]                   (per-agent mesh inbox depth)
 *   prev     : { restarts:{name:count}, active:{key:true} }   (carried from last cycle)
 *   thresholds, pausedOk
 * Returns { fire:[alert…], state:{restarts,active} }. Each alert has a stable `key` = `${subject}:${condition}`.
 */
function evaluateHealth({ procs = [], backlogs = [], prev = {}, thresholds = THRESHOLDS, pausedOk = PAUSED_OK }) {
  const prevActive = (prev && prev.active) || {};
  const prevRestarts = (prev && prev.restarts) || {};
  const current = new Map();   // key → alert (the set of conditions firing right now)

  for (const p of procs) {
    if (!p || !p.name) continue;
    if (p.status !== 'online' && !pausedOk.has(p.name)) {
      const key = `${p.name}:process_down`;
      current.set(key, { key, severity: 'critical', subject: p.name, condition: 'process_down', source: 'pm2',
        detail: `process '${p.name}' is ${p.status}` });
    }
    const delta = (p.restarts || 0) - (prevRestarts[p.name] != null ? prevRestarts[p.name] : (p.restarts || 0));
    if (delta >= thresholds.flapping) {
      const key = `${p.name}:flapping`;
      current.set(key, { key, severity: 'warn', subject: p.name, condition: 'flapping', source: 'pm2',
        detail: `process '${p.name}' restarted ${delta}× in one cycle`, metric: 'restart_delta', value: String(delta), threshold: String(thresholds.flapping) });
    }
  }
  for (const b of backlogs) {
    if (!b || !b.agent) continue;
    if ((b.pending || 0) > thresholds.backlog) {
      const key = `${b.agent}:backlog`;
      current.set(key, { key, severity: 'warn', subject: b.agent, condition: 'backlog', source: 'mesh',
        detail: `agent '${b.agent}' has ${b.pending} pending deliveries`, metric: 'pending', value: String(b.pending), threshold: String(thresholds.backlog) });
    }
  }

  const fire = [];
  // Newly-active conditions → fire once.
  for (const [key, alert] of current) if (!prevActive[key]) fire.push(alert);
  // Conditions that WERE active and no longer are → fire a recovery info once. The recovery key carries
  // the FULL cleared key (`<subject>:<condition>:recovered`) so two conditions clearing for the SAME
  // subject in one tick don't collide on idempotency (Codex r2 LOW/MED).
  for (const key of Object.keys(prevActive)) {
    if (!current.has(key)) {
      const [subject] = key.split(':');
      fire.push({ key: `${key}:recovered`, severity: 'info', subject, condition: 'recovered', source: 'pm2',
        detail: `'${key}' cleared` });
    }
  }

  const state = { restarts: Object.fromEntries(procs.map(p => [p.name, p.restarts || 0])),
    active: Object.fromEntries([...current.keys()].map(k => [k, true])) };
  return { fire, state };
}

/**
 * After emitting, undo state advances for any newly-fired alert whose emit FAILED, so it re-fires next
 * cycle instead of being permanently suppressed (Codex r2 HIGH + r3 flapping case). Two kinds:
 *  - persistent conditions (process_down/backlog): drop from `state.active` so they re-fire while active.
 *  - flapping: delta-based against `state.restarts`, which evaluateHealth ALREADY advanced to the current
 *    count. A failed flapping emit must roll that baseline BACK to `prev` — otherwise next cycle's delta is
 *    0 and the alert never retries (Codex r3). Recovery keys aren't in `active`, so they're untouched here.
 *   results : [{ key, ok }] ; prev : last-cycle state (for the restart baseline)
 */
function reconcileActive(state, results, prev = {}) {
  const prevRestarts = (prev && prev.restarts) || {};
  for (const r of results) {
    if (r.ok) continue;
    if (state.active[r.key]) delete state.active[r.key];
    if (r.key.endsWith(':flapping')) {
      const name = r.key.slice(0, -':flapping'.length);
      if (prevRestarts[name] != null) state.restarts[name] = prevRestarts[name];   // roll baseline back → delta re-fires
    }
  }
  return state;
}

// ── IMPURE SHELL ──────────────────────────────────────────────────────────────────────────────────
const loadState = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch (_) { return { restarts: {}, active: {} }; } };
const saveState = s => { const t = STATE + '.tmp'; fs.writeFileSync(t, JSON.stringify(s)); fs.renameSync(t, STATE); };

function gatherProcs() {
  try {
    const j = JSON.parse(cp.execSync('pm2 jlist', { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
    return j.map(p => ({ name: p.name, status: p.pm2_env && p.pm2_env.status, restarts: p.pm2_env && p.pm2_env.restart_time }));
  } catch (e) { console.error(`[emit-health] pm2 jlist failed: ${e.message}`); return null; }
}
function gatherBacklogs() {
  // pendingStats(db, agent) needs a per-agent bind (Codex r2 HIGH — calling it with no agent threw and
  // silently returned [], so backlog alerts never fired). Do the per-agent rollup in one GROUP BY instead.
  try {
    const { openDb } = require('./shared-layer');
    const db = openDb(path.join(HOME, '.kameha', 'kameha-mesh.db'));
    return db.prepare(
      "SELECT recipient_agent AS agent, COUNT(*) AS pending FROM deliveries WHERE status = 'pending' GROUP BY recipient_agent"
    ).all();
  } catch (e) { console.error(`[emit-health] backlog read skipped: ${e.message}`); return []; }
}

let _postFact, _writeFact, _openDb, _token;
async function emitAlert(alert, occurredAt) {
  const payload = { severity: alert.severity, subject: alert.subject, condition: alert.condition };
  for (const k of ['detail', 'metric', 'value', 'threshold', 'source']) if (alert[k] != null) payload[k] = alert[k];
  const fact = { fact_type: 'health_alert', visibility: 'internal', data_class: 'internal',
    subject_type: 'infra', subject_id: alert.subject, payload };
  const idk = `health:${alert.key}:${occurredAt}`;   // occurredAt discriminates re-occurrences after recovery
  if (REMOTE) {
    if (!_postFact) { ({ postFact: _postFact } = require('./board-post'));
      _token = (process.env.BOARD_TOKEN || fs.readFileSync(path.join(HOME, '.kameha', 'board-gateway.tokens', 'health'), 'utf8')).trim(); }
    const r = await _postFact({ url: REMOTE, token: _token, idempotencyKey: idk, fact });
    return r.status === 200;
  }
  if (!_writeFact) ({ openDb: _openDb, writeFact: _writeFact } = require('./shared-layer'));
  const db = _openDb(path.join(HOME, '.kameha', 'kameha-mesh.db'));
  return _writeFact(db, { ...fact, client_id: null, source_agent: 'health' }).ok;
}

async function tick() {
  const procs = gatherProcs();
  if (!procs) return;                                   // pm2 unreadable → skip cycle, don't churn state
  const backlogs = gatherBacklogs();
  const prev = loadState();
  const { fire, state } = evaluateHealth({ procs, backlogs, prev });
  if (DRY) { console.log(`[emit-health] DRY — ${fire.length} transition(s):`); fire.forEach(a => console.log(`  • [${a.severity}] ${a.key} — ${a.detail}`)); return; }
  const occurredAt = new Date().toISOString();
  const results = [];
  for (const a of fire) {
    let ok = false;
    try { ok = await emitAlert(a, occurredAt); } catch (e) { console.error(`[emit-health] emit failed for ${a.key}: ${e.message}`); }
    results.push({ key: a.key, ok });
  }
  // Don't persist a newly-fired alert as "active" if its emit failed — else a missing token / gateway 5xx
  // would suppress a persistent alert until it clears and reoccurs (Codex r2 HIGH). Failed → re-fires next cycle.
  saveState(reconcileActive(state, results, prev));
  const posted = results.filter(r => r.ok).length;
  if (fire.length) console.log(`[emit-health] ${posted}/${fire.length} health_alert(s) emitted${REMOTE ? ' (gateway)' : ''}`);
}

/**
 * Guarantee the health_alert sink is subscribed, so emitted alerts ROUTE (and board-listener drains them)
 * instead of dead-lettering (which poisons health.js). Idempotent: subscribe() is INSERT OR IGNORE.
 * Encoded in the emitter (not a manual deploy step) so a fresh deploy is self-healing + the guarantee is
 * visible to review. LOCAL mode owns the DB directly; REMOTE mode assumes the sink is seeded server-side.
 */
function ensureSink() {
  try {
    const { openDb, subscribe } = require('./shared-layer');
    const db = openDb(path.join(HOME, '.kameha', 'kameha-mesh.db'));
    subscribe(db, SINK_AGENT, 'health_alert', '*');
    return true;
  } catch (e) { console.error(`[emit-health] ensureSink failed: ${e.message}`); return false; }
}

module.exports = { evaluateHealth, reconcileActive, ensureSink };

if (require.main === module) {
  if (!REMOTE && !DRY) ensureSink();   // self-heal the sink subscription before the first emit
  tick().catch(e => console.error('[emit-health] error:', e.message));
  if ((WATCH || (!ONCE && !DRY)) && !DRY) {
    setInterval(() => tick().catch(e => console.error('[emit-health] tick error:', e.message)), INTERVAL);
    console.log(`[emit-health] watching pm2 + mesh backlog → ${REMOTE ? 'gateway ' + REMOTE : 'local DB'}, every ${INTERVAL / 1000}s`);
  }
}

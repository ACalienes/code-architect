'use strict';
/**
 * Observability — Shared Layer hardening roadmap increment #5.
 * Code Architect · 2026-05-25.
 *
 * Principle: observability is RE-AUDIT, not telemetry-trust. The authoritative picture (backlog,
 * dead-letters, isolation violations) is read straight from the central store — never from a
 * runner's claim that it delivered something (per "the receiver's word is not load-bearing;
 * reality is what re-audit shows"). Runners may only assert *liveness* via an optional heartbeat;
 * health() folds that in for "is the consumer alive", never for "what got delivered".
 *
 * What it surfaces, in priority order:
 *   1. ISOLATION violations — any projection_refused_cross_client event is CRITICAL (the alarm the
 *      whole system exists to protect).
 *   2. Dead-letter queue — count + age + by-reason (the silent-failure indicator).
 *   3. Per-agent backlog/lag, CLASSIFIED + ATTRIBUTED: an internal agent's pending = its drainer
 *      falling behind; a client repo's pending = the PROJECTOR behind (the client isn't at fault).
 *   4. Liveness (heartbeat / drained-audit) and a claims-queue summary.
 *
 * Output: a structured object (for a dashboard/JSON) whose `alerts[]` is the synthesized
 * "what needs attention now", plus renderHealthText()/renderHealthHtml() for briefing + dashboard.
 */

const now = () => new Date().toISOString();
const ms = () => Date.now();
const tableExists = (db, name) =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);

const HEARTBEAT_SCHEMA = `
CREATE TABLE IF NOT EXISTS runner_heartbeat (
  agent         TEXT PRIMARY KEY,
  ts            TEXT NOT NULL,
  pending       INTEGER,
  lag_ms        INTEGER,
  ticks         INTEGER, wakes INTEGER,
  total_handled INTEGER, total_failed INTEGER, total_dead_lettered INTEGER
);`;

function ensureHeartbeatTable(db) { db.exec(HEARTBEAT_SCHEMA); }

/** Liveness only: a runner publishes its snapshot (e.g. via createDrainer onTick). */
function recordHeartbeat(db, agent, s = {}) {
  ensureHeartbeatTable(db);
  db.prepare(`INSERT OR REPLACE INTO runner_heartbeat
    (agent, ts, pending, lag_ms, ticks, wakes, total_handled, total_failed, total_dead_lettered)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    agent, now(), s.pending ?? null, s.lagMs ?? null, s.ticks ?? null, s.wakes ?? null,
    s.totalHandled ?? null, s.totalFailed ?? null, s.totalDeadLettered ?? null);
}

const DEFAULTS = (interval) => ({
  interval,
  lagWarnMs: 5 * interval,        // a few minutes behind → warn
  lagCritMs: 30 * interval,       // way behind → critical
  deadLetterCritAgeMs: 3600_000,  // a dead letter older than 1h → critical
  silentCritMs: 10 * interval,    // a runner that should be draining but hasn't reported → wedged
  claimsWarn: 50,                 // unreviewed claim backlog
});

// classify each subscribed agent: internal ('*' scope, cross-client) vs client repo (own client only)
function classifyAgents(db) {
  const rows = db.prepare('SELECT agent, client_scope FROM subscriptions').all();
  const map = new Map();
  for (const r of rows) {
    const a = map.get(r.agent) || { agent: r.agent, internal: false, clients: new Set() };
    if (r.client_scope === '*') a.internal = true; else a.clients.add(r.client_scope);
    map.set(r.agent, a);
  }
  return [...map.values()].map(a => ({ agent: a.agent, internal: a.internal, clients: [...a.clients] }));
}

// last time we have evidence an agent consumed: heartbeat ts, or a 'drained' audit (drain() path).
function lastSeen(db, agent, hb) {
  let t = hb && hb.ts ? Date.parse(hb.ts) : 0;
  if (tableExists(db, 'audit_log')) {
    // fallback for agents on the drain() path (which audits 'drained'); runner peek/ack don't audit
    const row = db.prepare(
      "SELECT MAX(ts) AS ts FROM audit_log WHERE event='drained' AND detail LIKE ?"
    ).get(`%"agent":"${agent}"%`);
    if (row && row.ts) t = Math.max(t, Date.parse(row.ts));
  }
  return t || null;
}

/**
 * Re-audit the store into a health report.
 * @param db central shared-layer db.
 * @param {object} [opts] { interval, thresholds…, projections:[{agent,file,open}] }
 *   projections: optional — to read each client's OWN file for true consumption lag (otherwise a
 *   client's central backlog is reported as projector lag only). open: (file)=>db, injected so
 *   health.js needn't depend on projection.js.
 */
function health(db, opts = {}) {
  const t = { ...DEFAULTS(opts.interval ?? 60000), ...opts };
  const alerts = [];
  const add = (level, code, message) => alerts.push({ level, code, message });

  // ── flow counts ──
  const factCount = db.prepare('SELECT COUNT(*) AS n FROM facts').get().n;
  const revoked = db.prepare('SELECT COUNT(*) AS n FROM facts WHERE revoked_at IS NOT NULL').get().n;
  const byStatus = {};
  for (const r of db.prepare('SELECT status, COUNT(*) AS n FROM deliveries GROUP BY status').all()) byStatus[r.status] = r.n;

  // ── dead-letter ──
  const dl = db.prepare('SELECT COUNT(*) AS n, MIN(ts) AS oldest FROM dead_letter').get();
  const dlByReason = {};
  for (const r of db.prepare('SELECT reason, COUNT(*) AS n FROM dead_letter GROUP BY reason').all()) dlByReason[r.reason] = r.n;
  const dlAge = dl.oldest ? ms() - Date.parse(dl.oldest) : 0;
  const dead_letter = { count: dl.n, oldest_ts: dl.oldest, age_ms: dlAge, by_reason: dlByReason };
  if (dl.n > 0) {
    if (dlAge > t.deadLetterCritAgeMs) add('critical', 'dead_letter_stale', `dead-letter queue: ${dl.n} item(s), oldest ${fmtDur(dlAge)} old — investigate`);
    else add('warn', 'dead_letter', `dead-letter queue: ${dl.n} item(s) (oldest ${fmtDur(dlAge)})`);
  }

  // ── ISOLATION (the alarm) ──
  let isoEvents = [];
  if (tableExists(db, 'audit_log')) {
    isoEvents = db.prepare("SELECT ts, detail FROM audit_log WHERE event='projection_refused_cross_client' ORDER BY ts DESC LIMIT 20")
      .all().map(r => ({ ts: r.ts, ...safeParse(r.detail) }));
  }
  const isolation = { refused_count: isoEvents.length, events: isoEvents };
  if (isoEvents.length > 0)
    add('critical', 'cross_client_refused', `ISOLATION: ${isoEvents.length} cross-client delivery attempt(s) refused — investigate immediately`);

  // ── per-agent backlog/lag, classified + attributed ──
  const heartbeats = tableExists(db, 'runner_heartbeat')
    ? Object.fromEntries(db.prepare('SELECT * FROM runner_heartbeat').all().map(h => [h.agent, h]))
    : {};
  const agents = [];
  for (const a of classifyAgents(db)) {
    const p = db.prepare("SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM deliveries WHERE recipient_agent=? AND status='pending'").get(a.agent);
    const lag = p.oldest ? ms() - Date.parse(p.oldest) : 0;
    const attribution = a.internal ? 'agent_drainer' : 'projector';
    const hb = heartbeats[a.agent];
    const seen = lastSeen(db, a.agent, hb);
    const silentMs = seen ? ms() - seen : null;

    // optional: read the client's OWN projection file for true consumption lag
    let consumption = null;
    if (!a.internal && opts.projections) {
      const proj = opts.projections.find(x => x.agent === a.agent);
      if (proj && proj.file && opts.open) {
        try {
          const pdb = opts.open(proj.file);
          const cp = pdb.prepare("SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM deliveries WHERE recipient_agent=? AND status='pending'").get(a.agent);
          consumption = { pending: cp.n, lag_ms: cp.oldest ? ms() - Date.parse(cp.oldest) : 0 };
          pdb.close && pdb.close();
        } catch (_) { /* file not yet created — leave null */ }
      }
    }

    let status = 'healthy';
    if (p.n === 0) status = 'idle';
    else if (lag >= t.lagCritMs) status = a.internal ? 'wedged' : 'projector_behind';
    else if (lag >= t.lagWarnMs) status = a.internal ? 'lagging' : 'projector_lagging';

    agents.push({ agent: a.agent, internal: a.internal, clients: a.clients, pending: p.n,
      oldest_pending_at: p.oldest, lag_ms: lag, lag_attributed_to: attribution,
      last_seen_ms_ago: silentMs, consumption, status });

    if (p.n > 0 && lag >= t.lagCritMs) {
      if (a.internal) add('critical', 'agent_wedged', `agent ${a.agent}: drain lag ${fmtDur(lag)} (${p.n} pending) — drainer behind`);
      else add('critical', 'projector_behind', `projector behind for ${a.agent} [${a.clients.join(',')}]: ${fmtDur(lag)}, ${p.n} not externalized`);
    } else if (p.n > 0 && lag >= t.lagWarnMs) {
      add('warn', a.internal ? 'agent_lagging' : 'projector_lagging',
        `${a.internal ? 'agent' : 'projector for'} ${a.agent}: ${fmtDur(lag)} behind (${p.n} pending)`);
    }
    // liveness: only flag "wedged-silent" when there IS work pending AND we have evidence of silence
    if (p.n > 0 && silentMs !== null && silentMs > t.silentCritMs)
      add('critical', 'runner_silent', `agent ${a.agent}: last seen ${fmtDur(silentMs)} ago but ${p.n} pending — runner may be down`);
  }

  // ── claims ──
  let claims = null;
  if (tableExists(db, 'claims')) {
    claims = {};
    for (const r of db.prepare('SELECT status, COUNT(*) AS n FROM claims GROUP BY status').all()) claims[r.status] = r.n;
    if ((claims.quarantined || 0) > t.claimsWarn) add('warn', 'claims_backlog', `${claims.quarantined} claims awaiting review`);
  }

  alerts.sort((a, b) => (a.level === b.level ? 0 : a.level === 'critical' ? -1 : 1));
  return {
    generated_at: now(),
    ok: alerts.filter(a => a.level === 'critical').length === 0,
    flow: { facts: factCount, revoked, deliveries: byStatus },
    agents, dead_letter, isolation, claims, alerts,
  };
}

function safeParse(s) { try { return JSON.parse(s || '{}'); } catch (_) { return {}; } }
function fmtDur(msv) {
  if (msv == null) return 'n/a';
  const s = Math.round(msv / 1000);
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  return `${Math.round(m / 60)}h`;
}

// ── renderers ──────────────────────────────────────────────────────────────────────────────
function renderHealthText(hh) {
  const L = [];
  L.push(`Shared Layer health · ${hh.generated_at} · ${hh.ok ? 'OK' : 'ATTENTION'}`);
  L.push(`flow: ${hh.flow.facts} facts (${hh.flow.revoked} revoked) · deliveries ${JSON.stringify(hh.flow.deliveries)}`);
  if (hh.alerts.length === 0) L.push('alerts: none');
  else for (const a of hh.alerts) L.push(`  [${a.level.toUpperCase()}] ${a.message}`);
  L.push('agents:');
  for (const a of hh.agents)
    L.push(`  ${a.agent} (${a.internal ? 'internal' : 'client:' + a.clients.join(',')}) — ${a.status}, ${a.pending} pending, lag ${fmtDur(a.lag_ms)} [${a.lag_attributed_to}]`);
  L.push(`dead_letter: ${hh.dead_letter.count} (oldest ${fmtDur(hh.dead_letter.age_ms)})`);
  L.push(`isolation refused: ${hh.isolation.refused_count}`);
  return L.join('\n');
}

function renderHealthHtml(hh) {
  const C = { critical: '#f87171', warn: '#facc15', ok: '#4ade80' };
  const esc = (x) => String(x).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const stColor = (s) => /wedged|behind/.test(s) ? C.critical : /lag/.test(s) ? C.warn : s === 'idle' ? '#7d8a99' : C.ok;
  const alertRows = hh.alerts.length
    ? hh.alerts.map(a => `<div class="alert ${a.level}"><span class="lvl">${a.level}</span>${esc(a.message)}</div>`).join('')
    : `<div class="alert ok"><span class="lvl">ok</span>nothing needs attention</div>`;
  const agentRows = hh.agents.map(a => `<tr>
    <td class="mono">${esc(a.agent)}</td><td>${a.internal ? 'internal' : 'client:' + esc(a.clients.join(','))}</td>
    <td><span class="pill" style="color:${stColor(a.status)};border-color:${stColor(a.status)}">${esc(a.status)}</span></td>
    <td class="mono">${a.pending}</td><td class="mono">${fmtDur(a.lag_ms)}</td><td class="dim">${esc(a.lag_attributed_to)}</td></tr>`).join('');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Shared Layer health · ${hh.generated_at}</title><style>
:root{--bg:#0a0d12;--card:#141a23;--bg2:#0f131a;--border:#232c3a;--text:#e6edf3;--text2:#b8c5d3;--muted:#7d8a99;--dim:#5a6573;--green:#4ade80;--red:#f87171;--yellow:#facc15;--accent:#6ea8fe;}
*{box-sizing:border-box;margin:0;padding:0}body{background:var(--bg);color:var(--text);font-family:-apple-system,"SF Pro Text",sans-serif;line-height:1.55;padding:40px 24px 80px}
.wrap{max-width:960px;margin:0 auto}.mono{font-family:"JetBrains Mono","SF Mono",monospace}
.eyebrow{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:2px;color:var(--green);margin-bottom:12px}
h1{font-size:34px;letter-spacing:-0.8px;margin-bottom:6px}.sub{color:var(--muted);font-size:13px;margin-bottom:28px}
.banner{border-radius:12px;padding:16px 20px;margin-bottom:24px;font-weight:700;font-size:16px;border:1px solid}
.banner.ok{background:rgba(74,222,128,0.08);border-color:rgba(74,222,128,0.4);color:var(--green)}
.banner.bad{background:rgba(248,113,113,0.08);border-color:rgba(248,113,113,0.45);color:var(--red)}
.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:28px}@media(max-width:760px){.grid{grid-template-columns:repeat(2,1fr)}}
.stat{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:14px 16px}
.stat .l{font-size:10px;text-transform:uppercase;letter-spacing:1px;color:var(--muted);margin-bottom:6px}
.stat .v{font-size:24px;font-weight:700;font-family:"JetBrains Mono",monospace}
h2{font-size:12px;text-transform:uppercase;letter-spacing:1.5px;color:var(--text2);border-bottom:1px solid var(--border);padding-bottom:8px;margin:28px 0 14px}
.alert{border-radius:8px;padding:10px 14px;margin-bottom:8px;font-size:14px;background:var(--card);border:1px solid var(--border);display:flex;gap:12px;align-items:baseline}
.alert .lvl{font-family:"JetBrains Mono",monospace;font-size:10px;text-transform:uppercase;letter-spacing:1px;padding:2px 7px;border-radius:5px;font-weight:700}
.alert.critical{border-color:rgba(248,113,113,0.45)}.alert.critical .lvl{background:rgba(248,113,113,0.18);color:var(--red)}
.alert.warn{border-color:rgba(250,204,21,0.4)}.alert.warn .lvl{background:rgba(250,204,21,0.15);color:var(--yellow)}
.alert.ok .lvl{background:rgba(74,222,128,0.15);color:var(--green)}
table{width:100%;border-collapse:collapse;font-size:13px}th{text-align:left;color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:1px;padding:8px 10px;border-bottom:1px solid var(--border)}
td{padding:9px 10px;border-bottom:1px solid var(--border);color:var(--text2)}
.pill{font-size:11px;font-weight:700;border:1px solid;border-radius:20px;padding:2px 10px}.dim{color:var(--dim)}
.foot{margin-top:36px;padding-top:18px;border-top:1px solid var(--border);font-size:11px;color:var(--dim)}
</style></head><body><div class="wrap">
<div class="eyebrow">Code Architect · Shared Layer · live health</div>
<h1>Fleet health</h1><div class="sub mono">re-audited from the central store · ${hh.generated_at}</div>
<div class="banner ${hh.ok ? 'ok' : 'bad'}">${hh.ok ? '● All clear — no critical alerts' : '● Attention required — ' + hh.alerts.filter(a => a.level === 'critical').length + ' critical'}</div>
<div class="grid">
  <div class="stat"><div class="l">Facts</div><div class="v">${hh.flow.facts}</div></div>
  <div class="stat"><div class="l">Pending</div><div class="v">${hh.flow.deliveries.pending || 0}</div></div>
  <div class="stat"><div class="l">Dead-letter</div><div class="v" style="color:${hh.dead_letter.count ? C.yellow : C.green}">${hh.dead_letter.count}</div></div>
  <div class="stat"><div class="l">Isolation refused</div><div class="v" style="color:${hh.isolation.refused_count ? C.red : C.green}">${hh.isolation.refused_count}</div></div>
</div>
<h2>Alerts</h2>${alertRows}
<h2>Agents</h2><table><thead><tr><th>Agent</th><th>Kind</th><th>Status</th><th>Pending</th><th>Lag</th><th>Attributed to</th></tr></thead><tbody>${agentRows}</tbody></table>
<div class="foot mono">Shared Layer health · observability is re-audit, not telemetry-trust · liveness via heartbeat only.</div>
</div></body></html>`;
}

module.exports = { health, recordHeartbeat, ensureHeartbeatTable, renderHealthText, renderHealthHtml };

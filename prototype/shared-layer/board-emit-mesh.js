'use strict';
/**
 * Mesh → Board bridge. The mesh-api carries the agents' REAL talk (work orders, requests, replies);
 * this surfaces the SEMANTIC ones onto the Board as `work_order` / `question` / `decision` / status,
 * with the recipient as `subject_id` so the ledger reads as conversation. Posts as each sending
 * agent (per-agent token via the gateway — no spoofing). Mechanical polling (`query_*`, heartbeats)
 * is filtered out — it's ~99.9% of mesh volume but isn't conversation.
 *
 *   node board-emit-mesh.js --dry-run
 *   BOARD_URL=http://100.64.114.13:3351 node board-emit-mesh.js --emit-all   # backfill last 72h
 *   EMIT_SINCE_HOURS=24 ...                                                  # tighter window
 *   pm2 start board-emit-mesh.js --name board-emit-mesh -- --watch
 */
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');   // built-in; mesh.db is WAL → safe concurrent reader alongside mesh-api
const lib = require('./board-emit-lib');
const HOME = lib.HOME;

const URL = process.env.BOARD_URL || 'http://100.64.114.13:3351';
const DRY = process.argv.includes('--dry-run');
const WATCH = process.argv.includes('--watch');
const EMIT_ALL = process.argv.includes('--emit-all');
const SINCE_HOURS = Number(process.env.EMIT_SINCE_HOURS || 72);
const STATE = path.join(HOME, '.kameha', 'board-emit-mesh.state.json');
const MESH_DB = process.env.MESH_DB || path.join(HOME, 'kai', 'logs', 'mesh.db');
const INTERVAL = 60000;

// Noise filter: actions that are mechanical polling, registration, heartbeats — NOT conversation.
const NOISE = /(^query_|heartbeat|^poll|health|^ping$|^sync_|^register_|^fetch_|^list_|^get_|^search_|^ack$|presence|brand_bible|positioning)/i;
const SKIP_FROM = new Set(['chronicle']);   // off-board per design

const niceAction = a => String(a || '').replace(/[_-]/g, ' ');
function detailFromPayload(p, action) {
  let o = {}; try { o = JSON.parse(p || '{}'); } catch (_) {}
  return o.summary || o.title || o.detail || o.text || o.content || o.task || o.message || niceAction(action);
}

function classify(msg) {
  const a = msg.action.toLowerCase();
  const detail = lib.clip(detailFromPayload(msg.payload, msg.action));
  if (/^work_order(?!_complete)|implementation_request|^send_/.test(a))
    return { fact_type: 'work_order', payload: { task: detail, priority: msg.priority === 'critical' || msg.priority === 'high' ? 'high' : (msg.priority === 'low' ? 'low' : 'med') } };
  if (/_request$|^pricing_request|^question/.test(a))
    return { fact_type: 'question', payload: { detail } };
  if (/_complete$|^response$/.test(a) || msg.status === 'completed')
    return { fact_type: 'status_update', payload: { status: 'done', detail: `reply: ${detail}` } };
  if (/alert/.test(a))   return { fact_type: 'status_update', payload: { status: 'alert', detail } };
  if (/cancel/.test(a))  return { fact_type: 'status_update', payload: { status: 'canceled', detail } };
  if (/decision/.test(a))return { fact_type: 'decision', payload: { text: detail } };
  if (/update/.test(a))  return { fact_type: 'status_update', payload: { status: 'update', detail } };
  return { fact_type: 'status_update', payload: { status: 'update', detail } };
}

const keep = m => !NOISE.test(m.action) && !SKIP_FROM.has(m.from_agent);

async function tick() {
  let db; try { db = new DatabaseSync(MESH_DB, { readOnly: true }); }
  catch (e) { console.error(`[mesh-bridge] cannot open ${MESH_DB}: ${e.message}`); return; }
  let rows;
  try {
    rows = db.prepare(
      `SELECT message_id, created_at, from_agent, to_agent, action, status, priority, payload
         FROM messages
        WHERE created_at > datetime('now', ?)
        ORDER BY created_at ASC`
    ).all(`-${SINCE_HOURS} hours`);
  } finally { db.close(); }

  const prev = lib.loadSeen(STATE);
  const baseline = !prev && !EMIT_ALL;
  const seen = prev || new Set();

  if (baseline) {
    for (const m of rows) seen.add(m.message_id);
    if (!DRY) lib.saveSeen(STATE, seen);
    console.log(`[mesh-bridge] baseline (${rows.length} msgs in last ${SINCE_HOURS}h)`);
    return;
  }

  // group by sender so we look up each token once
  const buckets = new Map();
  for (const m of rows) {
    if (seen.has(m.message_id)) continue;
    if (!keep(m)) { seen.add(m.message_id); continue; }
    const c = classify(m);
    const ev = { key: 'mesh:' + m.message_id, idem: lib.idemKey('mesh', m.message_id),
      fact: { fact_type: c.fact_type, visibility: 'internal', data_class: 'internal',
        subject_type: 'agent', subject_id: m.to_agent || 'unknown', payload: c.payload },
      _msgId: m.message_id, _from: m.from_agent };
    let arr = buckets.get(m.from_agent); if (!arr) buckets.set(m.from_agent, arr = []); arr.push(ev);
  }

  if (DRY) {
    const total = [...buckets.values()].reduce((n, a) => n + a.length, 0);
    console.log(`[mesh-bridge] would post ${total} (kept) of ${rows.length} (scanned, last ${SINCE_HOURS}h)`);
    let shown = 0;
    for (const [from, arr] of buckets) {
      for (const e of arr.slice(0, 4)) {
        const d = e.fact.payload.detail || e.fact.payload.task || e.fact.payload.text || '';
        console.log(`    • ${from} → ${e.fact.subject_id} [${e.fact.fact_type}] "${lib.clip(d, 60)}"`);
        if (++shown >= 14) return;
      }
    }
    return;
  }

  let posted = 0, quarantined = 0, pending = 0;
  for (const [from, arr] of buckets) {
    if (!arr.length) continue;
    let token; try { token = lib.readToken(from); }
    catch (_) { console.error(`[mesh-bridge] no token for '${from}' — ${arr.length} skipped`); continue; }
    if (!(await lib.healthGate(URL, { onLog: () => {} }))) { console.error('[mesh-bridge] gateway not writable'); break; }
    const r = await lib.postEvents(arr, { url: URL, token, agent: from, onLog: m => console.error(`[mesh-bridge] ${from}: ${m}`) });
    for (const e of arr) if (r.settled.has(e.key)) seen.add(e._msgId);
    posted += r.posted; quarantined += r.quarantined; pending += r.pending;
  }
  lib.saveSeen(STATE, seen);
  if (posted || quarantined || pending) console.log(`[mesh-bridge] ${posted} posted, ${quarantined} quarantined, ${pending} pending (scanned ${rows.length}, kept ${rows.filter(keep).length})`);
}

tick().catch(e => console.error('[mesh-bridge] error:', e.message));
if (WATCH && !DRY) {
  setInterval(() => tick().catch(e => console.error('[mesh-bridge] tick:', e.message)), INTERVAL);
  console.log(`[mesh-bridge] watching ${MESH_DB} → ${URL}, every ${INTERVAL / 1000}s`);
}

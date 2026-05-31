'use strict';
/**
 * CFO → The Board semantic emit hook. The second emit hook (after board-sync for Conductor).
 *
 * Reads CFO's own output READ-ONLY (no edits to the CFO repo) and posts meaningful financial events
 * (alerts CFO raised, invoices/payments CFO drafted, books closed) — semantic, not raw tool activity.
 * First run = silent baseline. Two write modes:
 *   - LOCAL (default): writes kameha-mesh.db directly via the shared-layer facade (Mini-side use).
 *   - REMOTE (BOARD_URL set): POSTs through the Board write gateway ("the door") via board-post.js —
 *     so the hook can run on the LAPTOP, where the real CFO work is, and reach the Mini Board over
 *     Tailscale. Per-event idempotency keys mean re-runs never double-post. Token: BOARD_TOKEN env or
 *     ~/.kameha/board-gateway.tokens/cfo. (The gateway sets source_agent from the token — we don't send it.)
 *
 *   node board-emit-cfo.js --dry-run                          # preview, write nothing
 *   BOARD_URL=http://100.64.114.13:3351 node board-emit-cfo.js --emit-all   # laptop → Board via the door
 *   EMIT_SKIP_ALERTS=1 ...                                    # post only drafts/closes (alert already on Board)
 *   pm2 start board-emit-cfo.js --name board-emit-cfo -- --watch
 *
 * CFO repo location is env-configurable: CFO_DIR (default ~/Desktop/Code/CFO).
 */
const fs = require('node:fs');
const path = require('node:path');

const HOME = process.env.HOME;
const CFO_DIR = process.env.CFO_DIR || path.join(HOME, 'Desktop', 'Code', 'CFO');
const STATE = path.join(HOME, '.kameha', 'board-emit-cfo-state.json');
const INTERVAL = 30000;

const DRY = process.argv.includes('--dry-run');
const WATCH = process.argv.includes('--watch');
const EMIT_ALL = process.argv.includes('--emit-all');
const SKIP_ALERTS = !!process.env.EMIT_SKIP_ALERTS;
const REMOTE = process.env.BOARD_URL || null;

// Lazy deps: local mode needs the DB facade; remote mode needs the gateway client + a token.
let _writeFact, _openDb, _postFact, _token;
function localDb() {
  if (!_openDb) ({ openDb: _openDb, writeFact: _writeFact } = require('./shared-layer'));
  return _openDb(path.join(HOME, '.kameha', 'kameha-mesh.db'));
}
function remoteSetup() {
  if (_postFact) return;
  ({ postFact: _postFact } = require('./board-post'));
  _token = (process.env.BOARD_TOKEN || fs.readFileSync(path.join(HOME, '.kameha', 'board-gateway.tokens', 'cfo'), 'utf8')).trim();
}

const loadState = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch (_) { return null; } };
const saveState = s => { const tmp = STATE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(s)); fs.renameSync(tmp, STATE); };
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; } };
const walk = (dir, hits = []) => {
  let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return hits; }
  for (const e of ents) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p, hits); else if (e.isFile() && e.name.endsWith('.json')) hits.push(p); }
  return hits;
};
const titleFromFile = f => path.basename(f, '.json').replace(/[-_]/g, ' ');

/** The CURRENT set of semantic events from CFO's state. */
function collect() {
  const events = [];
  if (!SKIP_ALERTS) {
    const outbox = readJson(path.join(CFO_DIR, 'docs', 'shared', 'outbox-cfo.json'));
    const alerts = ((outbox && outbox.messages) || []).filter(m => m.summary);
    const latest = alerts[alerts.length - 1];
    if (latest) events.push({ key: 'alert-state:' + latest.summary, subject: 'financial-alert', detail: `${latest.severity ? `[${latest.severity}] ` : ''}current financial alerts — ${latest.summary}` });
  }
  // `ref` = the draft's CFO_DIR-relative path. Carried into the fact payload as `draft_ref` (Phase 3,
  // §12.3) so a supervisor approval can name EXACTLY which draft was approved — all cfo-draft facts
  // otherwise share subject_id 'cfo-draft'. The idempotency key is unchanged, so this never re-posts.
  for (const f of walk(path.join(CFO_DIR, 'logs', 'drafts'))) events.push({ key: 'draft:' + path.relative(CFO_DIR, f), subject: 'cfo-draft', ref: path.relative(CFO_DIR, f), detail: `drafted ${titleFromFile(f)}` });
  for (const f of walk(path.join(CFO_DIR, 'logs', 'closes'))) events.push({ key: 'close:' + path.relative(CFO_DIR, f), subject: 'cfo-close', detail: `closed the books: ${titleFromFile(f)}` });
  return events;
}

// Codex #1: an event is "settled" (safe to mark seen) ONLY on a 200, or on a PERMANENT rejection
// (quarantined — retrying a malformed event forever is pointless). TRANSIENT failures (network, 5xx,
// 429) stay PENDING so the next tick retries them — a gateway blip must never silently lose an event.
const PERMANENT = new Set([400, 401, 403, 409, 422]);
const QUARANTINE = path.join(HOME, '.kameha', 'board-emit-quarantine.ndjson');
function quarantine(agent, e, reason) {
  try { fs.appendFileSync(QUARANTINE, JSON.stringify({ ts: new Date().toISOString(), agent, key: e.key, subject: e.subject, detail: e.detail, reason }) + '\n'); } catch (_) {}
}

/** Emit one event. Returns 'ok' | 'permanent' | 'transient'. */
async function emitOne(e, db) {
  const payload = { status: 'update', detail: e.detail };
  if (e.ref) payload.draft_ref = e.ref;   // §12.3 — lets a supervisor approval resolve the exact draft file
  const fact = { fact_type: 'status_update', visibility: 'internal', data_class: 'internal', subject_type: 'finance', subject_id: e.subject, payload };
  if (REMOTE) {
    let r;
    try { r = await _postFact({ url: REMOTE, token: _token, idempotencyKey: 'cfo:' + e.key, fact }); }
    catch (err) { console.error(`[emit-cfo] network error: ${err.message}`); return 'transient'; }
    if (r.status === 200) return 'ok';
    console.error(`[emit-cfo] gateway ${r.status}: ${r.error || ''}`);
    return PERMANENT.has(r.status) ? 'permanent' : 'transient';
  }
  return _writeFact(db, { ...fact, client_id: null, source_agent: 'cfo' }).ok ? 'ok' : 'permanent';
}

/** Returns { settled: keys to mark seen, posted, quarantined, pending }. */
async function emitMany(events) {
  if (REMOTE) remoteSetup();
  const db = REMOTE ? null : localDb();
  const settled = []; let posted = 0, quarantined = 0, pending = 0;
  for (const e of events) {
    const res = await emitOne(e, db);
    if (res === 'ok') { settled.push(e.key); posted++; }
    else if (res === 'permanent') { quarantine('cfo', e, 'permanent_reject'); settled.push(e.key); quarantined++; }
    else pending++;   // transient → NOT settled → retried next tick (no silent loss)
  }
  return { settled, posted, quarantined, pending };
}
const mergeSeen = (prev, settled) => Array.from(new Set([...((prev && prev.seen) || []), ...settled]));

async function tick() {
  const cur = collect();
  if (EMIT_ALL) {
    if (DRY) return previewAll(cur);
    const r = await emitMany(cur);
    saveState({ seen: mergeSeen(loadState(), r.settled) });   // only settled marked seen — transient failures retry
    console.log(`[emit-cfo] --emit-all (${REMOTE ? 'via gateway ' + REMOTE : 'local'}): ${r.posted} posted, ${r.quarantined} quarantined, ${r.pending} pending(retry) of ${cur.length}`);
    return;
  }
  const prev = loadState();
  if (!prev) {
    if (!DRY) saveState({ seen: cur.map(e => e.key) });
    console.log(`[emit-cfo] baseline set (${cur.length} existing) — posting NEW from here${DRY ? ' [DRY]' : ''}`);
    if (DRY) previewAll(cur);
    return;
  }
  const seen = new Set(prev.seen || []);
  const fresh = cur.filter(e => !seen.has(e.key));
  if (DRY) return previewAll(fresh);
  if (!fresh.length) return;
  const r = await emitMany(fresh);
  saveState({ seen: mergeSeen(prev, r.settled) });   // failed-transient fresh events stay un-seen → retried next tick
  if (r.posted || r.quarantined || r.pending) console.log(`[emit-cfo] ${r.posted} posted, ${r.quarantined} quarantined, ${r.pending} pending${REMOTE ? ' (gateway)' : ''}`);
}

function previewAll(list) {
  console.log(`\n=== DRY-RUN: ${list.length} CFO event(s) that would post ${REMOTE ? '(via gateway)' : '(local)'} ===`);
  for (const e of list.slice(0, 25)) console.log(`  • CFO · ${e.subject}: "${e.detail}"`);
  if (list.length > 25) console.log(`  … and ${list.length - 25} more`);
}

tick().catch(e => console.error('[emit-cfo] error:', e.message));
if (WATCH && !DRY) {
  setInterval(() => tick().catch(e => console.error('[emit-cfo] tick error:', e.message)), INTERVAL);
  console.log(`[emit-cfo] watching CFO (${CFO_DIR}) → ${REMOTE ? 'gateway ' + REMOTE : 'local DB'}, every 30s`);
}

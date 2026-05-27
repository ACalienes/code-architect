'use strict';
/**
 * Generic OUTBOX emitter — serves any agent that writes docs/shared/outbox-<x>.json. Each config
 * entry is isolated (own token, own state file, own try/catch) so one bad agent can't wedge the others
 * (Codex #5). Explicit per-type payload builders — an unmapped message.type is QUARANTINED, never
 * silently coerced (Codex #6). Posts through the gateway with settle/quarantine + health-gate (#1,#2).
 *
 *   node board-emit-outbox.js --dry-run
 *   BOARD_URL=http://100.64.114.13:3351 node board-emit-outbox.js --emit-all   # seed the ledger
 *   EMIT_RECENT=6 ...                                                          # only the N newest per agent
 *   pm2 start board-emit-outbox.js --name board-emit-outbox -- --watch
 */
const fs = require('node:fs');
const path = require('node:path');
const lib = require('./board-emit-lib');
const HOME = lib.HOME;

const URL = process.env.BOARD_URL || 'http://100.64.114.13:3351';   // gateway binds the tailnet IP, NOT loopback (Codex #2)
const DRY = process.argv.includes('--dry-run');
const WATCH = process.argv.includes('--watch');
const EMIT_ALL = process.argv.includes('--emit-all');
const RECENT = process.env.EMIT_RECENT ? Number(process.env.EMIT_RECENT) : null;   // cap newest-N when seeding
const INTERVAL = 30000;

// type → registry-valid fact builder. Keys here are the allowlist; anything else → quarantine.
const BUILDERS = {
  status_update: m => ({ fact_type: 'status_update', payload: { status: 'update', detail: lib.clip(m.summary || m.content) } }),
  decision:      m => ({ fact_type: 'decision',      payload: { text: lib.clip(m.summary || m.content) } }),
  alert:         m => ({ fact_type: 'status_update', payload: { status: m.severity || 'alert', detail: lib.clip(m.summary || m.content) } }),
  info:          m => ({ fact_type: 'status_update', payload: { status: 'info', detail: lib.clip(m.summary || m.content) } }),
  question:      m => ({ fact_type: 'question',      payload: { detail: lib.clip(m.summary || m.content) } }),
};

const CONFIG = [
  { agent: 'offer-architect', dir: path.join(HOME, 'Desktop/Code/Offer Architect and Pricing Strategist'), outbox: 'docs/shared/outbox-pitch.json' },
  { agent: 'pitch-deck',      dir: path.join(HOME, 'Desktop/Code/Kameha Pitch Deck Engine'),                outbox: 'docs/shared/outbox-pitch.json' },
];

async function runOne(c) {
  const stateFile = path.join(HOME, '.kameha', `board-emit-outbox-${c.agent}.state.json`);
  let token; try { token = lib.readToken(c.agent); } catch (_) { console.error(`[outbox] ${c.agent}: no token enrolled — skip`); return; }
  let outbox; try { outbox = JSON.parse(fs.readFileSync(path.join(c.dir, c.outbox), 'utf8')); } catch (_) { console.error(`[outbox] ${c.agent}: no outbox file — skip`); return; }

  let msgs = (outbox.messages || []).filter(m => m && m.timestamp);
  msgs.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
  if (RECENT) msgs = msgs.slice(-RECENT);

  const prev = lib.loadSeen(stateFile);
  const baseline = !prev && !EMIT_ALL;        // first ever run (not seeding) = silent baseline
  const seen = prev || new Set();
  const keyOf = m => 'outbox:' + m.timestamp + ':' + (m.type || '');

  if (baseline) {
    for (const m of msgs) seen.add(keyOf(m));
    if (!DRY) lib.saveSeen(stateFile, seen);
    console.log(`[outbox] ${c.agent}: baseline (${msgs.length} msgs) — posting new from here`);
    return;
  }

  const events = [];
  for (const m of msgs) {
    const key = keyOf(m);
    if (seen.has(key)) continue;
    const type = m.type || 'status_update';
    const build = BUILDERS[type];
    const detail = m.summary || m.content || '';
    if (!build) { lib.quarantine(c.agent, { key, type, summary: lib.clip(m.summary) }, 'unknown_type'); seen.add(key); continue; }
    if (lib.looksSecret(detail)) { lib.quarantine(c.agent, { key, type }, 'looks_secret'); seen.add(key); continue; }
    const built = build(m);
    events.push({
      key,
      idem: lib.idemKey(`${c.agent}:outbox`, m.timestamp + ':' + type),
      fact: { fact_type: built.fact_type, visibility: 'internal', data_class: 'internal', subject_type: 'note', subject_id: `${c.agent}-${type}`, payload: built.payload },
    });
  }

  if (DRY) {
    console.log(`[outbox] ${c.agent}: would post ${events.length}`);
    events.slice(0, 6).forEach(e => console.log(`    • ${e.fact.fact_type}: "${lib.clip(e.fact.payload.detail || e.fact.payload.text, 64)}"`));
    return;
  }
  if (!events.length) return;
  if (!(await lib.healthGate(URL, { onLog: m => console.error(`[outbox] ${c.agent}: ${m}`) }))) {
    console.error(`[outbox] ${c.agent}: gateway not writable — ${events.length} left pending`); return;
  }
  const r = await lib.postEvents(events, { url: URL, token, agent: c.agent, onLog: m => console.error(`[outbox] ${c.agent}: ${m}`) });
  for (const e of events) if (r.settled.has(e.key)) seen.add(e.key);
  lib.saveSeen(stateFile, seen);
  console.log(`[outbox] ${c.agent}: ${r.posted} posted, ${r.quarantined} quarantined, ${r.pending} pending`);
}

async function tick() {
  for (const c of CONFIG) { try { await runOne(c); } catch (e) { console.error(`[outbox] ${c.agent}: ${e.message}`); } }  // per-config isolation
}

tick().catch(e => console.error('[outbox] error:', e.message));
if (WATCH && !DRY) {
  setInterval(() => tick().catch(e => console.error('[outbox] tick error:', e.message)), INTERVAL);
  console.log(`[outbox] watching ${CONFIG.map(c => c.agent).join(', ')} → ${URL}, every 30s`);
}

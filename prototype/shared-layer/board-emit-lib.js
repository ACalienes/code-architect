'use strict';
/**
 * Shared helpers for the Board emit hooks — the Codex-v2-vetted logic in one place so every emitter
 * inherits it (board-emit-coverage plan §v2 fold):
 *   - settle/quarantine: never lose an event (200 → settled; permanent 4xx → quarantine+settled;
 *     transient → pending/retry). [#1]
 *   - healthGate: idle until the gateway is writable. [#2]
 *   - idemKey: bounded sha256 key (under the gateway's 200-char cap; stable id ⇒ no rename re-post). [#4]
 *   - content minimization: clip + secret scan; payloads carry metadata, never bodies. [#8]
 */
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { postFact } = require('./board-post');

const HOME = process.env.HOME;
const QUARANTINE = path.join(HOME, '.kameha', 'board-emit-quarantine.ndjson');
const PERMANENT = new Set([400, 401, 403, 409, 422]);

const sha = s => createHash('sha256').update(String(s)).digest('hex');
const idemKey = (kind, canonicalId) => `${kind}:${sha(canonicalId).slice(0, 40)}`;   // bounded + rename-stable
const clip = (s, n = 220) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
// light secret guard — never put anything key-shaped on the Board (HB#9)
const SECRET = /(sk-[A-Za-z0-9]{12,}|AKIA[0-9A-Z]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|eyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,})/;
const looksSecret = s => SECRET.test(String(s || ''));

const loadSeen = f => { try { return new Set(JSON.parse(fs.readFileSync(f, 'utf8')).seen || []); } catch (_) { return null; } };
const saveSeen = (f, set) => { const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify({ seen: [...set] })); fs.renameSync(t, f); };
function quarantine(agent, rec, reason) { try { fs.appendFileSync(QUARANTINE, JSON.stringify({ ts: new Date().toISOString(), agent, reason, ...rec }) + '\n'); } catch (_) {} }

async function healthGate(url, { tries = 8, onLog = () => {} } = {}) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url.replace(/\/+$/, '') + '/health'); const j = await r.json(); if (j && j.writable) return true; } catch (_) {}
    onLog(`gateway not writable yet (${i + 1}/${tries})`);
    await new Promise(r => setTimeout(r, 800 * (i + 1)));
  }
  return false;
}

/**
 * Post a batch of pre-built events. events: [{ key, idem, fact }] (fact already minimized by caller).
 * Returns { posted, quarantined, pending, settled:Set<key> }. Only 'settled' keys are safe to mark seen.
 */
async function postEvents(events, { url, token, agent, onLog = () => {} }) {
  const settled = new Set(); let posted = 0, quarantined = 0, pending = 0;
  for (const e of events) {
    let r;
    try { r = await postFact({ url, token, idempotencyKey: e.idem, fact: e.fact }); }
    catch (err) { pending++; onLog(`net error: ${err.message}`); continue; }
    if (r.status === 200) { settled.add(e.key); posted++; }
    else if (PERMANENT.has(r.status)) { quarantine(agent, { key: e.key, detail: e.fact.payload && (e.fact.payload.detail || e.fact.payload.text), status: r.status, error: r.error }, 'permanent_reject'); settled.add(e.key); quarantined++; }
    else { pending++; onLog(`gateway ${r.status}: ${r.error || ''}`); }
  }
  return { posted, quarantined, pending, settled };
}

const readToken = agent => fs.readFileSync(path.join(HOME, '.kameha', 'board-gateway.tokens', agent), 'utf8').trim();

module.exports = { HOME, sha, idemKey, clip, looksSecret, loadSeen, saveSeen, quarantine, healthGate, postEvents, readToken };

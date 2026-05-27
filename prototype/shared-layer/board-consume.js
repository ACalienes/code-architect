'use strict';
/**
 * board-consume — the consumption half of The Board (Phase 1: acknowledgement).
 *
 * STATUS: Phase-1 scaffold. Design-stable parts only. This module reads an agent's inbox and
 * produces two files — the agent's absorbed-log (what it took in) and its ack-file (what it
 * confirms). It does NOT touch kameha-mesh.db: the ack-FOLD (UPDATE deliveries SET status='acked')
 * is done by the single-writer board-drainer loop, and that piece is held pending the Codex review
 * of the design (single-writer integrity is exactly what's under review). Until the fold lands, this
 * produces ack-files that nothing consumes yet — inert by design.
 *
 * Why files, not direct DB writes (§2.1, the non-negotiable): N agents writing kameha-mesh.db
 * directly is what caused "database is locked". Agents only ever READ their own ndjson inbox and
 * WRITE their own ack-file; a single writer folds acks into the DB. No contention.
 *
 * Why ack-after-log (§2.2): the absorbed-log append happens BEFORE the ack append, so an ack can
 * never claim absorption that didn't happen. Proof comes from the agent, not the mailman.
 *
 *   const { consume } = require('./board-consume');
 *   consume('kai');                 // daemons loop this; CA (single-shot) calls once at session start
 *   node board-consume.js kai       // CLI form
 */
const fs = require('node:fs');
const path = require('node:path');

const HOME = process.env.HOME;
const INBOX_DIR    = path.join(HOME, '.kameha', 'board-inbox');
const ACKS_DIR     = path.join(HOME, '.kameha', 'board-acks');
const ABSORBED_DIR = path.join(HOME, '.kameha', 'board-absorbed');

/** Read an ndjson file into parsed objects, skipping blank or torn (unparseable) lines.
 *  A partially-written trailing line from a concurrent append must never throw. */
function readNdjson(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const out = [];
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch (_) { /* torn/partial line — skip */ }
  }
  return out;
}

/** Already-acked delivery_ids for this agent (idempotency: re-runs don't double-ack). */
function ackedSet(agent) {
  const set = new Set();
  for (const a of readNdjson(path.join(ACKS_DIR, agent + '.ndjson'))) {
    if (a && a.delivery_id) set.add(a.delivery_id);
  }
  return set;
}

/**
 * Consume one agent's inbox: for each not-yet-acked delivery, append the fact to the agent's
 * absorbed-log, then append the ack. Idempotent. Returns a small summary for observability.
 *
 * @param {string} agent
 * @param {object} [opts]
 * @param {(fact:object)=>void} [opts.onAbsorb] hook for a live daemon to also write the fact into
 *        its native working memory instead of (or as well as) the flat absorbed-log.
 */
function consume(agent, opts = {}) {
  fs.mkdirSync(ACKS_DIR, { recursive: true });
  fs.mkdirSync(ABSORBED_DIR, { recursive: true });

  const inbox = readNdjson(path.join(INBOX_DIR, agent + '.ndjson'));
  const acked = ackedSet(agent);
  const absorbedFile = path.join(ABSORBED_DIR, agent + '.ndjson');
  const acksFile     = path.join(ACKS_DIR, agent + '.ndjson');

  let consumed = 0, skippedNoId = 0, alreadyAcked = 0;
  // dedup within this run too (an inbox can legitimately carry the same delivery once; guard anyway)
  const seen = new Set();
  for (const item of inbox) {
    const id = item && item.delivery_id;
    if (!id) { skippedNoId++; continue; }           // pre-migration inbox lines have no delivery_id
    if (acked.has(id) || seen.has(id)) { alreadyAcked++; continue; }
    seen.add(id);

    // 1) log what we absorbed (BEFORE the ack — the ack must never outrun the logging)
    const absorbedRow = {
      absorbed_at: new Date().toISOString(), agent,
      delivery_id: id, fact_id: item.fact_id, kind: item.kind,
      fact_type: item.fact_type, subject_id: item.subject_id, payload: item.payload,
    };
    fs.appendFileSync(absorbedFile, JSON.stringify(absorbedRow) + '\n');
    if (typeof opts.onAbsorb === 'function') {
      try { opts.onAbsorb(absorbedRow); } catch (_) { /* native-memory hook is best-effort */ }
    }

    // 2) emit the ack (folded into deliveries.status='acked' by the single-writer drainer — pending)
    const ackRow = {
      acked_at: new Date().toISOString(), acked_by: agent,
      delivery_id: id, fact_id: item.fact_id, logged: true,
    };
    fs.appendFileSync(acksFile, JSON.stringify(ackRow) + '\n');
    consumed++;
  }
  return { agent, consumed, alreadyAcked, skippedNoId, inboxLines: inbox.length };
}

module.exports = { consume, readNdjson };

if (require.main === module) {
  const agent = process.argv[2];
  if (!agent) { console.error('usage: node board-consume.js <agent>'); process.exit(2); }
  const r = consume(agent);
  console.log(`[consume] ${r.agent}: ${r.consumed} newly absorbed+acked, ${r.alreadyAcked} already acked, ` +
    `${r.skippedNoId} skipped (no delivery_id), of ${r.inboxLines} inbox lines`);
}

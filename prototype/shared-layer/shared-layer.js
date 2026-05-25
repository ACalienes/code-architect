'use strict';
/**
 * The Shared Layer — reference prototype.
 * Code Architect · 2026-05-25 · proves the Codex-hardened v2 design.
 *
 * What this demonstrates (the hard parts Codex flagged):
 *  - B1 structural isolation: agents read ONLY their own router-written
 *    `deliveries`; they never touch the `facts` table. The router is the only
 *    writer of deliveries, and it enforces per-client scope — so a fact can
 *    never reach an agent it wasn't scoped to, even by accident.
 *  - B2/S6 write-preflight: unknown fact_type or a client fact missing its
 *    client_id is rejected BEFORE durable write (not discovered later).
 *  - B3 router writes per-recipient deliveries from scoped subscriptions.
 *  - R1 fail-closed: an unroutable fact goes to dead_letter, never silently dropped.
 *  - G19 retraction: revoking a fact issues correction deliveries to its recipients.
 *
 * Stack: node:sqlite (built-in, Node 22+). Kai ports to better-sqlite3 verbatim
 * (identical prepare().run()/.get()/.all() surface).
 */

const { DatabaseSync } = require('node:sqlite');
const { randomUUID } = require('node:crypto');

// Controlled vocabulary (the action-vocabulary registry, concrete). Unknown → rejected.
const FACT_TYPES = new Set([
  'client_feedback', 'creative_brief', 'decision', 'status_update', 'work_order',
]);
const VISIBILITY = new Set(['client', 'internal', 'fleet']);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS facts (
  fact_id       TEXT PRIMARY KEY,
  fact_type     TEXT NOT NULL,
  client_id     TEXT,
  subject_type  TEXT,
  subject_id    TEXT,
  visibility    TEXT NOT NULL,
  data_class    TEXT NOT NULL,
  payload       TEXT NOT NULL,
  source_agent  TEXT NOT NULL,
  observed_at   TEXT,
  created_at    TEXT NOT NULL,
  revoked_at    TEXT,
  superseded_by TEXT
);
CREATE TABLE IF NOT EXISTS deliveries (
  delivery_id     TEXT PRIMARY KEY,
  fact_id         TEXT NOT NULL,
  recipient_agent TEXT NOT NULL,
  scope           TEXT NOT NULL,
  kind            TEXT NOT NULL DEFAULT 'fact',
  status          TEXT NOT NULL DEFAULT 'pending',
  created_at      TEXT NOT NULL,
  UNIQUE(fact_id, recipient_agent, kind)
);
CREATE TABLE IF NOT EXISTS subscriptions (
  agent        TEXT NOT NULL,
  fact_type    TEXT NOT NULL,
  client_scope TEXT NOT NULL,           -- '*' (internal: every client) | a client_id (client repo: ONLY its own)
  UNIQUE(agent, fact_type, client_scope)
);
CREATE TABLE IF NOT EXISTS audit_log (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  ts     TEXT NOT NULL,
  event  TEXT NOT NULL,
  detail TEXT
);
CREATE TABLE IF NOT EXISTS dead_letter (
  fact_id TEXT NOT NULL,
  reason  TEXT NOT NULL,
  ts      TEXT NOT NULL
);
`;

const now = () => new Date().toISOString();

/** Apply the canonical schema to any db handle. Shared by central (openDb) and the
 *  per-client physical projections so both speak the identical table surface. */
function applySchema(db) {
  db.exec(SCHEMA);
  return db;
}

function openDb(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  return applySchema(db);
}

function audit(db, event, detail) {
  db.prepare('INSERT INTO audit_log (ts, event, detail) VALUES (?, ?, ?)')
    .run(now(), event, detail ? JSON.stringify(detail) : null);
}

/** Register what an agent wants. Client repos MUST pass their own client_id as
 *  client_scope (never '*') — that single rule is the isolation boundary. */
function subscribe(db, agent, factType, clientScope) {
  db.prepare(
    'INSERT OR IGNORE INTO subscriptions (agent, fact_type, client_scope) VALUES (?, ?, ?)'
  ).run(agent, factType, clientScope);
}

/**
 * Trusted write path. Runs preflight, persists the fact, then routes it.
 * Returns { ok, fact_id, routed } or { ok:false, error }.
 */
function writeFact(db, f) {
  // ── Preflight (Codex B2/S6): reject at the door, before durable write ──
  if (!FACT_TYPES.has(f.fact_type)) {
    audit(db, 'write_rejected', { reason: 'unknown_fact_type', fact_type: f.fact_type });
    return { ok: false, error: `unknown fact_type '${f.fact_type}' (not in registry)` };
  }
  if (!VISIBILITY.has(f.visibility)) {
    return { ok: false, error: `invalid visibility '${f.visibility}'` };
  }
  if (f.data_class === 'client_confidential' && !f.client_id) {
    audit(db, 'write_rejected', { reason: 'missing_client_scope', fact_type: f.fact_type });
    return { ok: false, error: 'client-confidential fact rejected: missing client_id (no ambiguous scope)' };
  }

  const fact_id = randomUUID();
  db.prepare(`INSERT INTO facts
    (fact_id, fact_type, client_id, subject_type, subject_id, visibility, data_class, payload, source_agent, observed_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    fact_id, f.fact_type, f.client_id ?? null, f.subject_type ?? null, f.subject_id ?? null,
    f.visibility, f.data_class, JSON.stringify(f.payload ?? {}), f.source_agent,
    f.observed_at ?? now(), now()
  );
  audit(db, 'fact_written', { fact_id, fact_type: f.fact_type, client_id: f.client_id, source: f.source_agent });

  const routed = route(db, fact_id);
  return { ok: true, fact_id, routed };
}

/**
 * The trusted router — the ONLY writer of `deliveries`.
 * A subscriber receives a delivery iff it subscribes to this fact_type AND its
 * client_scope is '*' (internal agent) OR exactly equals the fact's client_id
 * (the client repo's own client). No other match is possible → no cross-client leak.
 * Zero subscribers → dead_letter (fail-closed, Codex R1).
 */
function route(db, fact_id) {
  const fact = db.prepare('SELECT * FROM facts WHERE fact_id = ?').get(fact_id);
  const subs = db.prepare(
    `SELECT agent, client_scope FROM subscriptions
      WHERE fact_type = ? AND (client_scope = '*' OR client_scope = ?)`
  ).all(fact.fact_type, fact.client_id ?? '__no_client__'); // sentinel: never equals a real client_id or '*'

  if (subs.length === 0) {
    db.prepare('INSERT INTO dead_letter (fact_id, reason, ts) VALUES (?, ?, ?)')
      .run(fact_id, 'no_subscribers', now());
    audit(db, 'dead_lettered', { fact_id, fact_type: fact.fact_type });
    return 0;
  }
  let n = 0;
  for (const s of subs) {
    db.prepare(`INSERT OR IGNORE INTO deliveries
      (delivery_id, fact_id, recipient_agent, scope, kind, status, created_at)
      VALUES (?, ?, ?, ?, 'fact', 'pending', ?)`).run(
      randomUUID(), fact_id, s.agent, fact.client_id ?? '*', now()
    );
    n++;
  }
  audit(db, 'routed', { fact_id, recipients: subs.map(s => s.agent) });
  return n;
}

/**
 * The ONLY read path an agent has. Returns the agent's pending deliveries
 * (joined to the fact body) and marks them read. An agent literally cannot
 * obtain a fact without a delivery row the router wrote for it — that's the
 * structural isolation (Codex B1). There is no agent-facing "read all facts".
 */
function drain(db, agent) {
  const rows = db.prepare(
    `SELECT d.delivery_id, d.kind, d.scope, f.fact_id, f.fact_type, f.client_id, f.subject_id, f.payload, f.revoked_at
       FROM deliveries d JOIN facts f ON f.fact_id = d.fact_id
      WHERE d.recipient_agent = ? AND d.status = 'pending'
      ORDER BY d.created_at`
  ).all(agent);
  for (const r of rows) {
    db.prepare('UPDATE deliveries SET status = ? WHERE delivery_id = ?').run('read', r.delivery_id);
  }
  audit(db, 'drained', { agent, count: rows.length });
  return rows.map(r => ({
    kind: r.kind, fact_id: r.fact_id, fact_type: r.fact_type,
    client_id: r.client_id, subject_id: r.subject_id,
    payload: JSON.parse(r.payload), revoked: !!r.revoked_at,
  }));
}

/**
 * At-least-once read for the scheduled drainer runner: returns the agent's pending
 * deliveries (joined to the fact body) WITHOUT marking them read. The runner acks
 * each one (ack()) only after its handler succeeds — so a crash mid-handle redelivers
 * the fact next tick instead of losing it. drain() above stays the simple at-most-once
 * read for synchronous callers; peek()+ack() is the durable path the runner rides.
 * Same per-recipient delivery scope as drain() → structural isolation (B1) is identical.
 */
function peek(db, agent, limit = 100) {
  const rows = db.prepare(
    `SELECT d.delivery_id, d.kind, d.scope, f.fact_id, f.fact_type, f.client_id, f.subject_id, f.payload, f.revoked_at, d.created_at
       FROM deliveries d JOIN facts f ON f.fact_id = d.fact_id
      WHERE d.recipient_agent = ? AND d.status = 'pending'
      ORDER BY d.created_at
      LIMIT ?`
  ).all(agent, limit);
  return rows.map(r => ({
    delivery_id: r.delivery_id, kind: r.kind, fact_id: r.fact_id, fact_type: r.fact_type,
    client_id: r.client_id, subject_id: r.subject_id,
    payload: JSON.parse(r.payload), revoked: !!r.revoked_at, created_at: r.created_at,
  }));
}

/** Mark one delivery handled. The runner calls this ONLY after its handler resolves. */
function ack(db, deliveryId) {
  db.prepare("UPDATE deliveries SET status = 'read' WHERE delivery_id = ?").run(deliveryId);
}

/**
 * Park a poison delivery — handler failed maxAttempts times — so one bad fact can't
 * wedge an agent's queue forever. Recorded in dead_letter (alertable) and marked 'dead'
 * so peek() never returns it again. Distinct status from 'read' so observability can tell
 * "handled" from "given up on".
 */
function deadLetterDelivery(db, deliveryId, reason) {
  const d = db.prepare('SELECT fact_id FROM deliveries WHERE delivery_id = ?').get(deliveryId);
  if (!d) return false;
  db.prepare('INSERT INTO dead_letter (fact_id, reason, ts) VALUES (?, ?, ?)').run(d.fact_id, reason, now());
  db.prepare("UPDATE deliveries SET status = 'dead' WHERE delivery_id = ?").run(deliveryId);
  audit(db, 'delivery_dead_lettered', { delivery_id: deliveryId, fact_id: d.fact_id, reason });
  return true;
}

/** Backlog + lag for an agent's pending queue (drives runner observability). */
function pendingStats(db, agent) {
  const row = db.prepare(
    `SELECT COUNT(*) AS pending, MIN(created_at) AS oldest
       FROM deliveries WHERE recipient_agent = ? AND status = 'pending'`
  ).get(agent);
  return { pending: row.pending, oldest: row.oldest };
}

/** Retraction/correction (Codex G19): revoke a fact + issue corrections to its recipients. */
function revoke(db, fact_id, reason) {
  db.prepare('UPDATE facts SET revoked_at = ? WHERE fact_id = ?').run(now(), fact_id);
  const recips = db.prepare(
    `SELECT DISTINCT recipient_agent, scope FROM deliveries WHERE fact_id = ? AND kind = 'fact'`
  ).all(fact_id);
  for (const r of recips) {
    db.prepare(`INSERT OR IGNORE INTO deliveries
      (delivery_id, fact_id, recipient_agent, scope, kind, status, created_at)
      VALUES (?, ?, ?, ?, 'correction', 'pending', ?)`).run(
      randomUUID(), fact_id, r.recipient_agent, r.scope, now()
    );
  }
  audit(db, 'revoked', { fact_id, reason, corrections: recips.length });
  return recips.length;
}

module.exports = { openDb, applySchema, subscribe, writeFact, drain, revoke, FACT_TYPES, peek, ack, deadLetterDelivery, pendingStats };

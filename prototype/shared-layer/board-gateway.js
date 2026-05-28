'use strict';
/**
 * The Board Write Gateway ("the door") — Option A. An authenticated, identity-bound HTTP endpoint on
 * the Mini that lets a feed running ANYWHERE (laptop or Mini) publish a fact to the Board over
 * Tailscale. Write sibling to the read-only ledger (board-ledger.js).
 *
 * Design: docs/design-board-write-gateway-2026-05-27.md (v2, Codex REVISE folded + DA passed).
 * Security stance (the spoofing fix, Codex #1): the gateway NEVER trusts body source_agent. Each
 * bearer token maps to one agent + authz scope (server-side); the gateway sets source_agent from the
 * token and enforces authz via identity.js authzProduce. publish != act — no agent handler is ever
 * called from here (DA-e: this module imports zero handlers).
 */
const http = require('node:http');
const { randomBytes, createHash, timingSafeEqual } = require('node:crypto');
const { openDb, writeFact } = require('./shared-layer');
const { withTx } = require('./db');
const { writeFactValidated, defaultRegistry } = require('./registry');
const { authzProduce, canonicalFact } = require('./identity');
const { validateEnvelope, scanSafe, isPlainObject, okStr, ALLOWED_TOP } = require('./board-envelope');

const now = () => new Date().toISOString();
const sha256hex = s => createHash('sha256').update(s).digest('hex');
const sha256buf = s => createHash('sha256').update(s).digest();
const MAX_BODY = 64 * 1024;

// ── token registry + idempotency store + consume tables (gateway-owned) ──────────────────────────
const GATEWAY_SCHEMA = `
CREATE TABLE IF NOT EXISTS gateway_tokens (
  token_hash  TEXT PRIMARY KEY,   -- sha256(token) hex; the token itself is NEVER stored (HB#9)
  agent       TEXT NOT NULL,
  client_id   TEXT,               -- null = internal; else this token may ONLY produce this client's facts
  can_produce TEXT,               -- JSON array of allowed fact_types; null = any known type
  scopes      TEXT,               -- v2: JSON array of allowed scopes (publish/read/ack/act/supervise). null = legacy publish-only
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS gateway_idem (
  agent        TEXT NOT NULL,
  key          TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_json TEXT NOT NULL,
  ts           TEXT NOT NULL,
  PRIMARY KEY (agent, key)
);
-- v2: action ledger — recorded BEFORE the external action runs, then status updated.
-- Second wall vs double-execution (claim/lease is the first wall). Honest at-most-once semantics.
CREATE TABLE IF NOT EXISTS gateway_actions (
  decision_fact_id TEXT NOT NULL,
  subject_fact_id  TEXT NOT NULL,
  action_type      TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('intent','completed','failed','ambiguous')),
  agent            TEXT NOT NULL,
  ts               TEXT NOT NULL,
  error            TEXT,
  ext_ref          TEXT,          -- external receipt/ID for human reconciliation (e.g. QuickBooks invoice id)
  PRIMARY KEY (decision_fact_id, subject_fact_id, action_type)
);
-- v2: durable quarantine — permanent handler failures land here AND status='dead', distinct from acked.
CREATE TABLE IF NOT EXISTS gateway_quarantine (
  delivery_id TEXT PRIMARY KEY,
  fact_id     TEXT NOT NULL,
  agent       TEXT NOT NULL,
  handler     TEXT,
  error       TEXT NOT NULL,
  ts          TEXT NOT NULL,
  reviewed_at TEXT
);`;

// v2 scopes
const SCOPE_PUBLISH = 'publish', SCOPE_READ = 'read', SCOPE_ACK = 'ack', SCOPE_ACT = 'act', SCOPE_SUPERVISE = 'supervise';
const ALL_SCOPES = new Set([SCOPE_PUBLISH, SCOPE_READ, SCOPE_ACK, SCOPE_ACT, SCOPE_SUPERVISE]);
function tokenScopes(row) {
  if (!row.scopes) return new Set([SCOPE_PUBLISH]);   // legacy tokens (no scopes col data) = publish-only
  try { return new Set(JSON.parse(row.scopes)); } catch (_) { return new Set([SCOPE_PUBLISH]); }
}
const hasScope = (row, scope) => tokenScopes(row).has(scope);

function ensureGatewayTables(db) {
  db.exec(GATEWAY_SCHEMA);
  // Additive column migrations — safe to re-run; sqlite ALTER errors on dup column, we swallow that case.
  for (const stmt of [
    'ALTER TABLE gateway_tokens ADD COLUMN scopes TEXT',
    'ALTER TABLE deliveries     ADD COLUMN claimed_at TEXT',
    'ALTER TABLE deliveries     ADD COLUMN claimed_by TEXT',
    'ALTER TABLE deliveries     ADD COLUMN lease_until TEXT',
    'ALTER TABLE deliveries     ADD COLUMN dead_reason TEXT',
    'ALTER TABLE deliveries     ADD COLUMN delivery_attempts INTEGER NOT NULL DEFAULT 0',
  ]) { try { db.exec(stmt); } catch (e) { if (!/duplicate column/i.test(e.message)) throw e; } }
  return db;
}

/** Privileged enrollment (admin/operator only). Generates a token, stores ONLY its hash + scope,
 *  returns the plaintext token ONCE for the operator to hand to the caller. Scopes default to
 *  ['publish'] for backwards compat — pass scopes explicitly for consume-capable tokens. */
function enrollToken(db, { agent, client_id = null, can_produce = null, scopes = [SCOPE_PUBLISH] }) {
  ensureGatewayTables(db);
  if (!agent || typeof agent !== 'string') throw new Error('enrollToken: agent required');
  for (const s of scopes) if (!ALL_SCOPES.has(s)) throw new Error(`enrollToken: unknown scope '${s}'`);
  const token = randomBytes(32).toString('base64url');
  db.prepare(`INSERT INTO gateway_tokens (token_hash, agent, client_id, can_produce, scopes, active, created_at)
    VALUES (?, ?, ?, ?, ?, 1, ?)`).run(sha256hex(token), agent, client_id, can_produce ? JSON.stringify(can_produce) : null, JSON.stringify(scopes), now());
  return token;
}

/** Resolve a bearer token → its scope row, via constant-time hash compare over active tokens. */
function resolveToken(db, token) {
  if (!okStr(token, 4096)) return null;
  const h = sha256buf(token);
  const rows = db.prepare('SELECT token_hash, agent, client_id, can_produce, scopes FROM gateway_tokens WHERE active = 1').all();
  for (const row of rows) {
    let stored; try { stored = Buffer.from(row.token_hash, 'hex'); } catch (_) { continue; }
    if (stored.length === h.length && timingSafeEqual(stored, h)) {
      return { agent: row.agent, client_id: row.client_id, can_produce: row.can_produce, scopes: row.scopes };
    }
  }
  return null;
}

/** Fail-closed gate (Codex #5): writable only if at least one active token is enrolled. */
function gatewayWritable(db) {
  try { ensureGatewayTables(db); return db.prepare('SELECT COUNT(*) n FROM gateway_tokens WHERE active = 1').get().n > 0; }
  catch (_) { return false; }
}

// Belt-and-suspenders on top of busy_timeout (Codex #4). Rare; sqlite already blocks up to busy_timeout.
function syncSleep(ms) { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (_) {} }
function withBusyRetry(fn, tries = 3) {
  for (let i = 0; ; i++) {
    try { return fn(); }
    catch (e) {
      const busy = /SQLITE_BUSY|database is locked/i.test(e && e.message);
      if (busy && i < tries - 1) { syncSleep(40 * (i + 1)); continue; }
      throw e;
    }
  }
}

/**
 * The pure publish handler — { status, json }. Auth is already done (tokenRow). No HTTP here, so it's
 * directly unit-testable. Order: pollution-scan → unknown-key gate → envelope validate+sanitize →
 * server-side source_agent + client binding → authz → (idempotency + schema + core write) in one txn.
 */
function handlePublish(db, tokenRow, rawBody) {
  if (!isPlainObject(rawBody)) return { status: 400, json: { ok: false, error: 'body must be a JSON object' } };
  const pol = scanSafe(rawBody); if (pol) return { status: 400, json: { ok: false, error: pol } };

  const idk = rawBody.idempotency_key;
  if (idk !== undefined && !okStr(idk, 200)) return { status: 400, json: { ok: false, error: 'invalid idempotency_key' } };

  // strip the request-level field; pollution already rejected, so this copy is safe
  const factBody = {};
  for (const k of Object.keys(rawBody)) if (k !== 'idempotency_key') factBody[k] = rawBody[k];

  const env = validateEnvelope(factBody);
  if (!env.ok) return { status: 400, json: { ok: false, error: env.error } };
  const fact = env.fact;

  // ── Codex #1: identity is the TOKEN's, never the body's ──
  fact.source_agent = tokenRow.agent;
  if (tokenRow.client_id != null) fact.client_id = tokenRow.client_id; // bound token → forced client scope

  // v2 / Codex consume P0 #5 — `supervisor_decision` is the ONLY fact_type that authorizes downstream
  // agent action. Forgery guard: must be posted by the 'alex' identity with the 'supervise' scope.
  // Plain `decision` facts retain their original audit-only semantic.
  if (fact.fact_type === 'supervisor_decision') {
    if (tokenRow.agent !== 'alex' || !hasScope(tokenRow, SCOPE_SUPERVISE)) {
      return { status: 403, json: { ok: false, error: 'unauthorized: supervisor_decision requires alex identity + supervise scope' } };
    }
  }
  // v2 — to publish anything at all, the token needs `publish` scope (legacy tokens get this by default).
  if (!hasScope(tokenRow, SCOPE_PUBLISH)) {
    return { status: 403, json: { ok: false, error: 'unauthorized: token lacks publish scope' } };
  }

  const az = authzProduce({ can_produce: tokenRow.can_produce, client_id: tokenRow.client_id }, fact);
  if (!az.ok) return { status: 403, json: { ok: false, error: `unauthorized: ${az.reason}` } };

  const reqHash = sha256hex(canonicalFact(fact));

  return withBusyRetry(() => withTx(db, () => {
    if (idk !== undefined) {
      const prior = db.prepare('SELECT request_hash, response_json FROM gateway_idem WHERE agent = ? AND key = ?').get(fact.source_agent, idk);
      if (prior) {
        if (prior.request_hash === reqHash) return { status: 200, json: { ...JSON.parse(prior.response_json), idempotent: true } };
        return { status: 409, json: { ok: false, error: 'idempotency_key reused with a different request' } };
      }
    }
    const r = writeFactValidated(db, fact, defaultRegistry);
    if (!r.ok) return { status: 422, json: { ok: false, error: r.error } };
    const resp = { ok: true, fact_id: r.fact_id, routed: r.routed };
    if (idk !== undefined) {
      db.prepare('INSERT INTO gateway_idem (agent, key, request_hash, response_json, ts) VALUES (?, ?, ?, ?, ?)')
        .run(fact.source_agent, idk, reqHash, JSON.stringify(resp), now());
    }
    return { status: 200, json: resp };
  }));
}

// ── v2 — consume side: pure handlers for /inbox, /claim, /ack, /quarantine ────────────────────────
// Same shape as handlePublish: { status, json }. No HTTP here, directly unit-testable.

const DEFAULT_LEASE_S = 300;        // 5 min
const MAX_LEASE_S = 1800;           // 30 min (DA-d cap)
const INBOX_DEFAULT = 50, INBOX_MAX = 200;
const isoPlusSeconds = secs => new Date(Date.now() + secs * 1000).toISOString();
const isPast = iso => !iso || new Date(iso).getTime() < Date.now();

/** GET /inbox — return unacked, unclaimed (or self-claim-expired) deliveries for the token's agent.
 *  Filter on `acked_at IS NULL` (NOT status — Codex P0 #3 fix vs drainer race).
 *  Client-bound tokens get an additional scope: only their client's facts (or internal facts). */
function handleInbox(db, tokenRow, query) {
  if (!hasScope(tokenRow, SCOPE_READ)) return { status: 403, json: { ok: false, error: 'unauthorized: token lacks read scope' } };
  let limit = Number(query && query.limit) || INBOX_DEFAULT;
  if (!Number.isFinite(limit) || limit < 1) limit = INBOX_DEFAULT;
  if (limit > INBOX_MAX) limit = INBOX_MAX;
  const nowIso = new Date().toISOString();
  // Deliveries unacked, and either not claimed OR claim expired OR self-claimed (so self can renew/see).
  const rows = db.prepare(
    `SELECT d.delivery_id, d.fact_id, d.kind, d.scope, d.created_at, d.delivery_attempts,
            d.claimed_by, d.lease_until,
            f.fact_type, f.source_agent, f.client_id, f.subject_type, f.subject_id, f.payload
       FROM deliveries d JOIN facts f ON f.fact_id = d.fact_id
      WHERE d.recipient_agent = ?
        AND d.acked_at IS NULL
        AND COALESCE(d.status, 'pending') != 'dead'
        AND (d.claimed_at IS NULL OR d.lease_until IS NULL OR d.lease_until < ? OR d.claimed_by = ?)
      ORDER BY d.created_at ASC, d.delivery_id ASC
      LIMIT ?`
  ).all(tokenRow.agent, nowIso, tokenRow.agent, limit);
  // Client-bound token: filter to its client's facts (or internal facts where client_id is null).
  const filtered = tokenRow.client_id == null ? rows : rows.filter(r => r.client_id === tokenRow.client_id || r.client_id == null);
  const deliveries = filtered.map(r => ({
    delivery_id: r.delivery_id, fact_id: r.fact_id, kind: r.kind, scope: r.scope,
    created_at: r.created_at, delivery_attempts: r.delivery_attempts || 0,
    claimed_by: r.claimed_by, lease_until: r.lease_until,
    fact_type: r.fact_type, source_agent: r.source_agent, client_id: r.client_id,
    subject_type: r.subject_type, subject_id: r.subject_id,
    payload: (() => { try { return JSON.parse(r.payload); } catch (_) { return {}; } })(),
  }));
  return { status: 200, json: { ok: true, agent: tokenRow.agent, count: deliveries.length, deliveries } };
}

/** POST /claim/<delivery_id>?lease=<seconds> — atomic claim with TTL. Renewable by the same agent.
 *  Returns 200 { lease_until } on claim/renewal; 409 { claimed_by, lease_until } if held by another;
 *  404 if delivery doesn't exist; 403 if recipient mismatch; 410 if already acked or dead. */
function handleClaim(db, tokenRow, delivery_id, query) {
  if (!hasScope(tokenRow, SCOPE_READ)) return { status: 403, json: { ok: false, error: 'unauthorized: token lacks read scope' } };
  if (!okStr(delivery_id, 80)) return { status: 400, json: { ok: false, error: 'invalid delivery_id' } };
  let leaseS = Number(query && query.lease) || DEFAULT_LEASE_S;
  if (!Number.isFinite(leaseS) || leaseS < 1) leaseS = DEFAULT_LEASE_S;
  if (leaseS > MAX_LEASE_S) leaseS = MAX_LEASE_S;
  return withBusyRetry(() => withTx(db, () => {
    const d = db.prepare('SELECT delivery_id, recipient_agent, status, claimed_by, claimed_at, lease_until, acked_at FROM deliveries WHERE delivery_id = ?').get(delivery_id);
    if (!d) return { status: 404, json: { ok: false, error: 'delivery not found' } };
    if (d.recipient_agent !== tokenRow.agent) return { status: 403, json: { ok: false, error: 'unauthorized: not the recipient' } };
    if (d.acked_at) return { status: 410, json: { ok: false, error: 'already acked' } };
    if (d.status === 'dead') return { status: 410, json: { ok: false, error: 'delivery is dead' } };
    // Already self-claimed → treat as renewal.
    // Held by another agent and lease unexpired → 409.
    if (d.claimed_at && !isPast(d.lease_until) && d.claimed_by !== tokenRow.agent) {
      return { status: 409, json: { ok: false, error: 'already claimed', claimed_by: d.claimed_by, lease_until: d.lease_until } };
    }
    const lease_until = isoPlusSeconds(leaseS);
    db.prepare("UPDATE deliveries SET claimed_by = ?, claimed_at = ?, lease_until = ? WHERE delivery_id = ?")
      .run(tokenRow.agent, now(), lease_until, delivery_id);
    return { status: 200, json: { ok: true, delivery_id, lease_until, renewal: d.claimed_by === tokenRow.agent } };
  }));
}

/** POST /ack/<delivery_id> — first-writer-wins atomic ack. Idempotent on self-acks.
 *  Body (optional): { logged: true } — agent's metadata that it recorded the fact. */
function handleAck(db, tokenRow, delivery_id /*, body */) {
  if (!hasScope(tokenRow, SCOPE_ACK)) return { status: 403, json: { ok: false, error: 'unauthorized: token lacks ack scope' } };
  if (!okStr(delivery_id, 80)) return { status: 400, json: { ok: false, error: 'invalid delivery_id' } };
  return withBusyRetry(() => withTx(db, () => {
    const info = db.prepare("UPDATE deliveries SET acked_at = ?, acked_by = ?, status = 'acked' WHERE delivery_id = ? AND recipient_agent = ? AND acked_at IS NULL")
      .run(now(), tokenRow.agent, delivery_id, tokenRow.agent);
    if (info.changes > 0) return { status: 200, json: { ok: true, delivery_id, first_ack: true } };
    // Zero rows changed — disambiguate (Codex P1 #6).
    const d = db.prepare('SELECT recipient_agent, acked_at, acked_by, status FROM deliveries WHERE delivery_id = ?').get(delivery_id);
    if (!d) return { status: 404, json: { ok: false, error: 'delivery not found' } };
    if (d.recipient_agent !== tokenRow.agent) return { status: 403, json: { ok: false, error: 'unauthorized: not the recipient' } };
    if (d.acked_at && d.acked_by === tokenRow.agent) return { status: 200, json: { ok: true, delivery_id, first_ack: false, acked_at: d.acked_at } };
    return { status: 409, json: { ok: false, error: 'already acked by another writer', acked_by: d.acked_by, acked_at: d.acked_at } };
  }));
}

/** POST /quarantine/<delivery_id> — agent marks a delivery as permanently failed.
 *  Writes durable row + flips status='dead'. Distinct from ack — surfaces to operator. */
function handleQuarantine(db, tokenRow, delivery_id, body) {
  if (!hasScope(tokenRow, SCOPE_ACK)) return { status: 403, json: { ok: false, error: 'unauthorized: token lacks ack scope' } };
  if (!okStr(delivery_id, 80)) return { status: 400, json: { ok: false, error: 'invalid delivery_id' } };
  const reason = String((body && body.error) || 'unspecified').slice(0, 1000);
  const handler = String((body && body.handler) || '').slice(0, 100);
  return withBusyRetry(() => withTx(db, () => {
    const d = db.prepare('SELECT delivery_id, fact_id, recipient_agent, acked_at, status FROM deliveries WHERE delivery_id = ?').get(delivery_id);
    if (!d) return { status: 404, json: { ok: false, error: 'delivery not found' } };
    if (d.recipient_agent !== tokenRow.agent) return { status: 403, json: { ok: false, error: 'unauthorized: not the recipient' } };
    if (d.acked_at) return { status: 410, json: { ok: false, error: 'delivery already acked — cannot quarantine' } };
    db.prepare('INSERT OR REPLACE INTO gateway_quarantine (delivery_id, fact_id, agent, handler, error, ts) VALUES (?, ?, ?, ?, ?, ?)')
      .run(delivery_id, d.fact_id, tokenRow.agent, handler || null, reason, now());
    db.prepare("UPDATE deliveries SET status = 'dead', dead_reason = ? WHERE delivery_id = ?").run(reason, delivery_id);
    return { status: 200, json: { ok: true, delivery_id, quarantined: true } };
  }));
}

// ── HTTP layer ────────────────────────────────────────────────────────────────────────────────────
function readBody(req, maxBody) {
  return new Promise((resolve, reject) => {
    let len = 0; const chunks = [];
    req.on('data', c => { len += c.length; if (len > maxBody) { const e = new Error('too large'); e.code = 'BODY_TOO_LARGE'; req.destroy(); reject(e); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (_) { const e = new Error('bad json'); e.code = 'BAD_JSON'; reject(e); } });
    req.on('error', reject);
  });
}
const send = (res, status, json) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(json)); };

function rateLimited(buckets, agent, limit) {
  if (!limit) return false;
  const { max, windowMs } = limit, t = Date.now();
  let b = buckets.get(agent);
  if (!b || t - b.start >= windowMs) { b = { start: t, count: 0 }; buckets.set(agent, b); }
  b.count++; return b.count > max;
}

/**
 * Start the gateway. Binds to host (Tailscale IP in prod, 127.0.0.1 in tests); never falls back to a
 * broader bind; retries on EADDRNOTAVAIL (Codex #6). Returns { server, db }.
 */
function startGateway({ dbPath = ':memory:', host = '127.0.0.1', port = 3351, maxBody = MAX_BODY,
  rateLimit = { max: 120, windowMs: 10000 }, onLog = () => {} } = {}) {
  const db = openDb(dbPath);
  ensureGatewayTables(db);
  db.exec('PRAGMA busy_timeout = 5000;');
  if (dbPath !== ':memory:') {
    const jm = db.prepare('PRAGMA journal_mode;').get();
    if (jm && jm.journal_mode && jm.journal_mode.toLowerCase() !== 'wal') onLog(`WARNING journal_mode=${jm.journal_mode} (expected wal)`);
  }
  const buckets = new Map();

  // URL routing helpers
  const URL_INBOX  = /^\/inbox(?:\?(.+))?$/;
  const URL_CLAIM  = /^\/claim\/([^\/\?]+)(?:\?(.+))?$/;
  const URL_ACK    = /^\/ack\/([^\/\?]+)$/;
  const URL_QUAR   = /^\/quarantine\/([^\/\?]+)$/;
  const parseQuery = qs => { const o = {}; if (!qs) return o; for (const p of qs.split('&')) { const [k, v] = p.split('='); if (k) o[decodeURIComponent(k)] = v ? decodeURIComponent(v) : ''; } return o; };

  const server = http.createServer(async (req, res) => {
    try {
      // /health is open (no auth) — for liveness checks.
      if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true, writable: gatewayWritable(db) });

      // All other endpoints require Bearer auth.
      const m = /^Bearer\s+(.+)$/.exec(req.headers['authorization'] || '');
      if (!m) return send(res, 401, { ok: false, error: 'missing bearer token' });
      if (!gatewayWritable(db)) return send(res, 503, { ok: false, error: 'gateway not configured' });
      const tokenRow = resolveToken(db, m[1]);
      if (!tokenRow) return send(res, 401, { ok: false, error: 'invalid token' });
      if (rateLimited(buckets, tokenRow.agent, rateLimit)) return send(res, 429, { ok: false, error: 'rate limit exceeded' });

      // POST /publish — the write side (existing).
      if (req.method === 'POST' && req.url === '/publish') {
        const body = await readBody(req, maxBody);
        const out = withBusyRetry(() => handlePublish(db, tokenRow, body));
        return send(res, out.status, out.json);
      }
      // GET /inbox — the read side (v2).
      let mm;
      if (req.method === 'GET' && (mm = URL_INBOX.exec(req.url))) {
        const q = parseQuery(mm[1]);
        const out = withBusyRetry(() => handleInbox(db, tokenRow, q));
        return send(res, out.status, out.json);
      }
      // POST /claim/<delivery_id>?lease=N — the lock side (v2).
      if (req.method === 'POST' && (mm = URL_CLAIM.exec(req.url))) {
        const q = parseQuery(mm[2]);
        const out = withBusyRetry(() => handleClaim(db, tokenRow, decodeURIComponent(mm[1]), q));
        return send(res, out.status, out.json);
      }
      // POST /ack/<delivery_id> — the consume confirmation side (v2).
      if (req.method === 'POST' && (mm = URL_ACK.exec(req.url))) {
        const body = await readBody(req, maxBody).catch(() => ({}));
        const out = withBusyRetry(() => handleAck(db, tokenRow, decodeURIComponent(mm[1]), body));
        return send(res, out.status, out.json);
      }
      // POST /quarantine/<delivery_id> — the permanent-failure side (v2).
      if (req.method === 'POST' && (mm = URL_QUAR.exec(req.url))) {
        const body = await readBody(req, maxBody);
        const out = withBusyRetry(() => handleQuarantine(db, tokenRow, decodeURIComponent(mm[1]), body));
        return send(res, out.status, out.json);
      }
      return send(res, 404, { ok: false, error: 'not found' });
    } catch (e) {
      if (e && e.code === 'BODY_TOO_LARGE') return send(res, 413, { ok: false, error: 'body too large' });
      if (e && e.code === 'BAD_JSON') return send(res, 400, { ok: false, error: 'malformed JSON' });
      onLog(`gateway error: ${e && e.message}`);              // Mini-local only — never to the client
      return send(res, 500, { ok: false, error: 'internal error' });
    }
  });
  server.headersTimeout = 10000;
  server.requestTimeout = 15000;
  server.on('connection', s => s.setTimeout(20000));

  const listen = () => server.listen(port, host, () => onLog(`[board-gateway] live on ${host}:${port}`));
  server.on('error', e => {
    if (e.code === 'EADDRNOTAVAIL') { onLog(`[board-gateway] ${host} not up yet — retry in 5s`); setTimeout(listen, 5000); }
    else onLog(`[board-gateway] server error: ${e.code}`);
  });
  listen();
  return { server, db };
}

module.exports = {
  ensureGatewayTables, enrollToken, resolveToken, gatewayWritable, hasScope, tokenScopes,
  handlePublish, handleInbox, handleClaim, handleAck, handleQuarantine,
  startGateway, GATEWAY_SCHEMA,
  SCOPE_PUBLISH, SCOPE_READ, SCOPE_ACK, SCOPE_ACT, SCOPE_SUPERVISE,
};

if (require.main === module) {
  const dbPath = process.env.BOARD_DB || (process.env.HOME + '/.kameha/kameha-mesh.db');
  startGateway({
    dbPath,
    host: process.env.GATEWAY_HOST || '100.64.114.13',
    port: Number(process.env.GATEWAY_PORT) || 3351,
    onLog: (...a) => console.log(...a),
  });
  if (!require('node:fs').existsSync(dbPath)) console.error('warning: board DB not found at ' + dbPath);
}

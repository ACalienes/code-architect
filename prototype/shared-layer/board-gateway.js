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

// ── token registry + idempotency store (gateway-owned tables) ─────────────────────────────────────
const GATEWAY_SCHEMA = `
CREATE TABLE IF NOT EXISTS gateway_tokens (
  token_hash  TEXT PRIMARY KEY,   -- sha256(token) hex; the token itself is NEVER stored (HB#9)
  agent       TEXT NOT NULL,
  client_id   TEXT,               -- null = internal; else this token may ONLY produce this client's facts
  can_produce TEXT,               -- JSON array of allowed fact_types; null = any known type
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
);`;

function ensureGatewayTables(db) { db.exec(GATEWAY_SCHEMA); return db; }

/** Privileged enrollment (admin/operator only). Generates a token, stores ONLY its hash + scope,
 *  returns the plaintext token ONCE for the operator to hand to the caller. */
function enrollToken(db, { agent, client_id = null, can_produce = null }) {
  ensureGatewayTables(db);
  if (!agent || typeof agent !== 'string') throw new Error('enrollToken: agent required');
  const token = randomBytes(32).toString('base64url');
  db.prepare(`INSERT INTO gateway_tokens (token_hash, agent, client_id, can_produce, active, created_at)
    VALUES (?, ?, ?, ?, 1, ?)`).run(sha256hex(token), agent, client_id, can_produce ? JSON.stringify(can_produce) : null, now());
  return token;
}

/** Resolve a bearer token → its scope row, via constant-time hash compare over active tokens. */
function resolveToken(db, token) {
  if (!okStr(token, 4096)) return null;
  const h = sha256buf(token);
  const rows = db.prepare('SELECT token_hash, agent, client_id, can_produce FROM gateway_tokens WHERE active = 1').all();
  for (const row of rows) {
    let stored; try { stored = Buffer.from(row.token_hash, 'hex'); } catch (_) { continue; }
    if (stored.length === h.length && timingSafeEqual(stored, h)) {
      return { agent: row.agent, client_id: row.client_id, can_produce: row.can_produce };
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

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true, writable: gatewayWritable(db) });
      if (req.method !== 'POST' || req.url !== '/publish') return send(res, 404, { ok: false, error: 'not found' });

      const m = /^Bearer\s+(.+)$/.exec(req.headers['authorization'] || '');
      if (!m) return send(res, 401, { ok: false, error: 'missing bearer token' });
      if (!gatewayWritable(db)) return send(res, 503, { ok: false, error: 'gateway not configured' });
      const tokenRow = resolveToken(db, m[1]);
      if (!tokenRow) return send(res, 401, { ok: false, error: 'invalid token' });
      if (rateLimited(buckets, tokenRow.agent, rateLimit)) return send(res, 429, { ok: false, error: 'rate limit exceeded' });

      const body = await readBody(req, maxBody);
      const out = withBusyRetry(() => handlePublish(db, tokenRow, body));
      return send(res, out.status, out.json);
    } catch (e) {
      if (e && e.code === 'BODY_TOO_LARGE') return send(res, 413, { ok: false, error: 'body too large' });
      if (e && e.code === 'BAD_JSON') return send(res, 400, { ok: false, error: 'malformed JSON' });
      onLog(`publish error: ${e && e.message}`);              // Mini-local only — never to the client
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

module.exports = { ensureGatewayTables, enrollToken, resolveToken, gatewayWritable, handlePublish, startGateway, GATEWAY_SCHEMA };

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

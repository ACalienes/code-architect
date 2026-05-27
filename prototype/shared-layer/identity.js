'use strict';
/**
 * Agent identity + signed source claims — Shared Layer hardening roadmap increment #4.
 * Code Architect · 2026-05-25.
 *
 * Closes two holes that exist in the lenient core:
 *   1. AuthN — `source_agent` is just a self-asserted string today, so any writer can forge
 *      attribution. Here each agent has an Ed25519 keypair; the layer stores ONLY the public key;
 *      a fact is signed by the producer and VERIFIED at the door against the registered key.
 *      Forged / tampered / impersonated facts are rejected before they persist.
 *   2. AuthZ — today `subscribe('dag-repo','client_feedback','tdb')` succeeds (a client repo could
 *      subscribe to ANOTHER client!). An identity bound to a client may only produce/subscribe its
 *      own client's data. This is isolation enforced at the identity layer, beneath the delivery split.
 *
 * Surgical + opt-in (like #6): the core writeFact/subscribe stay unauthenticated so all prior checks
 * remain green; production routes through writeSignedFact()/authorizeSubscribe(). Composes with the
 * registry: the full door is verify-identity → authZ → schema → core write.
 *
 * HB#9: private keys NEVER touch this module or the audit log — only public keys (non-secret) are
 * stored; audit records agent + reason, never a key or signature.
 *
 * Trust root (T3, for deploy): registerIdentity() is a PRIVILEGED bootstrap (enrollment), run by the
 * trusted operator/projector identity — not something agents self-serve. v1 verifies authenticity +
 * integrity at the door; replay protection (nonce + seen-window), stored signatures for after-the-fact
 * non-repudiation, and key rotation history are documented roadmap items.
 */

const { generateKeyPairSync, sign, verify, createPublicKey } = require('node:crypto');
const { writeFact, subscribe } = require('./shared-layer');
const { writeFactValidated, defaultRegistry } = require('./registry');

const now = () => new Date().toISOString();

const IDENTITIES_SCHEMA = `
CREATE TABLE IF NOT EXISTS identities (
  agent       TEXT PRIMARY KEY,
  public_key  TEXT NOT NULL,   -- SPKI PEM (non-secret)
  client_id   TEXT,            -- null = internal (cross-client by design); else BOUND to this client
  can_produce TEXT,            -- JSON array of allowed fact_types; null = any known type
  created_at  TEXT NOT NULL
);`;

function ensureIdentitiesTable(db) { db.exec(IDENTITIES_SCHEMA); }

function audit(db, event, detail) {
  db.prepare('INSERT INTO audit_log (ts, event, detail) VALUES (?, ?, ?)')
    .run(now(), event, detail ? JSON.stringify(detail) : null);
}

/** Setup/test helper: a fresh Ed25519 keypair. publicKey is a PEM string to register; the
 *  privateKey KeyObject stays with the agent and is NEVER given to the layer. */
function generateIdentity() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(), privateKey };
}

/**
 * Privileged enrollment (trust root — admin surface only, NOT the agent facade). INSERT-ONLY by
 * default: enrolling an agent that already exists is REFUSED unless `rotate: true` is passed (an
 * explicit rotation ceremony). This stops a caller from silently replacing dag-repo's key with its
 * own (Codex critical). Stores the PUBLIC key + authz binding only.
 */
function registerIdentity(db, { agent, publicKey, clientId = null, canProduce = null, rotate = false }) {
  ensureIdentitiesTable(db);
  const exists = db.prepare('SELECT 1 FROM identities WHERE agent = ?').get(agent);
  if (exists && !rotate) {
    audit(db, 'identity_register_refused', { agent, reason: 'already_enrolled' });
    return { ok: false, error: `identity '${agent}' already enrolled — replacement requires an explicit rotate ceremony` };
  }
  db.prepare(`INSERT OR REPLACE INTO identities (agent, public_key, client_id, can_produce, created_at)
    VALUES (?, ?, ?, ?, ?)`).run(agent, publicKey, clientId, canProduce ? JSON.stringify(canProduce) : null, now());
  audit(db, exists ? 'identity_rotated' : 'identity_registered', { agent, clientId, canProduce });
  return { ok: true, rotated: !!exists };
}

// Deterministic serialization of the identity-bound fields — sorted keys so re-serialization (any
// payload key order) signs/verifies to identical bytes. Covers attribution + content, so a signature
// can't be replayed under a different agent or with any field altered.
function stableStringify(v) {
  // Reject non-JSON values rather than letting JSON.stringify coerce them (Codex round 3): otherwise
  // `[undefined]` serializes to the same bytes as `[]` (and NaN/Infinity → null), so a signature over
  // one would verify for the other. Throwing here makes verifyFact reject and signFact refuse.
  if (v === undefined || typeof v === 'function' || typeof v === 'symbol')
    throw new Error('non-canonical value in signed payload (undefined/function/symbol)');
  if (typeof v === 'number' && !Number.isFinite(v))
    throw new Error('non-canonical value in signed payload (non-finite number)');
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  // Only PLAIN objects are canonicalizable. A Date/RegExp/class instance serializes to `{}` here but
  // JSON.stringify stores it as a string (Codex round 4: a signature over one Date verifies for
  // another). Reject non-plain objects so the canonical form can't diverge from what's persisted.
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null)
    throw new Error('non-canonical value in signed payload (non-plain object)');
  return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}
function canonicalFact(f) {
  return stableStringify({
    source_agent: f.source_agent ?? null, fact_type: f.fact_type ?? null, client_id: f.client_id ?? null,
    subject_type: f.subject_type ?? null, subject_id: f.subject_id ?? null,
    visibility: f.visibility ?? null, data_class: f.data_class ?? null,
    observed_at: f.observed_at ?? null, payload: f.payload ?? {},
  });
}

/** Producer side (holds the private key): sign a fact. Returns a base64 signature. */
function signFact(privateKey, fact) {
  return sign(null, Buffer.from(canonicalFact(fact)), privateKey).toString('base64');
}

/** Trusted side: is this fact authentically from its claimed source_agent? */
function verifyFact(db, fact, signatureB64) {
  ensureIdentitiesTable(db);
  const id = db.prepare('SELECT * FROM identities WHERE agent = ?').get(fact.source_agent);
  if (!id) return { ok: false, reason: 'unregistered_source_agent' };
  let valid = false;
  try {
    valid = verify(null, Buffer.from(canonicalFact(fact)), createPublicKey(id.public_key), Buffer.from(signatureB64 || '', 'base64'));
  } catch (_) { valid = false; }
  if (!valid) return { ok: false, reason: 'bad_signature' };
  return { ok: true, identity: id };
}

function authzProduce(identity, fact) {
  if (identity.can_produce) {
    const allowed = JSON.parse(identity.can_produce);
    if (!allowed.includes(fact.fact_type)) return { ok: false, reason: 'fact_type_not_permitted' };
  }
  // a client-bound identity can ONLY produce its own client's facts
  if (identity.client_id != null && fact.client_id !== identity.client_id) return { ok: false, reason: 'client_binding_violation' };
  return { ok: true };
}

/**
 * The authenticated write door: verify the signature, enforce authZ, then schema-validate + write —
 * verify-identity → authZ → schema → core writeFact. Schema is ON BY DEFAULT (defaultRegistry); pass
 * `registry: null` only for test/trusted paths (Codex: a direct call must not skip schema).
 * Rejected at the door → nothing persists, audited (without key/sig).
 */
function writeSignedFact(db, fact, signatureB64, { registry = defaultRegistry } = {}) {
  const v = verifyFact(db, fact, signatureB64);
  if (!v.ok) { audit(db, 'write_rejected_unauthenticated', { source_agent: fact.source_agent, reason: v.reason }); return { ok: false, error: `unauthenticated: ${v.reason}` }; }
  const az = authzProduce(v.identity, fact);
  if (!az.ok) { audit(db, 'write_rejected_unauthorized', { source_agent: fact.source_agent, reason: az.reason }); return { ok: false, error: `unauthorized: ${az.reason}` }; }
  return registry ? writeFactValidated(db, fact, registry) : writeFact(db, fact);
}

/**
 * The authenticated subscribe door: a client-bound identity may ONLY subscribe to its own client
 * (never '*' or another client). Internal identities (no client binding) may subscribe '*' or any
 * scope. Closes the cross-client subscription hole present in the lenient core.
 */
function authorizeSubscribe(db, agent, factType, clientScope) {
  ensureIdentitiesTable(db);
  const id = db.prepare('SELECT * FROM identities WHERE agent = ?').get(agent);
  if (!id) { audit(db, 'subscribe_refused', { agent, reason: 'unregistered' }); return { ok: false, error: 'unregistered agent' }; }
  if (id.client_id != null && clientScope !== id.client_id) {
    audit(db, 'subscribe_refused', { agent, factType, clientScope, reason: 'cross_client_subscribe', bound_to: id.client_id });
    return { ok: false, error: `cross-client subscribe refused: ${agent} is bound to '${id.client_id}', not '${clientScope}'` };
  }
  subscribe(db, agent, factType, clientScope);
  audit(db, 'subscribe_authorized', { agent, factType, clientScope });
  return { ok: true };
}

module.exports = {
  ensureIdentitiesTable, generateIdentity, registerIdentity, canonicalFact, signFact,
  verifyFact, authzProduce, writeSignedFact, authorizeSubscribe,
};

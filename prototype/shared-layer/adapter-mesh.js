'use strict';
/**
 * mesh-api compat adapter — Shared Layer hardening roadmap #7.
 * Code Architect · 2026-05-25.
 *
 * The thin bridge for the ONE live loop (ACD↔Kai) so it can ride the Shared Layer during the cutover
 * without changing ACD or Kai: it translates the legacy A2A v1.0 envelope ↔ a Shared Layer fact, and
 * honors the envelope's idempotency (idempotency_key === message_id) + expiry at the boundary.
 *
 * TRUST BOUNDARY (post-Codex-REVISE): ingestEnvelope is NOT unsigned. It SIGNS each translated fact as
 * the enrolled bridge identity (`mesh-adapter`) and writes through the full door, so legacy traffic
 * becomes authenticated facts attributed to the trusted bridge, with the original sender recorded in
 * provenance (`_via_mesh_from`). The bridge inherits the legacy mesh-api's authentication of the sender
 * (the live loop already authenticated there) and vouches for it by signing. The adapter is the single
 * trusted ingress for legacy traffic; it is removed at sunset, when those agents sign facts natively.
 */

const { randomUUID } = require('node:crypto');
const { signFact, writeSignedFact } = require('./identity');
const { defaultRegistry } = require('./registry');
const { withTx } = require('./db');

const now = () => new Date().toISOString();

// idempotency ledger for legacy envelopes (A2A idempotency_key === message_id)
const SEEN_SCHEMA = `CREATE TABLE IF NOT EXISTS mesh_seen (message_id TEXT PRIMARY KEY, ts TEXT NOT NULL);`;
function ensureSeenTable(db) { db.exec(SEEN_SCHEMA); }

// the action↔fact_type whitelist bridge (extend per the live loop's real actions)
const DEFAULT_ACTION_MAP = {
  'creative.feedback': 'client_feedback',
  'creative.brief': 'creative_brief',
  'decision.record': 'decision',
  'status.update': 'status_update',
  'work.order': 'work_order',
};
const invert = (m) => Object.fromEntries(Object.entries(m).map(([a, t]) => [t, a]));

/** Legacy A2A envelope → Shared Layer fact. */
function factFromEnvelope(env, { actionMap = DEFAULT_ACTION_MAP } = {}) {
  const fact_type = actionMap[env.action];
  if (!fact_type) return { ok: false, error: `no fact_type mapping for action '${env.action}'` };
  const p = env.payload || {};
  return { ok: true, fact: {
    fact_type,
    client_id: env.client_id ?? p.client_id ?? null,
    subject_type: p.subject_type ?? null,
    subject_id: p.subject_id ?? env.correlation_id ?? null,
    visibility: env.visibility ?? p.visibility ?? 'internal',
    data_class: env.data_class ?? p.data_class ?? 'internal',
    source_agent: env.from,
    observed_at: env.observed_at ?? undefined,
    payload: p,
    _mesh_message_id: env.message_id,
  } };
}

/** Shared Layer fact → legacy A2A envelope (so a not-yet-migrated consumer still receives). */
function envelopeFromFact(fact, { actionMap = DEFAULT_ACTION_MAP, to = null } = {}) {
  const t2a = invert(actionMap);
  const message_id = `mesh-${fact.fact_id || randomUUID()}`;
  return {
    message_id, metadata: { idempotency_key: message_id },
    correlation_id: fact.subject_id ?? null,
    action: t2a[fact.fact_type] ?? fact.fact_type,
    from: fact.source_agent, to,
    client_id: fact.client_id ?? null,
    payload: fact.payload ?? {},
    expires_at: null,
  };
}

/**
 * The single trusted ingress for legacy envelopes: dedupe by message_id, drop expired, map → fact,
 * then SIGN as the enrolled bridge identity and write through the full door (verify → authZ →
 * schema). Legacy ingress thus becomes AUTHENTICATED facts (Codex REVISE: no unsigned path) — the
 * translated fact is attributed to the bridge (`mesh-adapter`) with the original sender preserved in
 * provenance (`_via_mesh_from`). `adapterIdentity` = { agent, privateKey } and MUST be enrolled;
 * unsigned ingress is refused outright.
 */
function ingestEnvelope(db, env, { actionMap, registry = defaultRegistry, adapterIdentity } = {}) {
  ensureSeenTable(db);
  if (!env || !env.message_id) return { ok: false, error: 'envelope missing message_id' };
  if (!adapterIdentity || !adapterIdentity.agent || !adapterIdentity.privateKey)
    return { ok: false, error: 'unsigned ingress refused: adapter has no enrolled signing identity' };
  if (db.prepare('SELECT 1 FROM mesh_seen WHERE message_id = ?').get(env.message_id)) return { ok: true, deduped: true };
  if (env.expires_at && Date.parse(env.expires_at) < Date.now()) return { ok: false, error: 'envelope expired' };

  const f = factFromEnvelope(env, { actionMap });
  if (!f.ok) return f;
  // re-attribute to the trusted bridge; keep the original sender in provenance
  const fact = { ...f.fact, source_agent: adapterIdentity.agent,
    payload: { ...f.fact.payload, _via_mesh_from: env.from, _mesh_message_id: env.message_id } };
  // Atomic (Codex): the signed write AND the mesh_seen record commit together, so a crash can't
  // persist a fact that then gets replayed (or record seen for a fact that didn't land).
  let res;
  withTx(db, () => {
    res = writeSignedFact(db, fact, signFact(adapterIdentity.privateKey, fact), { registry });
    if (res.ok) db.prepare('INSERT OR IGNORE INTO mesh_seen (message_id, ts) VALUES (?, ?)').run(env.message_id, now());
  });
  return res.ok ? { ok: true, deduped: false, fact_id: res.fact_id, routed: res.routed } : res;
}

module.exports = { factFromEnvelope, envelopeFromFact, ingestEnvelope, ensureSeenTable, DEFAULT_ACTION_MAP };

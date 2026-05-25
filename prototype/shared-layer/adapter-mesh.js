'use strict';
/**
 * mesh-api compat adapter — Shared Layer hardening roadmap #7.
 * Code Architect · 2026-05-25.
 *
 * The thin bridge for the ONE live loop (ACD↔Kai) so it can ride the Shared Layer during the cutover
 * without changing ACD or Kai: it translates the legacy A2A v1.0 envelope ↔ a Shared Layer fact, and
 * honors the envelope's idempotency (idempotency_key === message_id) + expiry at the boundary.
 *
 * TRUST BOUNDARY (DA-recorded): ingestEnvelope writes UNSIGNED — it inherits the legacy mesh-api's
 * authentication of the sender (the live loop already authenticated through mesh-api). It deliberately
 * does NOT re-verify a Shared Layer identity, because legacy senders don't sign. This compat trust is
 * acceptable ONLY for the bridged loop and is removed at sunset, when those agents send signed facts
 * natively (writeSignedFact). Until then, the adapter is the single trusted ingress for legacy traffic.
 */

const { randomUUID } = require('node:crypto');
const { writeFact } = require('./shared-layer');
const { writeFactValidated } = require('./registry');

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
 * then write (through the schema registry if supplied). Unsigned (see TRUST BOUNDARY above).
 */
function ingestEnvelope(db, env, { actionMap, registry } = {}) {
  ensureSeenTable(db);
  if (!env || !env.message_id) return { ok: false, error: 'envelope missing message_id' };
  if (db.prepare('SELECT 1 FROM mesh_seen WHERE message_id = ?').get(env.message_id)) return { ok: true, deduped: true };
  if (env.expires_at && Date.parse(env.expires_at) < Date.now()) return { ok: false, error: 'envelope expired' };

  const f = factFromEnvelope(env, { actionMap });
  if (!f.ok) return f;
  const res = registry ? writeFactValidated(db, f.fact, registry) : writeFact(db, f.fact);
  if (res.ok) db.prepare('INSERT OR IGNORE INTO mesh_seen (message_id, ts) VALUES (?, ?)').run(env.message_id, now());
  return res.ok ? { ok: true, deduped: false, fact_id: res.fact_id, routed: res.routed } : res;
}

module.exports = { factFromEnvelope, envelopeFromFact, ingestEnvelope, ensureSeenTable, DEFAULT_ACTION_MAP };

'use strict';
/**
 * Envelope validation for the Board write gateway (Codex #2). The registry validates only the
 * PAYLOAD shape; this validates + sanitizes the FACT ENVELOPE before any DB access, and constructs a
 * clean fact object from allowlisted fields only (never passes the raw body through). Also guards
 * prototype-pollution keys (Codex #2). source_agent is intentionally NOT accepted — the gateway sets
 * it server-side from the authenticated token (Codex #1).
 */
const { FACT_TYPES } = require('./shared-layer');

const VISIBILITY = new Set(['client', 'internal', 'fleet']);   // mirrors shared-layer's VISIBILITY
const DATA_CLASS = new Set(['internal', 'client_confidential', 'public', 'operational']);
const ALLOWED_TOP = new Set(['fact_type', 'visibility', 'payload', 'client_id', 'subject_type', 'subject_id', 'observed_at', 'data_class']);
const POLLUTION_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const MAX_ID_LEN = 200;
const MAX_PAYLOAD_BYTES = 16 * 1024;   // serialized payload cap
const MAX_DEPTH = 12;

const isPlainObject = v => v != null && typeof v === 'object' && !Array.isArray(v)
  && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

/** Recursively reject prototype-pollution keys and over-deep nesting. Returns an error string or null. */
function scanSafe(v, depth = 0) {
  if (depth > MAX_DEPTH) return 'payload too deeply nested';
  if (Array.isArray(v)) {
    for (const it of v) { const e = scanSafe(it, depth + 1); if (e) return e; }
    return null;
  }
  if (v != null && typeof v === 'object') {
    for (const k of Object.keys(v)) {
      if (POLLUTION_KEYS.has(k)) return `illegal key '${k}'`;
      const e = scanSafe(v[k], depth + 1); if (e) return e;
    }
  }
  return null;
}

const isIso = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?)?$/.test(s) && !Number.isNaN(Date.parse(s));
const okStr = (s, max = MAX_ID_LEN) => typeof s === 'string' && s.length > 0 && s.length <= max;

/**
 * Validate + sanitize. Returns { ok:true, fact } with a clean fact (NO source_agent — caller sets it)
 * or { ok:false, error }. `body` must already have request-level fields (idempotency_key) removed.
 */
function validateEnvelope(body) {
  if (!isPlainObject(body)) return { ok: false, error: 'body must be a JSON object' };

  // prototype-pollution + depth guard across the whole body
  const unsafe = scanSafe(body); if (unsafe) return { ok: false, error: unsafe };

  // reject unknown top-level keys (explicitly catches a stray source_agent)
  for (const k of Object.keys(body)) {
    if (!ALLOWED_TOP.has(k)) {
      return { ok: false, error: k === 'source_agent'
        ? "do not send 'source_agent' — it is set server-side from your token"
        : `unknown field '${k}'` };
    }
  }

  // required
  if (!FACT_TYPES.has(body.fact_type)) return { ok: false, error: `invalid or missing fact_type` };
  if (!VISIBILITY.has(body.visibility)) return { ok: false, error: `invalid or missing visibility` };
  if (!isPlainObject(body.payload)) return { ok: false, error: `payload must be an object` };

  // optional, type/format checked
  const fact = { fact_type: body.fact_type, visibility: body.visibility, payload: body.payload };

  if (body.data_class !== undefined) {
    if (!DATA_CLASS.has(body.data_class)) return { ok: false, error: `invalid data_class` };
    fact.data_class = body.data_class;
  } else {
    fact.data_class = 'internal';
  }
  if (body.client_id !== undefined && body.client_id !== null) {
    if (!okStr(body.client_id)) return { ok: false, error: `invalid client_id` };
    fact.client_id = body.client_id;
  }
  if (body.subject_type !== undefined) { if (!okStr(body.subject_type)) return { ok: false, error: `invalid subject_type` }; fact.subject_type = body.subject_type; }
  if (body.subject_id !== undefined) { if (!okStr(body.subject_id)) return { ok: false, error: `invalid subject_id` }; fact.subject_id = body.subject_id; }
  if (body.observed_at !== undefined) { if (!isIso(body.observed_at)) return { ok: false, error: `invalid observed_at (need ISO-8601)` }; fact.observed_at = body.observed_at; }

  // payload size
  let payloadBytes;
  try { payloadBytes = Buffer.byteLength(JSON.stringify(body.payload)); }
  catch (_) { return { ok: false, error: `payload not serializable` }; }
  if (payloadBytes > MAX_PAYLOAD_BYTES) return { ok: false, error: `payload too large (${payloadBytes} > ${MAX_PAYLOAD_BYTES})` };

  // client_confidential MUST carry a client_id (mirror core preflight, surfaced earlier)
  if (fact.data_class === 'client_confidential' && !fact.client_id) {
    return { ok: false, error: `client_confidential requires client_id` };
  }

  return { ok: true, fact };
}

module.exports = { validateEnvelope, scanSafe, isPlainObject, okStr, ALLOWED_TOP, MAX_ID_LEN, MAX_PAYLOAD_BYTES, MAX_DEPTH, DATA_CLASS, VISIBILITY };

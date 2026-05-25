'use strict';
/**
 * Backfill-as-claims ingest — Shared Layer production-hardening roadmap increment #2.
 * Code Architect · 2026-05-25.
 *
 * The one-time bulk seed of accumulated context (session logs, memory, intakes, decisions)
 * into the Shared Layer. Per the blessed v2 decision, backfilled context enters as
 * **unverified, quarantined, scrubbed, provenance-stamped CLAIMS — never facts**:
 *
 *  - Claims live in their own `claims` table and are NEVER routed/delivered. No agent can
 *    see a claim; it cannot reach the isolation-checked delivery path at all.
 *  - Secrets/PII are scrubbed at ingest (HB#9). The stored payload holds no secret value;
 *    only a redaction SUMMARY (type → count) is kept — never the matched text.
 *  - Ingest is idempotent: a provenance+content hash dedupes, so re-running the backfill
 *    can't duplicate claims.
 *  - Promotion is the ONLY path from claim → fact, and it's human-gated. promoteClaim()
 *    runs the fact through the proven writeFact() preflight (unknown fact_type / missing
 *    client_id are rejected) and only then does it route like any other fact.
 *
 * Built on shared-layer.js; adds the `claims` table without touching the proven core SCHEMA.
 */

const { randomUUID, createHash } = require('node:crypto');
const { writeFact } = require('./shared-layer');
const { writeFactValidated, defaultRegistry } = require('./registry');

const now = () => new Date().toISOString();

const CLAIMS_SCHEMA = `
CREATE TABLE IF NOT EXISTS claims (
  claim_id         TEXT PRIMARY KEY,
  dedupe_key       TEXT NOT NULL UNIQUE,     -- provenance+content hash → idempotent re-ingest
  fact_type        TEXT,                     -- candidate type; may be unknown (→ needs review, can't promote)
  client_id        TEXT,
  subject_type     TEXT,
  subject_id       TEXT,
  visibility       TEXT,
  data_class       TEXT,
  payload          TEXT NOT NULL,            -- SCRUBBED
  redactions       TEXT,                     -- JSON {type: count}; never the secret value
  source_ref       TEXT NOT NULL,            -- provenance: file path + loc
  source_agent     TEXT,
  status           TEXT NOT NULL,            -- 'quarantined' | 'promoted' | 'rejected'
  promoted_fact_id TEXT,
  reviewer         TEXT,
  reason           TEXT,
  ingested_at      TEXT NOT NULL,
  reviewed_at      TEXT
);`;

function ensureClaimsTable(db) {
  db.exec(CLAIMS_SCHEMA);
}

function audit(db, event, detail) {
  db.prepare('INSERT INTO audit_log (ts, event, detail) VALUES (?, ?, ?)')
    .run(now(), event, detail ? JSON.stringify(detail) : null);
}

// ── Scrubbing (HB#9) ────────────────────────────────────────────────────────────────────
// Ordered, named patterns. Each match is replaced by a typed tag; we record the COUNT per
// type, never the matched value. NOT claimed exhaustive — the redaction summary makes gaps
// auditable, and the DA/Codex pass probes coverage. Tighten patterns as real data surfaces.
const SECRET_PATTERNS = [
  // High-value, low-false-positive secrets first (whole blobs before narrower patterns):
  ['private_key',   /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g],
  ['jwt',           /\beyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\b/g],
  ['conn_string',   /\b[a-z][a-z0-9+.\-]*:\/\/[^\s:@/]+:[^\s:@/]+@[^\s/]+/gi], // scheme://user:pass@host
  ['credit_card',   /\b(?:\d{4}[ -]){3}\d{4}\b/g],
  ['anthropic_key', /\bsk-ant-[A-Za-z0-9_\-]{16,}\b/g],
  ['openai_key',    /\bsk-[A-Za-z0-9_\-]{20,}\b/g],
  ['aws_key',       /\bAKIA[0-9A-Z]{16}\b/g],
  ['github_token',  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g],
  ['google_key',    /\bAIza[0-9A-Za-z_\-]{35}\b/g],
  ['slack_token',   /\bxox[baprs]-[A-Za-z0-9\-]{10,}\b/g],
  ['bearer',        /\bBearer\s+[A-Za-z0-9._\-]{12,}\b/g],
  // generic `secret: "value"` / `api_key=value` — keep the key name, redact only the value:
  ['kv_secret',     /\b(api[_-]?key|secret|password|passwd|access[_-]?token|token)\b(\s*[:=]\s*)(['"]?)[^\s'"]{8,}\3/gi],
  ['email',         /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g],
  ['phone',         /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/g],
];

/** Redact secrets/PII from a string. Returns { clean, redactions:{type:count} }. */
function scrubString(s) {
  const redactions = {};
  let clean = s;
  for (const [type, re] of SECRET_PATTERNS) {
    clean = clean.replace(re, (...args) => {
      redactions[type] = (redactions[type] || 0) + 1;
      // kv_secret keeps the key name + delimiter, redacts the value only:
      if (type === 'kv_secret') return `${args[1]}${args[2]}[REDACTED:secret]`;
      return `[REDACTED:${type}]`;
    });
  }
  return { clean, redactions };
}

// A key whose NAME implies a secret → its value is redacted regardless of shape (Codex: value-pattern
// scrubbing missed `{ password: "hunter2supersecret" }`).
const SENSITIVE_KEY = /^(pass(word|wd)?|secret|client[_-]?secret|api[_-]?key|access[_-]?token|token|authorization|auth|private[_-]?key|credentials?)$/i;

/** Deep-scrub an object: redact by value-pattern AND by sensitive field name; merge redaction counts. */
function scrubPayload(payload) {
  const redactions = {};
  const bump = (r) => { for (const k of Object.keys(r)) redactions[k] = (redactions[k] || 0) + r[k]; };
  const walk = (v, keyName) => {
    if (typeof v === 'string') {
      if (keyName && SENSITIVE_KEY.test(keyName)) { redactions.sensitive_field = (redactions.sensitive_field || 0) + 1; return '[REDACTED:sensitive_field]'; }
      const { clean, redactions: r } = scrubString(v); bump(r); return clean;
    }
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = walk(v[k], k); return o; }
    return v;
  };
  return { clean: walk(payload), redactions };
}

function dedupeKey(c, cleanPayload) {
  return createHash('sha256')
    .update(`${c.source_ref}|${c.fact_type ?? ''}|${c.subject_id ?? ''}|${JSON.stringify(cleanPayload)}`)
    .digest('hex');
}

/**
 * Ingest one backfilled item as a QUARANTINED claim. Scrubs first, then stores. NEVER routes
 * (no delivery is ever created for a claim). Idempotent: a repeat of the same provenance+content
 * returns the existing claim with deduped:true instead of inserting a duplicate.
 */
function ingestClaim(db, c) {
  ensureClaimsTable(db);
  if (!c.source_ref) return { ok: false, error: 'claim rejected: missing source_ref (provenance is mandatory)' };

  const { clean, redactions } = scrubPayload(c.payload ?? {});
  const key = dedupeKey(c, clean);

  const existing = db.prepare('SELECT claim_id FROM claims WHERE dedupe_key = ?').get(key);
  if (existing) {
    audit(db, 'claim_deduped', { claim_id: existing.claim_id, source_ref: c.source_ref });
    return { ok: true, claim_id: existing.claim_id, deduped: true, redactions };
  }

  const claim_id = randomUUID();
  db.prepare(`INSERT INTO claims
    (claim_id, dedupe_key, fact_type, client_id, subject_type, subject_id, visibility, data_class,
     payload, redactions, source_ref, source_agent, status, ingested_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'quarantined', ?)`).run(
    claim_id, key, c.fact_type ?? null, c.client_id ?? null, c.subject_type ?? null,
    c.subject_id ?? null, c.visibility ?? null, c.data_class ?? null,
    JSON.stringify(clean), JSON.stringify(redactions), c.source_ref, c.source_agent ?? null, now()
  );
  // NOTE: deliberately no route() — claims are never delivered. Promotion is the only egress.
  audit(db, 'claim_ingested', { claim_id, fact_type: c.fact_type, source_ref: c.source_ref, redactions });
  return { ok: true, claim_id, deduped: false, redactions };
}

/** Review queue. Defaults to the quarantined claims awaiting a promote/reject decision. */
function listClaims(db, { status = 'quarantined' } = {}) {
  ensureClaimsTable(db);
  return db.prepare('SELECT * FROM claims WHERE status = ? ORDER BY ingested_at').all(status)
    .map(r => ({ ...r, payload: JSON.parse(r.payload), redactions: JSON.parse(r.redactions || '{}') }));
}

/**
 * The ONLY claim → fact path, human-gated. Runs the claim through the proven writeFact()
 * preflight (unknown fact_type / client-confidential-without-client_id are rejected there),
 * and only on success does it become a real, routed fact. A failed promotion leaves the claim
 * quarantined with the reason — never a partial/leaky state.
 */
function promoteClaim(db, claim_id, reviewer, { registry = defaultRegistry } = {}) {
  ensureClaimsTable(db);
  const c = db.prepare('SELECT * FROM claims WHERE claim_id = ?').get(claim_id);
  if (!c) return { ok: false, error: 'no such claim' };
  if (c.status !== 'quarantined') return { ok: false, error: `claim is '${c.status}', not quarantined` };

  // Promotion is NOT a raw write — it goes through the same schema door as any fact (Codex REVISE:
  // a promoted claim must not bypass the registry). The promoter (reviewer) is the recorded authority;
  // there's no signature because backfilled history has no signing agent — promotion is human-gated.
  const factSpec = {
    fact_type: c.fact_type, client_id: c.client_id ?? undefined,
    subject_type: c.subject_type, subject_id: c.subject_id,
    visibility: c.visibility, data_class: c.data_class,
    source_agent: c.source_agent || 'backfill',
    payload: { ...JSON.parse(c.payload), _provenance: c.source_ref, _promoted_from_claim: claim_id },
  };
  const res = registry ? writeFactValidated(db, factSpec, registry) : writeFact(db, factSpec);
  if (!res.ok) {
    audit(db, 'claim_promotion_rejected', { claim_id, error: res.error });
    return { ok: false, error: `promotion rejected by preflight: ${res.error}` }; // claim stays quarantined
  }

  db.prepare("UPDATE claims SET status='promoted', promoted_fact_id=?, reviewer=?, reviewed_at=? WHERE claim_id=?")
    .run(res.fact_id, reviewer ?? null, now(), claim_id);
  audit(db, 'claim_promoted', { claim_id, fact_id: res.fact_id, reviewer, routed: res.routed });
  return { ok: true, fact_id: res.fact_id, routed: res.routed };
}

function rejectClaim(db, claim_id, reviewer, reason) {
  ensureClaimsTable(db);
  const c = db.prepare('SELECT status FROM claims WHERE claim_id = ?').get(claim_id);
  if (!c) return { ok: false, error: 'no such claim' };
  if (c.status !== 'quarantined') return { ok: false, error: `claim is '${c.status}', not quarantined` };
  db.prepare("UPDATE claims SET status='rejected', reviewer=?, reason=?, reviewed_at=? WHERE claim_id=?")
    .run(reviewer ?? null, reason ?? null, now(), claim_id);
  audit(db, 'claim_rejected', { claim_id, reviewer, reason });
  return { ok: true };
}

module.exports = {
  ensureClaimsTable, scrubString, scrubPayload, ingestClaim, listClaims, promoteClaim, rejectClaim,
};

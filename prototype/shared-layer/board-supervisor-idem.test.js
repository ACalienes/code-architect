'use strict';
// Integration test for Codex Phase-3 finding #1: the supervisor's approval re-publish must be a clean
// idempotent 200, not a 409. Replicates the EXACT body board-supervisor.js builds (deterministic
// supervisor_action_id from the idempotency key) and publishes it twice through the real gateway.
const test = require('node:test');
const assert = require('node:assert');
const { createHash } = require('node:crypto');
const { openDb, subscribe } = require('./shared-layer');
const { ensureGatewayTables, enrollToken, resolveToken, handlePublish } = require('./board-gateway');

// Must match board-supervisor.js stableActionId() byte-for-byte.
function stableActionId(key) {
  const h = createHash('sha256').update(key).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}
function supervisorBody(action, safeKind, safeId, context) {
  const idemKey = `alex:sd:${action}:${safeId}`.slice(0, 180);
  return {
    fact_type: 'supervisor_decision', visibility: 'internal', data_class: 'internal',
    subject_type: safeKind, subject_id: safeId,
    payload: {
      decision: action, subject_fact_id: safeId, supervisor_action_id: stableActionId(idemKey),
      rationale: `Alex ${action}d ${safeKind} ${safeId.slice(0, 40)} via supervisor`,
      ...(Object.keys(context || {}).length ? { context } : {}),
    },
    idempotency_key: idemKey,
  };
}

test('supervisor approval re-publish → idempotent 200, NOT 409 (Codex Phase-3 #1)', () => {
  const db = openDb(':memory:'); ensureGatewayTables(db);
  subscribe(db, 'cfo', 'supervisor_decision', '*');
  const alexTok = enrollToken(db, { agent: 'alex', scopes: ['publish', 'supervise'] });
  const t = resolveToken(db, alexTok);
  const context = { subject_source_agent: 'cfo', draft_ref: 'logs/drafts/tdb-invoice-1-may-2026.json' };

  const a = handlePublish(db, t, supervisorBody('approve', 'finance', 'f1', context));
  assert.equal(a.status, 200, 'first publish ok');
  const b = handlePublish(db, t, supervisorBody('approve', 'finance', 'f1', context));
  assert.equal(b.status, 200, 're-click is idempotent 200, not 409');
  assert.ok(b.json.idempotent, 'second publish flagged idempotent');
  assert.equal(a.json.fact_id, b.json.fact_id, 'same fact, not a duplicate');
});

test('a genuinely different decision (reject) on the same subject is a distinct fact', () => {
  const db = openDb(':memory:'); ensureGatewayTables(db);
  subscribe(db, 'cfo', 'supervisor_decision', '*');
  const t = resolveToken(db, enrollToken(db, { agent: 'alex', scopes: ['publish', 'supervise'] }));
  const ctx = { subject_source_agent: 'cfo', draft_ref: 'logs/drafts/x.json' };
  const ap = handlePublish(db, t, supervisorBody('approve', 'finance', 'f1', ctx));
  const rj = handlePublish(db, t, supervisorBody('reject', 'finance', 'f1', ctx));
  assert.equal(ap.status, 200); assert.equal(rj.status, 200);
  assert.notEqual(ap.json.fact_id, rj.json.fact_id, 'approve and reject are different keys → different facts');
});

test('a non-supervise alex token CANNOT publish supervisor_decision (forgery gate intact)', () => {
  const db = openDb(':memory:'); ensureGatewayTables(db);
  subscribe(db, 'cfo', 'supervisor_decision', '*');
  const t = resolveToken(db, enrollToken(db, { agent: 'alex' }));   // legacy publish-only, no supervise
  const out = handlePublish(db, t, supervisorBody('approve', 'finance', 'f1', { subject_source_agent: 'cfo', draft_ref: 'logs/drafts/x.json' }));
  assert.notEqual(out.status, 200, 'publish-only alex token is refused for supervisor_decision');
});

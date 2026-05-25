'use strict';
/**
 * mesh compat adapter proof — legacy A2A envelope ↔ fact mapping, idempotency, expiry, round-trip,
 * and schema enforcement on ingress. Exits non-zero on any failure.
 *
 *   node prototype/shared-layer/adapter-mesh.test.js
 */
const { openDb, subscribe, drain } = require('./shared-layer');
const { defaultRegistry } = require('./registry');
const { factFromEnvelope, envelopeFromFact, ingestEnvelope } = require('./adapter-mesh');

let failures = 0;
const check = (label, cond) => { console.log(`  ${cond ? '✓' : '✗ FAIL'}  ${label}`); if (!cond) failures++; };
const h = (s) => console.log(`\n\x1b[1m${s}\x1b[0m`);

const envelope = (over = {}) => ({
  message_id: 'm-1', metadata: { idempotency_key: 'm-1' }, correlation_id: 'memorial-day',
  action: 'creative.feedback', from: 'acd', to: 'kai', client_id: 'dagdc',
  payload: { sentiment: 'loved', note: 'Dan approved' }, expires_at: null, ...over,
});

// ── 1. Envelope → fact mapping ──
h('1. factFromEnvelope — action maps to fact_type, fields carried');
{
  const f = factFromEnvelope(envelope());
  check('action → fact_type', f.ok && f.fact.fact_type === 'client_feedback');
  check('from → source_agent, correlation_id → subject_id', f.fact.source_agent === 'acd' && f.fact.subject_id === 'memorial-day');
  check('payload + client_id carried', f.fact.client_id === 'dagdc' && f.fact.payload.sentiment === 'loved');
  check('unknown action rejected', !factFromEnvelope(envelope({ action: 'mystery.thing' })).ok);
}

// ── 2. Ingest writes + routes through the core ──
h('2. ingestEnvelope — a legacy envelope becomes a routed fact');
{
  const db = openDb();
  subscribe(db, 'nami', 'client_feedback', '*');
  const r = ingestEnvelope(db, envelope());
  check('ingested + routed', r.ok && !r.deduped && r.routed === 1);
  check('recipient drains it', drain(db, 'nami').length === 1);
}

// ── 3. Idempotency — same message_id twice → one fact ──
h('3. idempotency — idempotency_key (message_id) dedupes a replayed envelope');
{
  const db = openDb();
  subscribe(db, 'nami', 'client_feedback', '*');
  ingestEnvelope(db, envelope());
  const again = ingestEnvelope(db, envelope());
  check('second ingest is deduped', again.ok && again.deduped === true);
  check('only one fact persisted', db.prepare('SELECT COUNT(*) AS n FROM facts').get().n === 1);
}

// ── 4. Expiry — a stale envelope is dropped ──
h('4. expiry — an expired envelope is not ingested');
{
  const db = openDb();
  const r = ingestEnvelope(db, envelope({ message_id: 'm-exp', expires_at: '2000-01-01T00:00:00Z' }));
  check('expired envelope rejected', !r.ok && /expired/.test(r.error));
  check('nothing persisted', db.prepare('SELECT COUNT(*) AS n FROM facts').get().n === 0);
}

// ── 5. Round-trip — fact → envelope → fact is consistent ──
h('5. round-trip — fact → envelope → fact preserves type + payload');
{
  const f1 = factFromEnvelope(envelope()).fact;
  f1.fact_id = 'abc';
  const env = envelopeFromFact(f1);
  check('envelope action round-trips to the same fact_type', factFromEnvelope(env).fact.fact_type === 'client_feedback');
  check('payload preserved through the round-trip', factFromEnvelope(env).fact.payload.sentiment === 'loved');
}

// ── 6. Schema enforced on ingress ──
h('6. schema — a malformed legacy payload is rejected at ingress (registry supplied)');
{
  const db = openDb();
  subscribe(db, 'nami', 'client_feedback', '*');
  const r = ingestEnvelope(db, envelope({ message_id: 'm-bad', payload: { sentiment: 'ecstatic' } }), { registry: defaultRegistry });
  check('bad payload rejected by schema even via the legacy bridge', !r.ok && /schema/.test(r.error));
  check('nothing persisted', db.prepare('SELECT COUNT(*) AS n FROM facts').get().n === 0);
}

h(failures === 0 ? '\x1b[32mADAPTER INVARIANTS HOLD ✓\x1b[0m' : `\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`);
process.exit(failures === 0 ? 0 : 1);

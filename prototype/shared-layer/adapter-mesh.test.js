'use strict';
/**
 * mesh compat adapter proof — legacy A2A envelope ↔ fact mapping, SIGNED ingress (the bridge is an
 * enrolled identity; unsigned ingress refused), idempotency, expiry, round-trip, and schema on
 * ingress. Exits non-zero on any failure.
 *
 *   node prototype/shared-layer/adapter-mesh.test.js
 */
const { openDb, subscribe, drain } = require('./shared-layer');
const { defaultRegistry } = require('./registry');
const { generateIdentity, registerIdentity } = require('./identity');
const { factFromEnvelope, envelopeFromFact, ingestEnvelope } = require('./adapter-mesh');

let failures = 0;
const check = (label, cond) => { console.log(`  ${cond ? '✓' : '✗ FAIL'}  ${label}`); if (!cond) failures++; };
const h = (s) => console.log(`\n\x1b[1m${s}\x1b[0m`);

const envelope = (over = {}) => ({
  message_id: 'm-1', metadata: { idempotency_key: 'm-1' }, correlation_id: 'memorial-day',
  action: 'creative.feedback', from: 'acd', to: 'kai', client_id: 'dagdc',
  payload: { sentiment: 'loved', note: 'Dan approved' }, expires_at: null, ...over,
});

// db with the bridge identity enrolled + a recipient subscribed
function setup() {
  const db = openDb();
  const adapter = generateIdentity();
  registerIdentity(db, { agent: 'mesh-adapter', publicKey: adapter.publicKey }); // internal bridge
  subscribe(db, 'nami', 'client_feedback', '*');
  return { db, adapterIdentity: { agent: 'mesh-adapter', privateKey: adapter.privateKey } };
}

// ── 1. Envelope → fact mapping ──
h('1. factFromEnvelope — action maps to fact_type, fields carried');
{
  const f = factFromEnvelope(envelope());
  check('action → fact_type', f.ok && f.fact.fact_type === 'client_feedback');
  check('from → source_agent (raw mapping), correlation_id → subject_id', f.fact.source_agent === 'acd' && f.fact.subject_id === 'memorial-day');
  check('payload + client_id carried', f.fact.client_id === 'dagdc' && f.fact.payload.sentiment === 'loved');
  check('unknown action rejected', !factFromEnvelope(envelope({ action: 'mystery.thing' })).ok);
}

// ── 2. Signed ingress — writes + routes; bridge attribution + provenance ──
h('2. ingestEnvelope — signs as the bridge, writes a routed AUTHENTICATED fact');
{
  const { db, adapterIdentity } = setup();
  const r = ingestEnvelope(db, envelope(), { adapterIdentity });
  check('ingested + routed', r.ok && !r.deduped && r.routed === 1);
  check('recipient drains it', drain(db, 'nami').length === 1);
  const row = db.prepare('SELECT source_agent, payload FROM facts').get();
  check('fact attributed to the trusted bridge', row.source_agent === 'mesh-adapter');
  check('original sender preserved in provenance', JSON.parse(row.payload)._via_mesh_from === 'acd');
}

// ── 3. Unsigned ingress is refused ──
h('3. unsigned ingress — refused without an enrolled signing identity');
{
  const { db } = setup();
  const r = ingestEnvelope(db, envelope());
  check('no adapter identity → refused', !r.ok && /unsigned ingress refused/.test(r.error));
  check('nothing persisted', db.prepare('SELECT COUNT(*) AS n FROM facts').get().n === 0);
}

// ── 4. Idempotency — same message_id twice → one fact ──
h('4. idempotency — idempotency_key (message_id) dedupes a replayed envelope');
{
  const { db, adapterIdentity } = setup();
  ingestEnvelope(db, envelope(), { adapterIdentity });
  const again = ingestEnvelope(db, envelope(), { adapterIdentity });
  check('second ingest is deduped', again.ok && again.deduped === true);
  check('only one fact persisted', db.prepare('SELECT COUNT(*) AS n FROM facts').get().n === 1);
}

// ── 5. Expiry — a stale envelope is dropped ──
h('5. expiry — an expired envelope is not ingested');
{
  const { db, adapterIdentity } = setup();
  const r = ingestEnvelope(db, envelope({ message_id: 'm-exp', expires_at: '2000-01-01T00:00:00Z' }), { adapterIdentity });
  check('expired envelope rejected', !r.ok && /expired/.test(r.error));
  check('nothing persisted', db.prepare('SELECT COUNT(*) AS n FROM facts').get().n === 0);
}

// ── 6. Round-trip — fact → envelope → fact is consistent ──
h('6. round-trip — fact → envelope → fact preserves type + payload');
{
  const f1 = factFromEnvelope(envelope()).fact;
  f1.fact_id = 'abc';
  const env = envelopeFromFact(f1);
  check('envelope round-trips to the same fact_type', factFromEnvelope(env).fact.fact_type === 'client_feedback');
  check('payload preserved', factFromEnvelope(env).fact.payload.sentiment === 'loved');
}

// ── 7. Schema enforced on ingress BY DEFAULT (no registry passed → bypass closed) ──
h('7. schema — a malformed legacy payload is rejected even when no registry is passed (default on)');
{
  const { db, adapterIdentity } = setup();
  const r = ingestEnvelope(db, envelope({ message_id: 'm-bad', payload: { sentiment: 'ecstatic' } }), { adapterIdentity });
  check('bad payload rejected by the default schema (no registry arg needed)', !r.ok && /schema/.test(r.error));
  check('nothing persisted', db.prepare('SELECT COUNT(*) AS n FROM facts').get().n === 0);
}

h(failures === 0 ? '\x1b[32mADAPTER INVARIANTS HOLD ✓\x1b[0m' : `\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`);
process.exit(failures === 0 ? 0 : 1);

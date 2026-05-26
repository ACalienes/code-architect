'use strict';
/**
 * Agent identity + signed source claims proof. Proves the auth guarantees: attribution can't be
 * forged, tampered, or impersonated; a client-bound identity can't produce or subscribe across the
 * client boundary; the door composes with the schema registry; and no private key ever lands in the
 * store or audit log. Exits non-zero on any failure.
 *
 *   node prototype/shared-layer/identity.test.js
 */
const { openDb, subscribe, drain } = require('./shared-layer');
const { defaultRegistry } = require('./registry');
const { generateIdentity, registerIdentity, signFact, verifyFact, writeSignedFact, authorizeSubscribe, canonicalFact } = require('./identity');

let failures = 0;
const check = (label, cond) => {
  console.log(`  ${cond ? '✓' : '✗ FAIL'}  ${label}`);
  if (!cond) failures++;
};
const h = (s) => console.log(`\n\x1b[1m${s}\x1b[0m`);
const feedback = (over = {}) => ({
  fact_type: 'client_feedback', client_id: 'dagdc', subject_id: 'memorial-day', visibility: 'client',
  data_class: 'client_confidential', source_agent: 'dag-repo', observed_at: '2026-05-25T00:00:00.000Z',
  payload: { sentiment: 'loved' }, ...over,
});

// ── 1. Enrollment stores only the public key ──
h('1. Enrollment — registers the public key + binding, never a private key');
{
  const db = openDb();
  const { publicKey } = generateIdentity();
  registerIdentity(db, { agent: 'dag-repo', publicKey, clientId: 'dagdc' });
  const row = db.prepare("SELECT * FROM identities WHERE agent='dag-repo'").get();
  check('identity stored with its public key + client binding', row && row.client_id === 'dagdc' && /PUBLIC KEY/.test(row.public_key));
  check('no private-key material anywhere in the identities table', !/PRIVATE/.test(JSON.stringify(db.prepare('SELECT * FROM identities').all())));
}

// ── 2. Authentic signed write — happy path, routes through the core ──
h('2. Signed write — an authentic fact verifies, is written, and routes');
{
  const db = openDb();
  const { publicKey, privateKey } = generateIdentity();
  registerIdentity(db, { agent: 'dag-repo', publicKey, clientId: 'dagdc' });
  subscribe(db, 'acd', 'client_feedback', '*');
  const fact = feedback();
  const sig = signFact(privateKey, fact);
  const r = writeSignedFact(db, fact, sig);
  check('verified + written + routed', r.ok && r.routed === 1);
  check('recipient receives it', drain(db, 'acd').length === 1);
}

// ── 3. Tampering — change a field after signing → rejected at the door ──
h('3. Integrity — a fact altered after signing is rejected, nothing persists');
{
  const db = openDb();
  const { publicKey, privateKey } = generateIdentity();
  registerIdentity(db, { agent: 'dag-repo', publicKey, clientId: 'dagdc' });
  const fact = feedback();
  const sig = signFact(privateKey, fact);
  const tampered = { ...fact, payload: { sentiment: 'rejected' } }; // changed after signing
  const r = writeSignedFact(db, tampered, sig);
  check('tampered fact rejected (bad_signature)', !r.ok && /unauthenticated/.test(r.error));
  check('nothing persisted', db.prepare('SELECT COUNT(*) AS n FROM facts').get().n === 0);
}

// ── 4. Impersonation — sign as A but claim source_agent B → rejected ──
h('4. Unforgeable attribution — you cannot sign a fact as another agent');
{
  const db = openDb();
  const a = generateIdentity(), b = generateIdentity();
  registerIdentity(db, { agent: 'attacker', publicKey: a.publicKey, clientId: 'dagdc' });
  registerIdentity(db, { agent: 'kai', publicKey: b.publicKey });
  // attacker signs with ITS key but stamps source_agent='kai'
  const fact = feedback({ source_agent: 'kai', client_id: 'dagdc' });
  const sig = signFact(a.privateKey, fact);
  const r = writeSignedFact(db, fact, sig);
  check('impersonation rejected (verified against kai\'s key, not the attacker\'s)', !r.ok && /unauthenticated/.test(r.error));
}

// ── 5. Unregistered source ──
h('5. Unregistered — a fact from an unknown agent is rejected');
{
  const db = openDb();
  const { privateKey } = generateIdentity();
  const fact = feedback({ source_agent: 'ghost' });
  const r = writeSignedFact(db, fact, signFact(privateKey, fact));
  check('unregistered source_agent rejected', !r.ok && /unregistered_source_agent/.test(r.error));
}

// ── 6. AuthZ (produce) — fact_type allowlist ──
h('6. AuthZ — an identity can only produce the fact_types it is permitted');
{
  const db = openDb();
  const { publicKey, privateKey } = generateIdentity();
  registerIdentity(db, { agent: 'dag-repo', publicKey, clientId: 'dagdc', canProduce: ['client_feedback'] });
  const fact = feedback({ fact_type: 'decision', payload: { text: 'x' } });
  const r = writeSignedFact(db, fact, signFact(privateKey, fact));
  check('a permitted-only producer is refused another fact_type', !r.ok && /fact_type_not_permitted/.test(r.error));
}

// ── 7. AuthZ (produce) — client binding (isolation at write) ──
h('7. AuthZ — a client-bound identity cannot produce another client\'s facts');
{
  const db = openDb();
  const { publicKey, privateKey } = generateIdentity();
  registerIdentity(db, { agent: 'dag-repo', publicKey, clientId: 'dagdc' });
  const fact = feedback({ client_id: 'tdb', subject_id: 'tdb-thing' }); // dag-repo trying to write a TDB fact
  const r = writeSignedFact(db, fact, signFact(privateKey, fact));
  check('client-bound producer cannot forge another client\'s fact', !r.ok && /client_binding_violation/.test(r.error));
}

// ── 8. AuthZ (subscribe) — the cross-client subscription hole, closed ──
h('8. AuthZ — a client repo cannot subscribe across the client boundary');
{
  const db = openDb();
  const { publicKey } = generateIdentity();
  registerIdentity(db, { agent: 'dag-repo', publicKey, clientId: 'dagdc' });
  const cross = authorizeSubscribe(db, 'dag-repo', 'client_feedback', 'tdb');
  check('subscribe to ANOTHER client refused', !cross.ok && /cross-client subscribe refused/.test(cross.error));
  check('no subscription row was created for the cross-client attempt', db.prepare("SELECT COUNT(*) AS n FROM subscriptions WHERE agent='dag-repo' AND client_scope='tdb'").get().n === 0);
  const own = authorizeSubscribe(db, 'dag-repo', 'client_feedback', 'dagdc');
  check('subscribe to its OWN client allowed', own.ok && db.prepare("SELECT COUNT(*) AS n FROM subscriptions WHERE agent='dag-repo' AND client_scope='dagdc'").get().n === 1);
}

// ── 9. Internal identity — cross-client by design, but still authenticated ──
h('9. Internal identity — may go cross-client (\'*\'), still must be signed');
{
  const db = openDb();
  const { publicKey, privateKey } = generateIdentity();
  registerIdentity(db, { agent: 'acd', publicKey }); // no clientId → internal
  const sub = authorizeSubscribe(db, 'acd', 'client_feedback', '*');
  check('internal agent may subscribe \'*\'', sub.ok);
  const fact = feedback({ source_agent: 'acd', client_id: 'tdb' }); // internal can produce any client's
  const r = writeSignedFact(db, fact, signFact(privateKey, fact));
  check('internal agent can produce cross-client (authenticated)', r.ok);
}

// ── 10. Composition with the schema registry — full door ──
h('10. Composition — verify → authZ → schema → write (one door)');
{
  const db = openDb();
  const { publicKey, privateKey } = generateIdentity();
  registerIdentity(db, { agent: 'dag-repo', publicKey, clientId: 'dagdc' });
  subscribe(db, 'acd', 'client_feedback', '*');
  const bad = feedback({ payload: { sentiment: 'thrilled' } }); // valid sig, invalid schema enum
  const rBad = writeSignedFact(db, bad, signFact(privateKey, bad), { registry: defaultRegistry });
  check('authentic but schema-invalid payload still rejected at the door', !rBad.ok && /schema/.test(rBad.error));
  const good = feedback();
  const rGood = writeSignedFact(db, good, signFact(privateKey, good), { registry: defaultRegistry });
  check('authentic + schema-valid is written and stamped', rGood.ok && drain(db, 'acd')[0].payload._schema_ver === '1');
}

// ── 11. No secret leakage across the whole flow ──
h('11. HB#9 — no private key reaches the store or the audit log');
{
  const db = openDb();
  const { publicKey, privateKey } = generateIdentity();
  registerIdentity(db, { agent: 'dag-repo', publicKey, clientId: 'dagdc' });
  const fact = feedback();
  writeSignedFact(db, fact, signFact(privateKey, fact));
  const dump = JSON.stringify(db.prepare('SELECT * FROM audit_log').all()) + JSON.stringify(db.prepare('SELECT * FROM identities').all());
  check('audit_log + identities contain no PRIVATE KEY material', !/PRIVATE/.test(dump));
}

// ── 12. Canonicalization rejects non-JSON values (no []-vs-[undefined] signature collision) ──
h('12. Canonicalization — a non-JSON payload value is rejected, closing the [] vs [undefined] collision');
{
  const db = openDb();
  const k = generateIdentity();
  registerIdentity(db, { agent: 'z', publicKey: k.publicKey });
  let threw = false;
  try { canonicalFact({ source_agent: 'z', payload: { meta: [undefined] } }); } catch (_) { threw = true; }
  check('canonicalFact throws on undefined-in-array (would collide with [])', threw);
  const clean = { fact_type: 'status_update', visibility: 'internal', data_class: 'internal', source_agent: 'z', observed_at: '2026-05-25T00:00:00Z', payload: { status: 'ok' } };
  const sig = signFact(k.privateKey, clean);
  const tampered = { ...clean, payload: { status: 'ok', _provenance: [undefined] } };
  check('verifyFact rejects a non-canonical (undefined-bearing) payload', verifyFact(db, tampered, sig).ok === false);
  check('NaN/Infinity also rejected', (() => { try { canonicalFact({ source_agent: 'z', payload: { n: NaN } }); return false; } catch (_) { return true; } })());
  // non-plain objects (Date/RegExp) canonicalize to {} but JSON.stringify stores a string → reject them
  check('a Date in a signed payload is rejected (no 2020-vs-2030 collision)', (() => { try { canonicalFact({ source_agent: 'z', payload: { _provenance: new Date() } }); return false; } catch (_) { return true; } })());
  const cleanD = { fact_type: 'status_update', visibility: 'internal', data_class: 'internal', source_agent: 'z', observed_at: '2026-05-25T00:00:00Z', payload: { status: 'ok' } };
  const sigD = signFact(k.privateKey, cleanD);
  check('verifyFact rejects a Date-bearing tampered payload', verifyFact(db, { ...cleanD, payload: { status: 'ok', _provenance: new Date(2030, 0) } }, sigD).ok === false);
}

h(failures === 0 ? '\x1b[32mALL IDENTITY INVARIANTS HOLD ✓\x1b[0m' : `\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`);
process.exit(failures === 0 ? 0 : 1);

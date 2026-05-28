'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { openDb } = require('./shared-layer');
const { ensureGatewayTables, enrollToken, resolveToken, gatewayWritable, handlePublish, startGateway } = require('./board-gateway');
const { postFact } = require('./board-post');

function setup() {
  const db = openDb(':memory:');
  ensureGatewayTables(db);
  const cfoTok = enrollToken(db, { agent: 'cfo' });                                   // internal, any type
  const dagTok = enrollToken(db, { agent: 'dag-repo', client_id: 'tdb', can_produce: ['client_feedback'] });
  return { db, cfoTok, dagTok };
}
const tok = (db, t) => resolveToken(db, t);

test('valid publish stamps source_agent from the TOKEN, not the body', () => {
  const { db, cfoTok } = setup();
  const out = handlePublish(db, tok(db, cfoTok), { fact_type: 'status_update', visibility: 'internal', subject_id: 'x', payload: { status: 'update', detail: 'hi' } });
  assert.equal(out.status, 200);
  assert.ok(out.json.fact_id);
  const f = db.prepare('SELECT source_agent, fact_type FROM facts WHERE fact_id=?').get(out.json.fact_id);
  assert.equal(f.source_agent, 'cfo');
  assert.equal(f.fact_type, 'status_update');
});

test('body source_agent spoof is REJECTED (Codex #1 — cannot impersonate)', () => {
  const { db, cfoTok } = setup();
  const out = handlePublish(db, tok(db, cfoTok), { fact_type: 'status_update', visibility: 'internal', source_agent: 'kai', payload: { status: 'update', detail: 'x' } });
  assert.equal(out.status, 400);
  assert.match(out.json.error, /source_agent/);
});

test('unknown fact_type rejected at the envelope', () => {
  const { db, cfoTok } = setup();
  const out = handlePublish(db, tok(db, cfoTok), { fact_type: 'nope', visibility: 'internal', payload: {} });
  assert.equal(out.status, 400);
});

test('unknown top-level field rejected', () => {
  const { db, cfoTok } = setup();
  const out = handlePublish(db, tok(db, cfoTok), { fact_type: 'status_update', visibility: 'internal', payload: { status: 'update', detail: 'x' }, sneaky: 1 });
  assert.equal(out.status, 400);
  assert.match(out.json.error, /unknown field 'sneaky'/);
});

test('authz: a can_produce-scoped token cannot post other types', () => {
  const { db, dagTok } = setup();
  const out = handlePublish(db, tok(db, dagTok), { fact_type: 'decision', visibility: 'internal', payload: { text: 'x' } });
  assert.equal(out.status, 403);
  assert.match(out.json.error, /fact_type_not_permitted/);
});

test('client-bound token FORCES its own client_id (cannot post another client)', () => {
  const { db, dagTok } = setup();
  const out = handlePublish(db, tok(db, dagTok), { fact_type: 'client_feedback', visibility: 'client', client_id: 'OTHER', data_class: 'client_confidential', payload: { sentiment: 'loved' } });
  assert.equal(out.status, 200);
  const f = db.prepare('SELECT client_id FROM facts WHERE fact_id=?').get(out.json.fact_id);
  assert.equal(f.client_id, 'tdb');   // forced to the token's binding, not body 'OTHER'
});

test('prototype-pollution key rejected', () => {
  const { db, cfoTok } = setup();
  const body = JSON.parse('{"fact_type":"status_update","visibility":"internal","payload":{"__proto__":{"x":1}}}');
  const out = handlePublish(db, tok(db, cfoTok), body);
  assert.equal(out.status, 400);
  assert.match(out.json.error, /illegal key/);
});

test('idempotency: replay returns cached result; same key + different body = 409', () => {
  const { db, cfoTok } = setup();
  const t = tok(db, cfoTok);
  const body = { fact_type: 'status_update', visibility: 'internal', payload: { status: 'update', detail: 'a' }, idempotency_key: 'k1' };
  const a = handlePublish(db, t, body); assert.equal(a.status, 200);
  const b = handlePublish(db, t, body); assert.equal(b.status, 200); assert.ok(b.json.idempotent);
  assert.equal(a.json.fact_id, b.json.fact_id);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM facts').get().c, 1);   // only ONE fact written
  const c = handlePublish(db, t, { fact_type: 'status_update', visibility: 'internal', payload: { status: 'update', detail: 'DIFFERENT' }, idempotency_key: 'k1' });
  assert.equal(c.status, 409);
});

test('client_confidential without client_id rejected (internal token)', () => {
  const { db, cfoTok } = setup();
  const out = handlePublish(db, tok(db, cfoTok), { fact_type: 'status_update', visibility: 'internal', data_class: 'client_confidential', payload: { status: 'update', detail: 'x' } });
  assert.equal(out.status, 400);
});

test('payload schema enforced by registry (missing required field) → 422', () => {
  const { db, cfoTok } = setup();
  const out = handlePublish(db, tok(db, cfoTok), { fact_type: 'status_update', visibility: 'internal', payload: { detail: 'no status field' } });
  assert.equal(out.status, 422);
});

test('fail-closed: no enrolled tokens => gateway not writable', () => {
  const db = openDb(':memory:'); ensureGatewayTables(db);
  assert.equal(gatewayWritable(db), false);
});

test('action-gate: work_order publishes a fact but no handler is invoked (publish != act)', () => {
  const { db, cfoTok } = setup();
  const out = handlePublish(db, tok(db, cfoTok), { fact_type: 'work_order', visibility: 'internal', subject_id: 'wo1', payload: { task: 'do x', priority: 'high' } });
  assert.equal(out.status, 200);
  const f = db.prepare('SELECT fact_type FROM facts WHERE fact_id=?').get(out.json.fact_id);
  assert.equal(f.fact_type, 'work_order');   // it's just a recorded fact; nothing executed
});

test('HTTP end-to-end: board-post → gateway → Board; bad token 401; /health ok', async () => {
  const { server, db } = startGateway({ dbPath: ':memory:', host: '127.0.0.1', port: 0 });
  if (!server.listening) await new Promise(r => server.once('listening', r));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}`;
  const t = enrollToken(db, { agent: 'cfo' });
  try {
    const ok = await postFact({ url, token: t, fact: { fact_type: 'status_update', visibility: 'internal', subject_id: 'h', payload: { status: 'update', detail: 'via http' } } });
    assert.equal(ok.status, 200); assert.ok(ok.fact_id);

    const bad = await postFact({ url, token: 'wrong-token', fact: { fact_type: 'status_update', visibility: 'internal', payload: { status: 'update', detail: 'x' } } });
    assert.equal(bad.status, 401);

    const h = await fetch(url + '/health'); const hj = await h.json();
    assert.equal(hj.ok, true); assert.equal(hj.writable, true);
  } finally { server.close(); }
});


// ── v2 consume side (read/claim/ack/quarantine + supervisor_decision guard) ────────────────────────
const { subscribe, FACT_TYPES, drain } = require('./shared-layer');
const {
  handleInbox, handleClaim, handleAck, handleQuarantine,
  SCOPE_PUBLISH, SCOPE_READ, SCOPE_ACK, SCOPE_SUPERVISE,
} = require('./board-gateway');

function setupConsume() {
  const db = openDb(':memory:');
  ensureGatewayTables(db);
  subscribe(db, 'cfo',   'status_update',       '*');
  subscribe(db, 'cfo',   'supervisor_decision', '*');
  subscribe(db, 'kai',   'status_update',       '*');
  subscribe(db, 'cfo',   'client_feedback',     '*');     // CFO subscribed to client work generally
  // Publish-only tokens (default scope) and consume-capable tokens (read+ack):
  const cfoPubTok = enrollToken(db, { agent: 'cfo' });                                                    // legacy default: publish only
  const cfoConsTok = enrollToken(db, { agent: 'cfo', scopes: [SCOPE_PUBLISH, SCOPE_READ, SCOPE_ACK] });   // consumer
  const kaiConsTok = enrollToken(db, { agent: 'kai', scopes: [SCOPE_PUBLISH, SCOPE_READ, SCOPE_ACK] });   // consumer
  const alexSupTok = enrollToken(db, { agent: 'alex', scopes: [SCOPE_PUBLISH, SCOPE_SUPERVISE] });        // supervisor
  return { db, cfoPubTok, cfoConsTok, kaiConsTok, alexSupTok };
}
const trow = (db, t) => resolveToken(db, t);
// Seed a fact that routes to a specific agent so we have something in their inbox.
function seedFor(db, sourceTok, recipientAgent) {
  const r = handlePublish(db, trow(db, sourceTok), {
    fact_type: 'status_update', visibility: 'internal',
    subject_type: 'topic', subject_id: 'x', payload: { status: 'update', detail: 'hello' },
  });
  assert.equal(r.status, 200, 'seed publish should succeed');
  // The fact routes to whoever's subscribed; tests assert the specific recipient is in deliveries.
  const delivery = db.prepare("SELECT delivery_id FROM deliveries WHERE fact_id = ? AND recipient_agent = ?").get(r.json.fact_id, recipientAgent);
  assert.ok(delivery, `expected a delivery to ${recipientAgent} for ${r.json.fact_id}`);
  return { fact_id: r.json.fact_id, delivery_id: delivery.delivery_id };
}

test('default-enrolled token has publish-only scope (legacy compat)', () => {
  const { db, cfoPubTok } = setupConsume();
  const r = handleInbox(db, trow(db, cfoPubTok), {});
  assert.equal(r.status, 403);
  assert.match(r.json.error, /read scope/);
});

test('inbox: token without read scope → 403', () => {
  const { db, cfoPubTok } = setupConsume();
  seedFor(db, cfoPubTok, 'cfo');
  const r = handleInbox(db, trow(db, cfoPubTok), {});
  assert.equal(r.status, 403);
});

test('inbox: read scope returns own-agent unacked deliveries', () => {
  const { db, cfoPubTok, cfoConsTok } = setupConsume();
  seedFor(db, cfoPubTok, 'cfo');
  const r = handleInbox(db, trow(db, cfoConsTok), {});
  assert.equal(r.status, 200);
  assert.equal(r.json.agent, 'cfo');
  assert.ok(r.json.count >= 1, 'expected at least one delivery');
  for (const d of r.json.deliveries) assert.equal(d.fact_type, 'status_update');
});

test('inbox: filters on acked_at IS NULL (Codex P0 #3 — drainer race fix)', () => {
  const { db, cfoPubTok, cfoConsTok } = setupConsume();
  const { delivery_id } = seedFor(db, cfoPubTok, 'cfo');
  // Gateway acks first.
  const a = handleAck(db, trow(db, cfoConsTok), delivery_id);
  assert.equal(a.status, 200);
  // Then drainer runs (simulating the existing board-listener tick). Old code would flip status='read'.
  drain(db, 'cfo');
  // Verify the delivery is STILL marked acked, NOT resurrected to 'read'.
  const row = db.prepare('SELECT status, acked_at FROM deliveries WHERE delivery_id = ?').get(delivery_id);
  assert.equal(row.status, 'acked', 'drainer must not overwrite acked status');
  assert.ok(row.acked_at);
  // And inbox no longer returns it.
  const inbox = handleInbox(db, trow(db, cfoConsTok), {});
  assert.ok(!inbox.json.deliveries.find(d => d.delivery_id === delivery_id), 'acked delivery should not appear in inbox');
});

test('claim: first wins 200, second-by-other 409', () => {
  const { db, cfoPubTok, cfoConsTok, kaiConsTok } = setupConsume();
  // need a fact that routes to BOTH cfo and kai so they could race over their own copies — easier: test that kai can't claim cfo's delivery.
  const { delivery_id } = seedFor(db, cfoPubTok, 'cfo');
  const a = handleClaim(db, trow(db, cfoConsTok), delivery_id, {});
  assert.equal(a.status, 200);
  assert.ok(a.json.lease_until);
  // Different agent trying to claim someone else's delivery → 403 (not 409), per design.
  const b = handleClaim(db, trow(db, kaiConsTok), delivery_id, {});
  assert.equal(b.status, 403);
});

test('claim: same-agent renewal returns 200 with renewal:true', () => {
  const { db, cfoPubTok, cfoConsTok } = setupConsume();
  const { delivery_id } = seedFor(db, cfoPubTok, 'cfo');
  const a = handleClaim(db, trow(db, cfoConsTok), delivery_id, { lease: '600' });
  assert.equal(a.status, 200); assert.equal(a.json.renewal, false);
  const b = handleClaim(db, trow(db, cfoConsTok), delivery_id, { lease: '600' });
  assert.equal(b.status, 200); assert.equal(b.json.renewal, true);
});

test('claim: rejected on wrong recipient (token agent != delivery recipient)', () => {
  const { db, cfoPubTok, kaiConsTok } = setupConsume();
  const { delivery_id } = seedFor(db, cfoPubTok, 'cfo');
  const r = handleClaim(db, trow(db, kaiConsTok), delivery_id, {});
  assert.equal(r.status, 403);
});

test('claim: rejected on already-acked delivery (410)', () => {
  const { db, cfoPubTok, cfoConsTok } = setupConsume();
  const { delivery_id } = seedFor(db, cfoPubTok, 'cfo');
  handleAck(db, trow(db, cfoConsTok), delivery_id);
  const r = handleClaim(db, trow(db, cfoConsTok), delivery_id, {});
  assert.equal(r.status, 410);
});

test('ack: first-writer wins; same-agent re-ack idempotent (200, first_ack:false)', () => {
  const { db, cfoPubTok, cfoConsTok } = setupConsume();
  const { delivery_id } = seedFor(db, cfoPubTok, 'cfo');
  const a = handleAck(db, trow(db, cfoConsTok), delivery_id);
  assert.equal(a.status, 200); assert.equal(a.json.first_ack, true);
  const b = handleAck(db, trow(db, cfoConsTok), delivery_id);
  assert.equal(b.status, 200); assert.equal(b.json.first_ack, false);
});

test('ack: 403 on wrong agent, 404 on missing delivery', () => {
  const { db, cfoPubTok, cfoConsTok, kaiConsTok } = setupConsume();
  const { delivery_id } = seedFor(db, cfoPubTok, 'cfo');
  const wrong = handleAck(db, trow(db, kaiConsTok), delivery_id);
  assert.equal(wrong.status, 403);
  const missing = handleAck(db, trow(db, cfoConsTok), 'no-such-delivery-id');
  assert.equal(missing.status, 404);
});

test('quarantine: writes durable row + sets status=dead, distinct from acked', () => {
  const { db, cfoPubTok, cfoConsTok } = setupConsume();
  const { fact_id, delivery_id } = seedFor(db, cfoPubTok, 'cfo');
  const r = handleQuarantine(db, trow(db, cfoConsTok), delivery_id, { error: 'permanent: validation failed', handler: 'cfo-draft' });
  assert.equal(r.status, 200);
  const drow = db.prepare('SELECT status, dead_reason, acked_at FROM deliveries WHERE delivery_id=?').get(delivery_id);
  assert.equal(drow.status, 'dead'); assert.equal(drow.acked_at, null); assert.match(drow.dead_reason, /validation/);
  const qrow = db.prepare('SELECT * FROM gateway_quarantine WHERE delivery_id=?').get(delivery_id);
  assert.ok(qrow); assert.equal(qrow.fact_id, fact_id); assert.equal(qrow.agent, 'cfo');
});

test('supervisor_decision: non-alex token REJECTED (Codex P0 #5 forgery guard)', () => {
  const { db, kaiConsTok } = setupConsume();
  const r = handlePublish(db, trow(db, kaiConsTok), {
    fact_type: 'supervisor_decision', visibility: 'internal',
    subject_id: 'whatever',
    payload: { decision: 'approve', subject_fact_id: 'f1', supervisor_action_id: 'a1' },
  });
  assert.equal(r.status, 403);
  assert.match(r.json.error, /supervisor_decision/);
});

test('supervisor_decision: alex WITHOUT supervise scope REJECTED', () => {
  const { db } = setupConsume();
  const alexNoSup = enrollToken(db, { agent: 'alex', scopes: [SCOPE_PUBLISH] });   // alex but no supervise
  const r = handlePublish(db, trow(db, alexNoSup), {
    fact_type: 'supervisor_decision', visibility: 'internal',
    subject_id: 'whatever',
    payload: { decision: 'approve', subject_fact_id: 'f1', supervisor_action_id: 'a1' },
  });
  assert.equal(r.status, 403);
});

test('supervisor_decision: alex+supervise ACCEPTED, schema enforced', () => {
  const { db, alexSupTok } = setupConsume();
  const ok = handlePublish(db, trow(db, alexSupTok), {
    fact_type: 'supervisor_decision', visibility: 'internal',
    subject_id: 'cfo-draft-3d0f57e1',
    payload: { decision: 'approve', subject_fact_id: 'f-xyz', supervisor_action_id: 'sa-1' },
  });
  assert.equal(ok.status, 200); assert.ok(ok.json.fact_id);
  // Schema enforced: missing required field rejected.
  const bad = handlePublish(db, trow(db, alexSupTok), {
    fact_type: 'supervisor_decision', visibility: 'internal',
    subject_id: 'x',
    payload: { decision: 'approve' /* missing subject_fact_id + supervisor_action_id */ },
  });
  assert.equal(bad.status, 422);
  // Schema: enum on decision.
  const badEnum = handlePublish(db, trow(db, alexSupTok), {
    fact_type: 'supervisor_decision', visibility: 'internal',
    subject_id: 'x',
    payload: { decision: 'maybe', subject_fact_id: 'f-xyz', supervisor_action_id: 'sa-2' },
  });
  assert.equal(badEnum.status, 422);
});

test('publish without publish scope is now blocked', () => {
  const { db } = setupConsume();
  const readOnly = enrollToken(db, { agent: 'observer', scopes: [SCOPE_READ] });
  const r = handlePublish(db, trow(db, readOnly), {
    fact_type: 'status_update', visibility: 'internal', subject_id: 'x',
    payload: { status: 'update', detail: 'should fail' },
  });
  assert.equal(r.status, 403);
  assert.match(r.json.error, /publish scope/);
});


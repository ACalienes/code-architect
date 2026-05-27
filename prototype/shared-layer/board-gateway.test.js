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

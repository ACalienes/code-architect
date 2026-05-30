'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { makeGatewayClient, processInboxOnce } = require('./board-consume-lib');

// In-memory fake gateway client — records calls; no network.
function fakeClient({ deliveries = [], agent = 'cfo', inboxStatus = 200, claimStatus = {}, ackStatus = {} }) {
  const calls = { inbox: 0, claim: [], ack: [], quarantine: [] };
  return {
    calls,
    inbox: async () => { calls.inbox++; return inboxStatus === 200 ? { status: 200, agent, deliveries } : { status: inboxStatus, error: 'boom' }; },
    claim: async (id) => { calls.claim.push(id); const st = claimStatus[id] || 200; return st === 200 ? { status: 200, claim_id: 'cid-' + id } : { status: st, error: 'held' }; },
    ack: async (id, body) => { calls.ack.push({ id, body }); return { status: ackStatus[id] || 200 }; },
    quarantine: async (id, body) => { calls.quarantine.push({ id, body }); return { status: 200 }; },
  };
}
const D = (id, fact_type = 'supervisor_decision', extra = {}) => ({ delivery_id: id, fact_type, payload: {}, ...extra });

test('ok handler → ack, no quarantine', async () => {
  const client = fakeClient({ deliveries: [D('d1')] });
  const s = await processInboxOnce({ client, handlers: { supervisor_decision: async () => ({ ok: true }) } });
  assert.equal(s.acked, 1); assert.equal(s.quarantined, 0);
  assert.deepEqual(client.calls.ack.map(a => a.id), ['d1']);
  assert.deepEqual(client.calls.claim, ['d1']);   // claimed before handling
});

test('permanent failure → quarantine, no ack', async () => {
  const client = fakeClient({ deliveries: [D('d1')] });
  const s = await processInboxOnce({ client, handlers: { supervisor_decision: async () => ({ ok: false, permanent: true, reason: 'bad payload' }) } });
  assert.equal(s.quarantined, 1); assert.equal(s.acked, 0);
  assert.equal(client.calls.quarantine[0].id, 'd1');
  assert.match(client.calls.quarantine[0].body.error, /bad payload/);
});

test('transient failure → left (no ack, no quarantine, retried next tick)', async () => {
  const client = fakeClient({ deliveries: [D('d1')] });
  const s = await processInboxOnce({ client, handlers: { supervisor_decision: async () => ({ ok: false, reason: 'draft not ready' }) } });
  assert.equal(s.left, 1); assert.equal(s.acked, 0); assert.equal(client.calls.quarantine.length, 0);
});

test('no handler for fact_type → skipped and NEVER claimed (no spin)', async () => {
  const client = fakeClient({ deliveries: [D('d1', 'mystery_type')] });
  const s = await processInboxOnce({ client, handlers: { supervisor_decision: async () => ({ ok: true }) } });
  assert.equal(s.skipped, 1); assert.equal(client.calls.claim.length, 0, 'must not claim an unhandled type');
});

test('claim 409 (held by another instance) → conflict, handler NOT run', async () => {
  let ran = false;
  const client = fakeClient({ deliveries: [D('d1')], claimStatus: { d1: 409 } });
  const s = await processInboxOnce({ client, handlers: { supervisor_decision: async () => { ran = true; return { ok: true }; } } });
  assert.equal(s.claim_conflicts, 1); assert.equal(ran, false); assert.equal(client.calls.ack.length, 0);
});

test('handler throws: below maxAttempts → left; at/over → quarantine (anti-poison-pill)', async () => {
  const client = fakeClient({ deliveries: [D('fresh', 'supervisor_decision', { delivery_attempts: 0 }), D('stuck', 'supervisor_decision', { delivery_attempts: 5 })] });
  const s = await processInboxOnce({ client, handlers: { supervisor_decision: async () => { throw new Error('kaboom'); } }, maxAttempts: 5 });
  assert.equal(s.left, 1, 'fresh delivery left for retry');
  assert.equal(s.quarantined, 1, 'stuck delivery quarantined');
  assert.equal(client.calls.quarantine[0].id, 'stuck');
});

test('one bad delivery does not stop the rest of the page', async () => {
  const client = fakeClient({ deliveries: [D('a'), D('b'), D('c')] });
  const handlers = { supervisor_decision: async (d) => d.delivery_id === 'b' ? { ok: false, permanent: true, reason: 'b is bad' } : { ok: true } };
  const s = await processInboxOnce({ client, handlers });
  assert.equal(s.acked, 2); assert.equal(s.quarantined, 1);
  assert.deepEqual(client.calls.ack.map(a => a.id).sort(), ['a', 'c']);
});

test('inbox fetch failure → returns error, processes nothing', async () => {
  const client = fakeClient({ deliveries: [D('d1')], inboxStatus: 503 });
  const s = await processInboxOnce({ client, handlers: { supervisor_decision: async () => ({ ok: true }) } });
  assert.ok(s.error); assert.equal(client.calls.claim.length, 0); assert.equal(client.calls.ack.length, 0);
});

test('ack failure → counted as left (not lost), retried next tick', async () => {
  const client = fakeClient({ deliveries: [D('d1')], ackStatus: { d1: 410 } });   // e.g. became dead between claim and ack
  const s = await processInboxOnce({ client, handlers: { supervisor_decision: async () => ({ ok: true }) } });
  assert.equal(s.acked, 0); assert.equal(s.left, 1);
});

test('makeGatewayClient builds correct authed URLs (incl. claim renewal claim_id)', async () => {
  const seen = [];
  const fetchImpl = async (url, opts) => { seen.push({ url, method: opts.method, auth: opts.headers.authorization }); return { json: async () => ({ ok: true }) , status: 200 }; };
  const c = makeGatewayClient({ url: 'http://h:3351/', token: 'TK', fetchImpl });
  await c.inbox(200);
  await c.claim('d1', 600, 'cid-9');
  await c.ack('d1', { logged: true });
  await c.quarantine('d1', { error: 'x' });
  assert.equal(seen[0].url, 'http://h:3351/inbox?limit=200');
  assert.equal(seen[1].url, 'http://h:3351/claim/d1?lease=600&claim_id=cid-9');
  assert.equal(seen[2].url, 'http://h:3351/ack/d1');
  assert.equal(seen[3].url, 'http://h:3351/quarantine/d1');
  assert.ok(seen.every(s => s.auth === 'Bearer TK'));
});

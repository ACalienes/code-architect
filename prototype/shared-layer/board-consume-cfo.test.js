'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeCfoHandlers } = require('./board-consume-cfo');

// Real tmp CFO dir with one draft, plus a fake publish that records calls + returns a chosen status.
function setup({ publishStatus = 200, publishThrows = false } = {}) {
  const cfoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfo-consume-'));
  const draftsDir = path.join(cfoDir, 'logs', 'drafts');
  fs.mkdirSync(draftsDir, { recursive: true });
  const draftRef = 'logs/drafts/tdb-invoice-1-may-2026.json';
  fs.writeFileSync(path.join(cfoDir, draftRef), JSON.stringify({ customer_id: '1', line_items: [] }));
  const published = [];
  const publish = async ({ fact, idempotencyKey }) => {
    published.push({ fact, idempotencyKey });
    if (publishThrows) throw new Error('network down');
    return { status: publishStatus };
  };
  const handlers = makeCfoHandlers({ cfoDir, publish, now: () => '2026-05-30T00:00:00.000Z' });
  return { cfoDir, draftRef, draftsDir, published, handlers };
}

// Build a delivered supervisor_decision (shape the gateway /inbox hands the consumer).
// draft_ref === null → omit it from context entirely (simulates a malformed/missing-ref approval).
// created_at defaults to a value DISTINCT from the injected now() so tests can prove approved_at is
// stamped from the delivery time (stable across retries), not from retry-time now().
const DELIVERED_AT = '2026-05-29T12:00:00.000Z';
const SD = ({ decision = 'approve', subject_source_agent = 'cfo', draft_ref = 'logs/drafts/tdb-invoice-1-may-2026.json',
  source_agent = 'alex', subject_fact_id = 'f-123', supervisor_action_id = 'act-1', created_at = DELIVERED_AT } = {}) => {
  const context = { subject_source_agent };
  if (draft_ref !== null) context.draft_ref = draft_ref;
  return {
    delivery_id: 'd1', fact_id: 'sd-1', fact_type: 'supervisor_decision', source_agent, created_at,
    subject_type: 'finance', subject_id: 'cfo-draft',
    payload: { decision, subject_fact_id, supervisor_action_id, context },
  };
};

test('approve on CFO own draft → writes .ready.json + echoes ready_to_send + ok', async () => {
  const { draftsDir, published, handlers } = setup();
  const res = await handlers.supervisor_decision(SD(), { log() {} });
  assert.deepEqual(res, { ok: true });
  const readyFile = path.join(draftsDir, 'tdb-invoice-1-may-2026.ready.json');
  assert.ok(fs.existsSync(readyFile), 'ready sidecar written');
  const prov = JSON.parse(fs.readFileSync(readyFile, 'utf8'));
  assert.equal(prov.status, 'ready_to_send');
  assert.equal(prov.approved, true);
  assert.equal(prov.decision_fact_id, 'sd-1');
  assert.equal(prov.supervisor_action_id, 'act-1');
  assert.equal(prov.by, 'alex');
  assert.equal(prov.approved_at, DELIVERED_AT, 'approved_at uses delivery creation time, not retry now()');
  assert.match(prov.note, /final human tap/i);
  assert.equal(published.length, 1, 'one board echo');
  assert.equal(published[0].fact.fact_type, 'status_update');
  assert.equal(published[0].fact.payload.status, 'ready_to_send');
  assert.equal(published[0].fact.payload.draft_ref, 'logs/drafts/tdb-invoice-1-may-2026.json');
  assert.match(published[0].fact.payload.detail, /READY TO SEND/);
  assert.equal(published[0].idempotencyKey, 'cfo:ready:logs/drafts/tdb-invoice-1-may-2026.json');
});

test('approve on ANOTHER agent\'s subject → ack-noop, no file, no send', async () => {
  const { draftsDir, published, handlers } = setup();
  const res = await handlers.supervisor_decision(SD({ subject_source_agent: 'framer' }), { log() {} });
  assert.deepEqual(res, { ok: true });
  assert.equal(fs.existsSync(path.join(draftsDir, 'tdb-invoice-1-may-2026.ready.json')), false);
  assert.equal(published.length, 0);
});

test('reject/dismiss → ack-noop, no file, no send', async () => {
  for (const decision of ['reject', 'dismiss']) {
    const { draftsDir, published, handlers } = setup();
    const res = await handlers.supervisor_decision(SD({ decision }), { log() {} });
    assert.deepEqual(res, { ok: true });
    assert.equal(fs.existsSync(path.join(draftsDir, 'tdb-invoice-1-may-2026.ready.json')), false);
    assert.equal(published.length, 0);
  }
});

test('approve with missing draft_ref → permanent (quarantine), no file, no send', async () => {
  const { published, handlers } = setup();
  const res = await handlers.supervisor_decision(SD({ draft_ref: null }), { log() {} });
  assert.equal(res.ok, false); assert.equal(res.permanent, true);
  assert.equal(published.length, 0);
});

test('approve where the draft file is gone → permanent (surfaced)', async () => {
  const { published, handlers } = setup();
  const res = await handlers.supervisor_decision(SD({ draft_ref: 'logs/drafts/vanished.json' }), { log() {} });
  assert.equal(res.ok, false); assert.equal(res.permanent, true);
  assert.match(res.reason, /missing/);
  assert.equal(published.length, 0);
});

test('path-traversal draft_ref is refused (permanent), touches nothing outside drafts', async () => {
  const { published, handlers } = setup();
  for (const bad of ['../../etc/passwd', 'logs/drafts/../../secret.json', '/etc/hosts', 'logs/drafts/x.json.ready.json']) {
    const res = await handlers.supervisor_decision(SD({ draft_ref: bad }), { log() {} });
    assert.equal(res.ok, false, `refused: ${bad}`);
    assert.equal(res.permanent, true);
  }
  assert.equal(published.length, 0);
});

test('non-alex source for a supervisor_decision → permanent (refuse to act)', async () => {
  const { published, handlers } = setup();
  const res = await handlers.supervisor_decision(SD({ source_agent: 'framer' }), { log() {} });
  assert.equal(res.ok, false); assert.equal(res.permanent, true);
  assert.equal(published.length, 0);
});

test('board echo transient (5xx) → left for retry, but READY marker already written', async () => {
  const { draftsDir, handlers } = setup({ publishStatus: 503 });
  const res = await handlers.supervisor_decision(SD(), { log() {} });
  assert.equal(res.ok, false); assert.notEqual(res.permanent, true);   // transient, not permanent
  assert.ok(fs.existsSync(path.join(draftsDir, 'tdb-invoice-1-may-2026.ready.json')), 'local READY is authoritative, written before echo');
});

test('board echo permanent (4xx) → permanent', async () => {
  const { handlers } = setup({ publishStatus: 422 });
  const res = await handlers.supervisor_decision(SD(), { log() {} });
  assert.equal(res.ok, false); assert.equal(res.permanent, true);
});

test('board echo network throw → left for retry (READY written)', async () => {
  const { draftsDir, handlers } = setup({ publishThrows: true });
  const res = await handlers.supervisor_decision(SD(), { log() {} });
  assert.equal(res.ok, false); assert.notEqual(res.permanent, true);
  assert.ok(fs.existsSync(path.join(draftsDir, 'tdb-invoice-1-may-2026.ready.json')));
});

test('symlink escape: a symlinked dir under drafts can NOT write the sidecar outside the tree (Codex #2)', async () => {
  const { draftsDir, handlers, published } = setup();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cfo-outside-'));
  fs.symlinkSync(outside, path.join(draftsDir, 'linked'));            // logs/drafts/linked -> /tmp/outside
  fs.writeFileSync(path.join(outside, 'invoice.json'), '{}');
  const res = await handlers.supervisor_decision(SD({ draft_ref: 'logs/drafts/linked/invoice.json' }), { log() {} });
  assert.equal(res.ok, false); assert.equal(res.permanent, true);
  assert.match(res.reason, /symlink|outside/i);
  assert.equal(fs.existsSync(path.join(outside, 'invoice.ready.json')), false, 'no sidecar written outside the tree');
  assert.equal(published.length, 0);
});

test('a pre-planted symlink AT the sidecar path is refused, never followed (Codex #2)', async () => {
  const { draftsDir, handlers } = setup();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cfo-out2-'));
  const evil = path.join(outside, 'pwned.json');
  fs.symlinkSync(evil, path.join(draftsDir, 'tdb-invoice-1-may-2026.ready.json'));
  const res = await handlers.supervisor_decision(SD(), { log() {} });
  assert.equal(res.ok, false); assert.equal(res.permanent, true);
  assert.equal(fs.existsSync(evil), false, 'symlink target was not written through');
});

test('sidecar temp write uses O_CREAT|O_EXCL|O_NOFOLLOW — no symlink-follow on the temp path (Codex r2)', async () => {
  const cfoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfo-flags-'));
  fs.mkdirSync(path.join(cfoDir, 'logs', 'drafts'), { recursive: true });
  fs.writeFileSync(path.join(cfoDir, 'logs', 'drafts', 'tdb-invoice-1-may-2026.json'), '{}');
  let captured = null;
  const fsImpl = { ...fs, openSync(p, flags, mode) { captured = flags; return fs.openSync(p, flags, mode); } };
  const handlers = makeCfoHandlers({ cfoDir, publish: async () => ({ status: 200 }), now: () => DELIVERED_AT, fsImpl });
  const res = await handlers.supervisor_decision(SD(), { log() {} });
  assert.deepEqual(res, { ok: true });
  const C = fs.constants;
  assert.equal(captured & C.O_EXCL, C.O_EXCL, 'O_EXCL set (refuses existing/symlink temp)');
  assert.equal(captured & C.O_CREAT, C.O_CREAT, 'O_CREAT set');
  if (C.O_NOFOLLOW) assert.equal(captured & C.O_NOFOLLOW, C.O_NOFOLLOW, 'O_NOFOLLOW set');
  // final sidecar is a real regular file, and no temp residue leaks
  const draftsDir = path.join(cfoDir, 'logs', 'drafts');
  assert.equal(fs.lstatSync(path.join(draftsDir, 'tdb-invoice-1-may-2026.ready.json')).isSymbolicLink(), false);
  assert.equal(fs.readdirSync(draftsDir).some(f => f.includes('.tmp-')), false, 'no leftover temp files');
});

test('temp-symlink attack: O_EXCL refuses a symlink planted AT the temp path; nothing written outside (Codex r2 repro)', async () => {
  const cfoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfo-tmpsym-'));
  fs.mkdirSync(path.join(cfoDir, 'logs', 'drafts'), { recursive: true });
  fs.writeFileSync(path.join(cfoDir, 'logs', 'drafts', 'tdb-invoice-1-may-2026.json'), '{}');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cfo-evil-'));
  const evil = path.join(outside, 'pwned.json');
  // Simulate the attacker winning the race: a symlink already sits at the temp path when we open it.
  const fsImpl = { ...fs, openSync(p, flags, mode) { if (String(p).includes('.tmp-')) fs.symlinkSync(evil, p); return fs.openSync(p, flags, mode); } };
  const handlers = makeCfoHandlers({ cfoDir, publish: async () => ({ status: 200 }), now: () => DELIVERED_AT, fsImpl });
  const res = await handlers.supervisor_decision(SD(), { log() {} });
  assert.equal(res.ok, false); assert.equal(res.permanent, true);
  assert.equal(fs.existsSync(evil), false, 'O_EXCL stopped the write — nothing written through the temp symlink');
});

test('symlinked .json draft resolving to a non-draft file is refused — no overwrite (Codex r3 #2)', async () => {
  const { cfoDir, draftsDir, handlers, published } = setup();
  const notes = path.join(draftsDir, 'notes.txt');
  fs.writeFileSync(notes, 'IMPORTANT NOTES — must not be overwritten');
  fs.symlinkSync(notes, path.join(draftsDir, 'alias.json'));        // alias.json -> notes.txt (in-tree, non-draft)
  const res = await handlers.supervisor_decision(SD({ draft_ref: 'logs/drafts/alias.json' }), { log() {} });
  assert.equal(res.ok, false); assert.equal(res.permanent, true);
  assert.equal(fs.readFileSync(notes, 'utf8'), 'IMPORTANT NOTES — must not be overwritten', 'non-draft file untouched');
  assert.equal(published.length, 0);
});

test('approved_at is stable across echo retries — no provenance drift (Codex #3)', async () => {
  const { draftsDir, handlers } = setup({ publishStatus: 503 });     // echo fails → delivery would retry
  const readyFile = path.join(draftsDir, 'tdb-invoice-1-may-2026.ready.json');
  await handlers.supervisor_decision(SD(), { log() {} });            // tick 1: sidecar written, echo 503
  const p1 = JSON.parse(fs.readFileSync(readyFile, 'utf8'));
  await handlers.supervisor_decision(SD(), { log() {} });            // tick 2 (retry): rewrites sidecar
  const p2 = JSON.parse(fs.readFileSync(readyFile, 'utf8'));
  assert.equal(p1.approved_at, p2.approved_at, 'no provenance drift across retries');
  assert.equal(p1.approved_at, DELIVERED_AT);
});

test('re-approval is idempotent (same provenance, no duplicate divergence)', async () => {
  const { draftsDir, handlers, published } = setup();
  await handlers.supervisor_decision(SD(), { log() {} });
  await handlers.supervisor_decision(SD(), { log() {} });
  const prov = JSON.parse(fs.readFileSync(path.join(draftsDir, 'tdb-invoice-1-may-2026.ready.json'), 'utf8'));
  assert.equal(prov.status, 'ready_to_send');
  assert.equal(published[0].idempotencyKey, published[1].idempotencyKey, 'same idempotency key → gateway dedupes');
});

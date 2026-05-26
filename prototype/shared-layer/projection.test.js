'use strict';
/**
 * Physical per-client projection proof. The decisive test reads the RAW BYTES of one client's
 * projection file and asserts another client's data is physically absent — so even unrestricted
 * file access leaks nothing. Plus: restrictive modes applied, projector refuses cross-client
 * rows (defense-in-depth), the runner rides the projection unchanged, idempotent re-projection,
 * and revocation propagation. Deterministic; cleans up its temp dir. Exits non-zero on failure.
 *
 *   node prototype/shared-layer/projection.test.js
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { openDb, subscribe, writeFact, revoke } = require('./shared-layer');
const { projectClient, openProjectionDb } = require('./projection');
const { createDrainer } = require('./runner');

let failures = 0;
const check = (label, cond) => {
  console.log(`  ${cond ? '✓' : '✗ FAIL'}  ${label}`);
  if (!cond) failures++;
};
const h = (s) => console.log(`\n\x1b[1m${s}\x1b[0m`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-proj-'));
const openHandles = [];
const rawBytes = (file) => fs.readFileSync(file).toString('latin1'); // byte-faithful scan
// Each section gets its own projection root so files never carry across independent tests.
let _n = 0;
const freshDir = () => path.join(tmp, `t${++_n}`);

function seedTwoClients() {
  const db = openDb();
  subscribe(db, 'dag-repo', 'client_feedback', 'dagdc'); // client repo → only dagdc
  subscribe(db, 'tdb-repo', 'client_feedback', 'tdb');    // client repo → only tdb
  const dag = writeFact(db, {
    fact_type: 'client_feedback', client_id: 'dagdc', subject_type: 'campaign', subject_id: 'memorial-day',
    visibility: 'client', data_class: 'client_confidential', source_agent: 'dag-repo',
    payload: { sentiment: 'loved', note: 'Dan approved the DAGDC posts' },
  });
  const tdb = writeFact(db, {
    fact_type: 'client_feedback', client_id: 'tdb', subject_type: 'campaign', subject_id: 'tdb-secret-launch',
    visibility: 'client', data_class: 'client_confidential', source_agent: 'tdb-repo',
    payload: { sentiment: 'TDB-CONFIDENTIAL-must-never-leak' },
  });
  return { db, dag, tdb };
}

(async () => {
  // ── 1. THE decisive test: a client's file physically contains ONLY its client's bytes ──
  h('1. Physical isolation — read DAG\'s raw file bytes; TDB\'s data is simply not there');
  {
    const { db } = seedTwoClients();
    const dir = freshDir();
    const dagFile = projectClient(db, { dir, agent: 'dag-repo', clientId: 'dagdc' }).file;
    const tdbFile = projectClient(db, { dir, agent: 'tdb-repo', clientId: 'tdb' }).file;
    const dagRaw = rawBytes(dagFile), tdbRaw = rawBytes(tdbFile);
    check('DAG file contains its own subject (memorial-day)', dagRaw.includes('memorial-day'));
    check('DAG file has ZERO trace of TDB subject (tdb-secret-launch)', !dagRaw.includes('tdb-secret-launch'));
    check('DAG file has ZERO trace of the TDB confidential payload', !dagRaw.includes('TDB-CONFIDENTIAL-must-never-leak'));
    check('TDB file contains its own subject', tdbRaw.includes('tdb-secret-launch'));
    check('TDB file has ZERO trace of DAG data', !tdbRaw.includes('memorial-day') && !tdbRaw.includes('Dan approved'));
    // and every fact row in DAG's projection is its own client:
    const pdb = openProjectionDb(dagFile); openHandles.push(pdb);
    const clients = pdb.prepare('SELECT DISTINCT client_id FROM facts').all().map(r => r.client_id);
    check('DAG projection facts are ALL client_id=dagdc (no other client present)', clients.length === 1 && clients[0] === 'dagdc');
  }

  // ── 2. Restrictive permissions applied (the OS layer; cross-uid denial is the Mini step) ──
  h('2. Permissions — file 0600, dir 0700 applied (chown-to-client-uid is the deploy step)');
  {
    const { db } = seedTwoClients();
    const { file } = projectClient(db, { dir: freshDir(), agent: 'dag-repo', clientId: 'dagdc' });
    check('inbox.db mode is 0640 (owner rw, client-group read-only — client cannot write the projection)', (fs.statSync(file).mode & 0o777) === 0o640);
    check('client dir mode is 2750 (setgid, group r-x, NO group write → no symlink/swap)', (fs.statSync(path.dirname(file)).mode & 0o7777) === 0o2750);
  }

  // ── 3. The runner (#1) rides the projection UNCHANGED ──
  h('3. Runner drop-in — the same createDrainer drains the projection file, not central');
  {
    const { db } = seedTwoClients();
    const { file } = projectClient(db, { dir: freshDir(), agent: 'dag-repo', clientId: 'dagdc' });
    const pdb = openProjectionDb(file); openHandles.push(pdb);
    const got = [];
    const d = createDrainer({ db: pdb, agent: 'dag-repo', handler: async (f) => got.push(f.subject_id) });
    await d.tickOnce();
    check('client runner drained its fact from its own permissioned file', got.length === 1 && got[0] === 'memorial-day');
    check('and acked it locally → 0 pending in the projection', d.getStats().pending === 0);
  }

  // ── 4. Defense-in-depth: the projector REFUSES a cross-client row (simulated route bug) ──
  h('4. Second guard — a mis-scoped delivery to DAG is refused, never hits DAG\'s file');
  {
    const { db, tdb } = seedTwoClients();
    // Simulate a route() bug: a TDB fact delivered to dag-repo.
    db.prepare(`INSERT INTO deliveries (delivery_id, fact_id, recipient_agent, scope, kind, status, created_at)
      VALUES (?, ?, 'dag-repo', 'tdb', 'fact', 'pending', ?)`).run(randomUUID(), tdb.fact_id, new Date().toISOString());
    const res = projectClient(db, { dir: freshDir(), agent: 'dag-repo', clientId: 'dagdc' });
    check('projector refused the cross-client delivery', res.refused.length === 1 && res.refused[0].fact_client === 'tdb');
    check('central marked it projection_refused (alertable)', db.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE status='projection_refused'").get().n === 1);
    const dagRaw = rawBytes(res.file);
    check('DAG file STILL has zero TDB bytes after the bad attempt', !dagRaw.includes('tdb-secret-launch') && !dagRaw.includes('TDB-CONFIDENTIAL'));
  }

  // ── 5. Idempotent — re-projecting copies nothing new (re-runnable projector) ──
  h('5. Idempotent — running the projector again projects 0 (already externalized)');
  {
    const { db } = seedTwoClients();
    const dir = freshDir();
    const first = projectClient(db, { dir, agent: 'dag-repo', clientId: 'dagdc' });
    const second = projectClient(db, { dir, agent: 'dag-repo', clientId: 'dagdc' });
    check('first run projected 1', first.projected === 1);
    check('second run projected 0 (nothing duplicated)', second.projected === 0);
  }

  // ── 6. Revocation propagates into the projection ──
  h('6. Revocation — revoking a projected fact reaches the client file as a correction');
  {
    const { db, dag } = seedTwoClients();
    const dir = freshDir();
    const { file } = projectClient(db, { dir, agent: 'dag-repo', clientId: 'dagdc' });
    revoke(db, dag.fact_id, 'entered against wrong campaign'); // creates a pending correction delivery
    const re = projectClient(db, { dir, agent: 'dag-repo', clientId: 'dagdc' });
    check('the correction delivery was projected', re.projected === 1);
    const pdb = openProjectionDb(file); openHandles.push(pdb);
    const corr = pdb.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE kind='correction'").get().n;
    check('projection now holds a correction delivery', corr === 1);
    const revoked = pdb.prepare('SELECT revoked_at FROM facts WHERE fact_id=?').get(dag.fact_id).revoked_at;
    check('projected fact is now marked revoked (fact kept fresh on re-projection)', !!revoked);
  }

  // ── 7. Symlink refusal — a swapped inbox.db path is refused (cross-client redirect blocked) ──
  h('7. Symlink guard — the projector refuses to open a swapped (symlinked) inbox.db');
  {
    const { db } = seedTwoClients();
    const dir = freshDir();
    projectClient(db, { dir, agent: 'tdb-repo', clientId: 'tdb' }); // create TDB's real file
    // attacker swaps dag-repo/inbox.db → a symlink pointing at TDB's file
    const dagDir = path.join(dir, 'dag-repo'); fs.mkdirSync(dagDir, { recursive: true });
    fs.symlinkSync(path.join(dir, 'tdb-repo', 'inbox.db'), path.join(dagDir, 'inbox.db'));
    let refused = false;
    try { projectClient(db, { dir, agent: 'dag-repo', clientId: 'dagdc' }); } catch (e) { refused = /symlink/.test(e.message); }
    check('projector refuses the symlinked path (no write through it)', refused);
    const tdbRaw = fs.readFileSync(path.join(dir, 'tdb-repo', 'inbox.db')).toString('latin1');
    check('TDB file got no DAG data written through the link', !tdbRaw.includes('memorial-day'));
  }

  // ── 8. Read-only projection + client-owned ack-store: the client NEVER writes the projection ──
  h('8. Read-only projection — client acks into its OWN store; the projection is never client-written');
  {
    const { db } = seedTwoClients();
    const { file } = projectClient(db, { dir: freshDir(), agent: 'dag-repo', clientId: 'dagdc' });
    const projDb = openProjectionDb(file); openHandles.push(projDb);
    const ackFile = path.join(path.dirname(file), 'ack.db'); // client-owned ack file (ATTACHed by the runner)
    const got = [];
    const d = createDrainer({ db: projDb, agent: 'dag-repo', handler: async (f) => got.push(f.subject_id), ackStore: ackFile });
    await d.tickOnce();
    check('client drained its fact from the read-only projection', got.length === 1 && got[0] === 'memorial-day');
    check('ack was recorded in the CLIENT ack-store, not the projection', openProjectionDb(ackFile).prepare('SELECT COUNT(*) AS n FROM acked').get().n === 1);
    check('the projection delivery is STILL pending (client never wrote it)', projDb.prepare("SELECT status FROM deliveries").get().status === 'pending');
    await d.tickOnce();
    check('re-tick does NOT re-handle (filtered by the ack-store)', got.length === 1);
    // starvation regression (Codex round 5): a NEWER unacked delivery must still be reached even though
    // an older one is already acked (the old fixed-window peek would have starved it).
    const f2 = require('node:crypto').randomUUID();
    projDb.prepare(`INSERT INTO facts (fact_id, fact_type, client_id, subject_id, visibility, data_class, payload, source_agent, created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(f2, 'client_feedback', 'dagdc', 'newer', 'client', 'client_confidential', '{}', 'dag-repo', new Date().toISOString());
    projDb.prepare(`INSERT INTO deliveries (delivery_id, fact_id, recipient_agent, scope, kind, status, created_at) VALUES (?,?,?,?,?,?,?)`)
      .run(require('node:crypto').randomUUID(), f2, 'dag-repo', 'dagdc', 'fact', 'pending', new Date().toISOString());
    await d.tickOnce();
    check('a newer unacked delivery is still drained past the acked one (no window starvation)', got.length === 2 && got.includes('newer'));
  }

  // ── cleanup ──
  for (const hdl of openHandles) { try { hdl.close(); } catch (_) {} }
  fs.rmSync(tmp, { recursive: true, force: true });

  h(failures === 0 ? '\x1b[32mALL PROJECTION INVARIANTS HOLD ✓\x1b[0m' : `\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`);
  process.exit(failures === 0 ? 0 : 1);
})();

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Silence the mesh.db mirror-unavailable warning for tests that aren't
// specifically exercising that path. The test file is the right place to
// set this so production code never picks it up by accident.
process.env.CA_RUN_LEDGER_SILENT = '1';

const {
  startRun,
  recordPlan,
  recordStepResult,
  recordDaStatus,
  recordValidatorResults,
  endRun,
  getRun,
  listRuns,
  findStaleRuns,
  reconcileLocalToMesh,
  FINAL_STATES,
  SCHEMA_VERSION,
  ulid,
  nowETIso,
  openMeshDb,
} = require('../scripts/lib/run-ledger');

const { acquireLock, releaseLock } = require('../scripts/lib/safe-json');

// Detect whether better-sqlite3 is resolvable from this process. CA itself
// is zero-dep, so on a clean install the module is absent; we still want
// tests to validate the local-only path. When sqlite IS available (e.g.
// because Node found a sibling repo's node_modules) we run the mesh.db
// tests too.
let HAS_SQLITE = false;
try {
  require.resolve('better-sqlite3');
  HAS_SQLITE = true;
} catch (_) { /* not installed; mesh.db tests will skip */ }

function mkTmp(prefix = 'ca-rl-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function isolatedOpts(extra = {}) {
  const root = mkTmp();
  return {
    root,
    opts: {
      runsDir: path.join(root, 'runs'),
      runLockPath: path.join(root, 'run.lock'),
      meshDbPath: path.join(root, 'mesh.db'),
      ...extra,
    },
  };
}

function cleanup(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
}

// ============================================================================
// ULID + timestamps
// ============================================================================

test('ulid: returns 26-char Crockford-base32 strings', () => {
  for (let i = 0; i < 50; i++) {
    const id = ulid();
    assert.equal(id.length, 26, `bad length: ${id}`);
    assert.match(id, /^[0-9A-HJKMNPQRSTVWXYZ]+$/, `non-Crockford char in ${id}`);
  }
});

test('ulid: monotonically sortable across distinct calls', () => {
  const ids = [];
  for (let i = 0; i < 10; i++) {
    ids.push(ulid(Date.now() + i));
  }
  const sorted = [...ids].sort();
  assert.deepEqual(ids, sorted, 'ULIDs should be sortable by lexicographic order');
});

test('nowETIso: returns ISO8601 with America/New_York offset', () => {
  const s = nowETIso();
  // Format YYYY-MM-DDTHH:mm:ss[+-]HH:MM. ET is -04:00 (EDT) or -05:00 (EST).
  assert.match(s, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}-0[45]:00$/, `bad format: ${s}`);
});

// ============================================================================
// startRun + happy-path lifecycle
// ============================================================================

test('startRun: writes local JSON + returns runId/localPath', () => {
  const { root, opts } = isolatedOpts();
  try {
    const { runId, localPath } = startRun({
      invoker: 'alex',
      cwd: '/tmp/fake',
      taskClass: 'implement',
      taskDescription: 'test task',
      ...opts,
    });
    assert.ok(runId);
    assert.equal(localPath, path.join(opts.runsDir, `${runId}.json`));
    assert.ok(fs.existsSync(localPath));

    const rec = JSON.parse(fs.readFileSync(localPath, 'utf8'));
    assert.equal(rec.run_id, runId);
    assert.equal(rec.schema_version, SCHEMA_VERSION);
    assert.equal(rec.invoker, 'alex');
    assert.equal(rec.task_class, 'implement');
    assert.equal(rec.final_state, FINAL_STATES.IN_PROGRESS);
    assert.equal(rec.ended_at, null);
    assert.equal(rec.error_text, null);
    assert.ok(rec.ca_version);

    // release the lock for next test (endRun would do this normally)
    releaseLock(opts.runLockPath);
  } finally { cleanup(root); }
});

test('startRun: validates required fields', () => {
  const { root, opts } = isolatedOpts();
  try {
    assert.throws(() => startRun({ cwd: '/x', taskClass: 'implement', taskDescription: 'd', ...opts }),
      /invoker is required/);
    assert.throws(() => startRun({ invoker: 'alex', taskClass: 'implement', taskDescription: 'd', ...opts }),
      /cwd is required/);
    assert.throws(() => startRun({ invoker: 'alex', cwd: '/x', taskClass: 'nope', taskDescription: 'd', ...opts }),
      /invalid taskClass/);
    assert.throws(() => startRun({ invoker: 'alex', cwd: '/x', taskClass: 'implement', ...opts }),
      /taskDescription is required/);
  } finally { cleanup(root); }
});

test('lifecycle: startRun → recordPlan → recordStepResult → endRun (happy path)', () => {
  const { root, opts } = isolatedOpts();
  try {
    const { runId } = startRun({
      invoker: 'alex',
      cwd: '/tmp/fake',
      taskClass: 'implement',
      taskDescription: 'happy path',
      ...opts,
    });

    recordPlan(runId, {
      steps: [
        { step_id: 's001', description: 'echo hello', action_kind: 'exec', idempotency_key: 'h1' },
        { step_id: 's002', description: 'echo world', action_kind: 'exec', idempotency_key: 'h2' },
      ],
    }, opts);

    recordStepResult(runId, {
      step_id: 's001',
      pre_check_at: nowETIso(),
      pre_check_exit: 0,
      action_at: nowETIso(),
      action_result: 'ok',
      post_check_at: nowETIso(),
      post_check_exit: 0,
      outcome: 'ok',
    }, opts);

    recordStepResult(runId, {
      step_id: 's002',
      outcome: 'ok',
    }, opts);

    recordDaStatus(runId, { status: 'passed', notes: '/tmp/da.json' }, opts);
    recordValidatorResults(runId, { overall: 'pass', check_a: { result: 'pass' }, check_b: { result: 'pass' } }, opts);

    endRun(runId, {
      finalState: FINAL_STATES.COMPLETED_CLEAN,
      filesTouched: ['/tmp/fake/a.js'],
    }, opts);

    const rec = getRun(runId, opts);
    assert.equal(rec.final_state, FINAL_STATES.COMPLETED_CLEAN);
    assert.ok(rec.ended_at);
    assert.equal(rec.plan.steps.length, 2);
    assert.equal(rec.execution.step_results.length, 2);
    assert.equal(rec.da_status.status, 'passed');
    assert.equal(rec.manifest_validator_results.overall, 'pass');
    assert.deepEqual(rec.files_touched, ['/tmp/fake/a.js']);

    // Lock should be released after endRun.
    assert.equal(fs.existsSync(opts.runLockPath), false, 'run.lock should be removed by endRun');
  } finally { cleanup(root); }
});

// ============================================================================
// Concurrent lock contention
// ============================================================================

test('startRun: refuses second invocation while run.lock is held', () => {
  const { root, opts } = isolatedOpts();
  try {
    const { runId } = startRun({
      invoker: 'alex',
      cwd: '/tmp/fake',
      taskClass: 'implement',
      taskDescription: 'first',
      ...opts,
    });
    assert.ok(runId);

    // Second invocation should throw ERUNLOCK.
    let caught;
    try {
      startRun({
        invoker: 'alex',
        cwd: '/tmp/fake',
        taskClass: 'implement',
        taskDescription: 'second',
        ...opts,
      });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, 'expected second startRun to throw');
    assert.equal(caught.code, 'ERUNLOCK');
    assert.match(caught.message, /run\.lock/);
    assert.match(caught.message, /--force-clean/);

    // Cleanly end the first run so the lock is released.
    endRun(runId, { finalState: FINAL_STATES.COMPLETED_CLEAN, filesTouched: [] }, opts);
    assert.equal(fs.existsSync(opts.runLockPath), false);
  } finally { cleanup(root); }
});

test('startRun: stale strict lock is NOT auto-reclaimed', () => {
  const { root, opts } = isolatedOpts();
  try {
    // Plant a stale lock manually and back-date its mtime.
    fs.mkdirSync(path.dirname(opts.runLockPath), { recursive: true });
    fs.writeFileSync(opts.runLockPath, JSON.stringify({ pid: 99999, time: 0, nonce: 'stale' }));
    const past = (Date.now() - 24 * 60 * 60 * 1000) / 1000; // 24h ago
    fs.utimesSync(opts.runLockPath, past, past);

    let caught;
    try {
      startRun({
        invoker: 'alex',
        cwd: '/tmp/fake',
        taskClass: 'implement',
        taskDescription: 't',
        ...opts,
      });
    } catch (err) { caught = err; }
    assert.ok(caught, 'expected startRun to refuse stale strict lock');
    assert.equal(caught.code, 'ERUNLOCK');
    // The stale lock file should still be present so --force-clean can handle it.
    assert.equal(fs.existsSync(opts.runLockPath), true);
  } finally { cleanup(root); }
});

// ============================================================================
// Recording helpers — validation
// ============================================================================

test('recordPlan: rejects non-array plan.steps', () => {
  const { root, opts } = isolatedOpts();
  try {
    const { runId } = startRun({
      invoker: 'alex', cwd: '/tmp/fake', taskClass: 'implement', taskDescription: 't', ...opts,
    });
    assert.throws(() => recordPlan(runId, { steps: 'nope' }, opts), /plan\.steps must be an array/);
    assert.throws(() => recordPlan(runId, null, opts), /plan must be an object/);
    endRun(runId, { finalState: FINAL_STATES.COMPLETED_CLEAN, filesTouched: [] }, opts);
  } finally { cleanup(root); }
});

test('recordStepResult: rejects missing step_id', () => {
  const { root, opts } = isolatedOpts();
  try {
    const { runId } = startRun({
      invoker: 'alex', cwd: '/tmp/fake', taskClass: 'implement', taskDescription: 't', ...opts,
    });
    assert.throws(() => recordStepResult(runId, { outcome: 'ok' }, opts), /step_id is required/);
    endRun(runId, { finalState: FINAL_STATES.COMPLETED_CLEAN, filesTouched: [] }, opts);
  } finally { cleanup(root); }
});

test('recordDaStatus: rejects invalid status', () => {
  const { root, opts } = isolatedOpts();
  try {
    const { runId } = startRun({
      invoker: 'alex', cwd: '/tmp/fake', taskClass: 'implement', taskDescription: 't', ...opts,
    });
    assert.throws(() => recordDaStatus(runId, { status: 'nope' }, opts), /status must be one of/);
    endRun(runId, { finalState: FINAL_STATES.COMPLETED_CLEAN, filesTouched: [] }, opts);
  } finally { cleanup(root); }
});

test('recordValidatorResults: requires overall field', () => {
  const { root, opts } = isolatedOpts();
  try {
    const { runId } = startRun({
      invoker: 'alex', cwd: '/tmp/fake', taskClass: 'implement', taskDescription: 't', ...opts,
    });
    assert.throws(() => recordValidatorResults(runId, { check_a: { result: 'pass' } }, opts), /'overall' field/);
    endRun(runId, { finalState: FINAL_STATES.COMPLETED_CLEAN, filesTouched: [] }, opts);
  } finally { cleanup(root); }
});

test('endRun: rejects non-terminal finalState', () => {
  const { root, opts } = isolatedOpts();
  try {
    const { runId } = startRun({
      invoker: 'alex', cwd: '/tmp/fake', taskClass: 'implement', taskDescription: 't', ...opts,
    });
    assert.throws(() => endRun(runId, { finalState: 'in_progress', filesTouched: [] }, opts),
      /not terminal/);
    // Clean up properly so we don't leak the lock for other tests.
    endRun(runId, { finalState: FINAL_STATES.COMPLETED_CLEAN, filesTouched: [] }, opts);
  } finally { cleanup(root); }
});

// ============================================================================
// run_recursive_revert_exhausted final-state transition
// ============================================================================

test('endRun: accepts run_recursive_revert_exhausted final state', () => {
  const { root, opts } = isolatedOpts();
  try {
    const { runId } = startRun({
      invoker: 'alex', cwd: '/tmp/fake', taskClass: 'rollback', taskDescription: 'rollback test', ...opts,
    });
    recordPlan(runId, { steps: [{ step_id: 's1', action_kind: 'exec', idempotency_key: 'k1' }] }, opts);

    // Simulate 3 failed rollback attempts logged as step results.
    for (let i = 1; i <= 3; i++) {
      recordStepResult(runId, { step_id: `s1.attempt${i}`, outcome: 'error', action_result: `attempt ${i} failed` }, opts);
    }

    endRun(runId, {
      finalState: FINAL_STATES.RUN_RECURSIVE_REVERT_EXHAUSTED,
      errorText: '3 rollback attempts all failed; halt + alert Alex per boundary #5',
      filesTouched: [],
    }, opts);

    const rec = getRun(runId, opts);
    assert.equal(rec.final_state, FINAL_STATES.RUN_RECURSIVE_REVERT_EXHAUSTED);
    assert.match(rec.error_text, /3 rollback attempts/);
    assert.equal(rec.execution.step_results.length, 3);
    // Lock released even on this halt state.
    assert.equal(fs.existsSync(opts.runLockPath), false);
  } finally { cleanup(root); }
});

// ============================================================================
// Read-side helpers
// ============================================================================

test('getRun: returns null for missing run', () => {
  const { root, opts } = isolatedOpts();
  try {
    assert.equal(getRun('NONEXISTENT01234567890ABCD', opts), null);
  } finally { cleanup(root); }
});

test('listRuns: filters by taskClass + finalState + limit', () => {
  const { root, opts } = isolatedOpts();
  try {
    const ids = [];
    for (let i = 0; i < 3; i++) {
      const { runId } = startRun({
        invoker: 'alex', cwd: '/tmp/fake', taskClass: 'implement', taskDescription: `t${i}`, ...opts,
      });
      endRun(runId, { finalState: FINAL_STATES.COMPLETED_CLEAN, filesTouched: [] }, opts);
      ids.push(runId);
    }
    // Mix in a rollback run.
    const { runId: rId } = startRun({
      invoker: 'alex', cwd: '/tmp/fake', taskClass: 'rollback', taskDescription: 'rb', ...opts,
    });
    endRun(rId, { finalState: FINAL_STATES.COMPLETED_CLEAN, filesTouched: [] }, opts);

    const allRuns = listRuns({}, opts);
    assert.equal(allRuns.length, 4);
    const implRuns = listRuns({ taskClass: 'implement' }, opts);
    assert.equal(implRuns.length, 3);
    const limited = listRuns({ limit: 2 }, opts);
    assert.equal(limited.length, 2);
    const cleanRuns = listRuns({ finalState: FINAL_STATES.COMPLETED_CLEAN }, opts);
    assert.equal(cleanRuns.length, 4);
    const haltedRuns = listRuns({ finalState: FINAL_STATES.HALTED_DA_FAILED }, opts);
    assert.equal(haltedRuns.length, 0);
  } finally { cleanup(root); }
});

// ============================================================================
// Stale-run detection
// ============================================================================

test('findStaleRuns: identifies in_progress runs older than threshold', () => {
  const { root, opts } = isolatedOpts();
  try {
    const { runId } = startRun({
      invoker: 'alex', cwd: '/tmp/fake', taskClass: 'implement', taskDescription: 'will go stale', ...opts,
    });
    // Backdate started_at to 90 minutes ago by rewriting the JSON.
    const recPath = path.join(opts.runsDir, `${runId}.json`);
    const rec = JSON.parse(fs.readFileSync(recPath, 'utf8'));
    const ninetyMinAgo = new Date(Date.now() - 90 * 60 * 1000).toISOString();
    rec.started_at = ninetyMinAgo;
    fs.writeFileSync(recPath, JSON.stringify(rec));

    const stale = findStaleRuns({ olderThanMinutes: 60 }, opts);
    assert.equal(stale.length, 1);
    assert.equal(stale[0].run_id, runId);

    // A 120-minute threshold should not catch it.
    const stale2 = findStaleRuns({ olderThanMinutes: 120 }, opts);
    assert.equal(stale2.length, 0);

    // Validate input.
    assert.throws(() => findStaleRuns({ olderThanMinutes: 0 }, opts), /positive number/);
    assert.throws(() => findStaleRuns({}, opts), /positive number/);

    // Clean up the lock from the planted run.
    releaseLock(opts.runLockPath);
  } finally { cleanup(root); }
});

test('findStaleRuns: excludes terminal-state runs', () => {
  const { root, opts } = isolatedOpts();
  try {
    const { runId } = startRun({
      invoker: 'alex', cwd: '/tmp/fake', taskClass: 'implement', taskDescription: 't', ...opts,
    });
    endRun(runId, { finalState: FINAL_STATES.COMPLETED_CLEAN, filesTouched: [] }, opts);

    // Backdate started_at as if it had been an old completed run.
    const recPath = path.join(opts.runsDir, `${runId}.json`);
    const rec = JSON.parse(fs.readFileSync(recPath, 'utf8'));
    rec.started_at = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(recPath, JSON.stringify(rec));

    const stale = findStaleRuns({ olderThanMinutes: 60 }, opts);
    assert.equal(stale.length, 0, 'completed runs are not stale');
  } finally { cleanup(root); }
});

// ============================================================================
// mesh.db unreachable → local-only fallback
// ============================================================================

test('startRun: continues when mesh.db is unreachable (local-only fallback)', () => {
  const { root, opts: baseOpts } = isolatedOpts();
  try {
    // Point mesh.db at an unreadable path (a directory). better-sqlite3 will
    // fail to open it; we should still get a successful local run.
    const badPath = path.join(root, 'a-dir-not-a-db');
    fs.mkdirSync(badPath);
    const opts = { ...baseOpts, meshDbPath: badPath };

    const { runId, localPath } = startRun({
      invoker: 'alex', cwd: '/tmp/fake', taskClass: 'implement', taskDescription: 'no-mesh', ...opts,
    });
    assert.ok(fs.existsSync(localPath), 'local JSON must be written even when mesh.db is unreachable');
    endRun(runId, { finalState: FINAL_STATES.COMPLETED_CLEAN, filesTouched: [] }, opts);
    const rec = getRun(runId, opts);
    assert.equal(rec.final_state, FINAL_STATES.COMPLETED_CLEAN);
  } finally { cleanup(root); }
});

// ============================================================================
// mesh.db mirror correctness (only runs when better-sqlite3 is available)
// ============================================================================

test('reconcileLocalToMesh: degrades when better-sqlite3 unavailable', { skip: HAS_SQLITE }, () => {
  const { root, opts } = isolatedOpts();
  try {
    const r = reconcileLocalToMesh(opts);
    assert.equal(r.skipped, true);
    assert.equal(r.upserted, 0);
    assert.match(r.reason, /mesh\.db unavailable/);
  } finally { cleanup(root); }
});

test('reconcileLocalToMesh: upserts local runs into mesh.db', { skip: !HAS_SQLITE }, () => {
  const { root, opts } = isolatedOpts();
  try {
    // Create 2 runs locally.
    const ids = [];
    for (let i = 0; i < 2; i++) {
      const { runId } = startRun({
        invoker: 'alex', cwd: '/tmp/fake', taskClass: 'implement', taskDescription: `t${i}`, ...opts,
      });
      endRun(runId, { finalState: FINAL_STATES.COMPLETED_CLEAN, filesTouched: [`/tmp/f${i}.js`] }, opts);
      ids.push(runId);
    }

    const r = reconcileLocalToMesh(opts);
    assert.equal(r.skipped, false);
    assert.ok(r.upserted >= 2, `expected at least 2 upserts, got ${r.upserted}`);
    assert.deepEqual(r.conflicts, []);

    // Read back from mesh.db to confirm.
    const handle = openMeshDb(opts);
    assert.ok(handle, 'mesh.db should be openable');
    try {
      const rows = handle.db.prepare('SELECT * FROM code_architect_runs ORDER BY started_at').all();
      assert.equal(rows.length, 2);
      assert.equal(rows[0].final_state, FINAL_STATES.COMPLETED_CLEAN);
      assert.equal(rows[0].schema_version, 1);
      // files_touched is stored as JSON string in mesh.db
      const filesA = JSON.parse(rows[0].files_touched);
      assert.equal(filesA.length, 1);
    } finally { handle.close(); }
  } finally { cleanup(root); }
});

test('reconcileLocalToMesh: flags remote-only rows as conflicts', { skip: !HAS_SQLITE }, () => {
  const { root, opts } = isolatedOpts();
  try {
    // Plant a row in mesh.db without a local counterpart.
    const handle = openMeshDb(opts);
    assert.ok(handle);
    try {
      handle.db.prepare(`
        INSERT INTO code_architect_runs (
          run_id, schema_version, started_at, invoker, cwd, task_class,
          task_description, final_state, ca_version
        ) VALUES (
          'PHANTOM00000000000000000', 1, '2026-01-01T00:00:00-05:00', 'alex',
          '/tmp', 'implement', 'phantom row', 'completed_clean', '0.1.0'
        )
      `).run();
    } finally { handle.close(); }

    const r = reconcileLocalToMesh(opts);
    assert.equal(r.skipped, false);
    assert.ok(
      r.conflicts.some(c => c.run_id === 'PHANTOM00000000000000000' && c.kind === 'remote_without_local'),
      `expected phantom conflict, got: ${JSON.stringify(r.conflicts)}`,
    );
  } finally { cleanup(root); }
});

test('startRun: mirror reflects in_progress state; endRun updates it in mesh.db', { skip: !HAS_SQLITE }, () => {
  const { root, opts } = isolatedOpts();
  try {
    const { runId } = startRun({
      invoker: 'alex', cwd: '/tmp/fake', taskClass: 'implement', taskDescription: 'mirror test', ...opts,
    });

    // After startRun, the mesh.db row should exist with in_progress.
    let handle = openMeshDb(opts);
    let row = handle.db.prepare('SELECT * FROM code_architect_runs WHERE run_id = ?').get(runId);
    handle.close();
    assert.ok(row, 'mesh.db row should exist after startRun');
    assert.equal(row.final_state, FINAL_STATES.IN_PROGRESS);
    assert.equal(row.ended_at, null);

    endRun(runId, { finalState: FINAL_STATES.COMPLETED_CLEAN, filesTouched: [] }, opts);

    handle = openMeshDb(opts);
    row = handle.db.prepare('SELECT * FROM code_architect_runs WHERE run_id = ?').get(runId);
    handle.close();
    assert.equal(row.final_state, FINAL_STATES.COMPLETED_CLEAN);
    assert.ok(row.ended_at, 'ended_at should be populated after endRun');
  } finally { cleanup(root); }
});

// ============================================================================
// Schema version + records carry CA version
// ============================================================================

test('every persisted record carries schema_version: 1 and ca_version', () => {
  const { root, opts } = isolatedOpts();
  try {
    const { runId } = startRun({
      invoker: 'alex', cwd: '/tmp/fake', taskClass: 'implement', taskDescription: 't', ...opts,
    });
    const rec = getRun(runId, opts);
    assert.equal(rec.schema_version, 1);
    assert.match(rec.ca_version, /^\d+\.\d+\.\d+/);
    endRun(runId, { finalState: FINAL_STATES.COMPLETED_CLEAN, filesTouched: [] }, opts);
  } finally { cleanup(root); }
});

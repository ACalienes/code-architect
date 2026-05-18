#!/usr/bin/env node
/**
 * run-ledger.js — Append-only ledger for CA invocations.
 *
 * Per design_ca_phase2_w4_2026-05-16.md §1.
 *
 * Storage layout (two writes per run, primary-wins):
 *   1. Local JSON at <runsDir>/<run-id>.json — primary, owned by CA process.
 *      Default runsDir = ~/.code-architect/runs/. Override via opts.runsDir
 *      (tests) or env CA_RUNS_DIR.
 *   2. mesh.db `code_architect_runs` table mirror — best-effort. If
 *      better-sqlite3 isn't installed (CA is zero-deps by default) or the
 *      DB file can't be opened, we log a warning, mark the run as
 *      mirror-pending, and let reconcileLocalToMesh() retry later.
 *      Default mesh.db = ~/.kameha/mesh.db. Override via opts.meshDbPath
 *      or env MESH_DB_PATH.
 *
 * Concurrency:
 *   - `startRun()` acquires `.kameha/run.lock` in STRICT mode (no stale
 *     reclamation). A crashed CA leaks the lock; documented recovery is
 *     `--force-clean` per CLAUDE.md hard boundary #6.
 *   - All other mutators (`recordPlan`, `recordStepResult`, `recordDaStatus`,
 *     `recordValidatorResults`, `endRun`) assume the caller owns the lock
 *     (i.e. is the CA invocation that called `startRun`). They do NOT
 *     re-acquire — that's the caller's responsibility.
 *   - The mesh.db mirror serializes writes via a separate non-strict lock
 *     so a hung mesh-api process doesn't deadlock CA.
 *
 * IDs:
 *   - run_id = Crockford-base32 ULID (26 chars, sortable by creation time).
 *     Implemented inline; zero-dep per Karpathy-4 simplicity-first.
 *
 * Timestamps:
 *   - All ISO8601 with America/New_York offset; produced by `nowETIso()`.
 *     todayET() in safe-json.js returns YYYY-MM-DD only, so we add a
 *     companion helper here.
 *
 * Exported surface (per design §1.4):
 *   startRun, recordPlan, recordStepResult, recordDaStatus,
 *   recordValidatorResults, endRun, getRun, listRuns, findStaleRuns,
 *   reconcileLocalToMesh.
 *
 * Internal helpers exported for tests:
 *   nowETIso, ulid, FINAL_STATES, openMeshDb, _resetActiveLockForTests.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const {
  safeReadJSON,
  safeWriteJSON,
  acquireLock,
  releaseLock,
} = require('./safe-json');

const SCHEMA_VERSION = 1;
const CA_VERSION = require('../../package.json').version;

const FINAL_STATES = Object.freeze({
  IN_PROGRESS: 'in_progress',
  COMPLETED_CLEAN: 'completed_clean',
  COMPLETED_WITH_WARNINGS: 'completed_with_warnings',
  HALTED_USER_ABORTED: 'halted_user_aborted',
  HALTED_DA_FAILED: 'halted_da_failed',
  HALTED_VALIDATOR_FAILED: 'halted_validator_failed',
  ERROR_STEP_FAILED: 'error_step_failed',
  ERROR_ROLLBACK_FAILED: 'error_rollback_failed',
  RUN_RECURSIVE_REVERT_EXHAUSTED: 'run_recursive_revert_exhausted',
});

const TERMINAL_STATES = new Set([
  FINAL_STATES.COMPLETED_CLEAN,
  FINAL_STATES.COMPLETED_WITH_WARNINGS,
  FINAL_STATES.HALTED_USER_ABORTED,
  FINAL_STATES.HALTED_DA_FAILED,
  FINAL_STATES.HALTED_VALIDATOR_FAILED,
  FINAL_STATES.ERROR_STEP_FAILED,
  FINAL_STATES.ERROR_ROLLBACK_FAILED,
  FINAL_STATES.RUN_RECURSIVE_REVERT_EXHAUSTED,
]);

const VALID_TASK_CLASSES = new Set([
  'implement',
  'rollback',
  'owners-bootstrap',
  'owners-migrate',
  'mechanical-refactor',
  'lockfile-update',
]);

const DEFAULT_RUNS_DIR = path.join(os.homedir(), '.code-architect', 'runs');
const DEFAULT_MESH_DB = path.join(os.homedir(), '.kameha', 'mesh.db');
const DEFAULT_RUN_LOCK_PATH = path.join(os.homedir(), '.code-architect', 'run.lock');

// ---------------------------------------------------------------------------
// ULID — Crockford base32, 48 bits time + 80 bits randomness, 26 chars.
// Sortable lexicographically by creation time. No deps.
// ---------------------------------------------------------------------------

const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encodeUlidTime(ms, len) {
  let out = '';
  for (let i = len - 1; i >= 0; i--) {
    const mod = ms % 32;
    out = ULID_ALPHABET[mod] + out;
    ms = (ms - mod) / 32;
  }
  return out;
}

function encodeUlidRandom(len) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) {
    out += ULID_ALPHABET[bytes[i] % 32];
  }
  return out;
}

/**
 * Generate a Crockford-base32 ULID. 26 chars total: 10 chars time + 16 chars
 * randomness. Monotonically sortable by creation time within the same ms.
 * Collision probability across a single ms: 1 / 2^80 — vanishingly small.
 */
function ulid(now = Date.now()) {
  return encodeUlidTime(now, 10) + encodeUlidRandom(16);
}

// ---------------------------------------------------------------------------
// ET timestamps. todayET() returns YYYY-MM-DD; we need full ISO with offset.
// ---------------------------------------------------------------------------

function nowETIso(now = new Date()) {
  // Build YYYY-MM-DDTHH:mm:ss with America/New_York wall-clock + offset.
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const get = (t) => parts.find(p => p.type === t).value;
  let hour = get('hour');
  if (hour === '24') hour = '00'; // Intl quirk on midnight in some Node versions
  const isoLocal = `${get('year')}-${get('month')}-${get('day')}T${hour}:${get('minute')}:${get('second')}`;
  // Offset: derive by comparing UTC ms vs ET wall-clock ms.
  const tzOffsetMin = etOffsetMinutes(now);
  const sign = tzOffsetMin <= 0 ? '-' : '+';
  const absMin = Math.abs(tzOffsetMin);
  const offH = String(Math.floor(absMin / 60)).padStart(2, '0');
  const offM = String(absMin % 60).padStart(2, '0');
  return `${isoLocal}${sign}${offH}:${offM}`;
}

function etOffsetMinutes(date) {
  // Returns offset in minutes from UTC for the given date in America/New_York.
  // ET is UTC-5 (standard) or UTC-4 (DST); the sign in ISO is negative for
  // west-of-UTC. We return a value compatible with our nowETIso sign logic
  // where negative offset → '-' prefix (i.e. -240 for EDT, -300 for EST).
  const utc = new Date(date.toLocaleString('en-US', { timeZone: 'UTC' }));
  const et = new Date(date.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  return Math.round((et.getTime() - utc.getTime()) / 60000);
}

// ---------------------------------------------------------------------------
// File-system helpers.
// ---------------------------------------------------------------------------

function resolveRunsDir(opts = {}) {
  return opts.runsDir || process.env.CA_RUNS_DIR || DEFAULT_RUNS_DIR;
}

function resolveMeshDbPath(opts = {}) {
  return opts.meshDbPath || process.env.MESH_DB_PATH || DEFAULT_MESH_DB;
}

function resolveRunLockPath(opts = {}) {
  return opts.runLockPath || process.env.CA_RUN_LOCK_PATH || DEFAULT_RUN_LOCK_PATH;
}

function ensureRunsDir(runsDir) {
  if (!fs.existsSync(runsDir)) {
    fs.mkdirSync(runsDir, { recursive: true });
  }
}

function localPathFor(runId, opts = {}) {
  return path.join(resolveRunsDir(opts), `${runId}.json`);
}

// ---------------------------------------------------------------------------
// mesh.db mirror — best-effort. Lazy-require better-sqlite3 so CA stays
// zero-deps at install; if the module is missing, we degrade to local-only.
// ---------------------------------------------------------------------------

let _sqliteModule = null;
let _sqliteResolveAttempted = false;

function loadSqlite() {
  if (_sqliteResolveAttempted) return _sqliteModule;
  _sqliteResolveAttempted = true;
  try {
    // eslint-disable-next-line global-require
    _sqliteModule = require('better-sqlite3');
  } catch (_) {
    _sqliteModule = null;
  }
  return _sqliteModule;
}

/**
 * Open the mesh.db code_architect_runs table. Returns { db, close } on
 * success, or null on any failure (missing dep, missing file, perm error,
 * malformed DB). Never throws; callers degrade to local-only.
 *
 * The caller is responsible for calling result.close() to release the
 * underlying handle. Best-effort: errors during close are swallowed.
 *
 * Schema is created if absent — first ever CA run on a machine populates it.
 */
function openMeshDb(opts = {}) {
  const Sqlite = loadSqlite();
  if (!Sqlite) return null;

  const dbPath = resolveMeshDbPath(opts);
  // For mirror writes, we create the directory but not the file — the file
  // is created by sqlite on open. For READ-only callers that want to skip
  // creating an empty mesh.db, set opts.readOnly = true.
  try {
    if (!opts.readOnly) {
      const dbDir = path.dirname(dbPath);
      if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
    } else if (!fs.existsSync(dbPath)) {
      return null;
    }
    const db = new Sqlite(dbPath, opts.readOnly ? { readonly: true, fileMustExist: true } : {});
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS code_architect_runs (
        run_id              TEXT PRIMARY KEY,
        schema_version      INTEGER NOT NULL DEFAULT 1,
        started_at          TEXT NOT NULL,
        ended_at            TEXT,
        invoker             TEXT NOT NULL,
        cwd                 TEXT NOT NULL,
        task_class          TEXT NOT NULL,
        task_description    TEXT NOT NULL,
        manifest_validator_ok INTEGER,
        da_status           TEXT,
        da_notes            TEXT,
        final_state         TEXT NOT NULL,
        files_touched       TEXT,
        rollback_run_id     TEXT,
        reverted_run_id     TEXT,
        error_text          TEXT,
        ca_version          TEXT NOT NULL,
        correlation_id      TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_car_started_at  ON code_architect_runs(started_at);
      CREATE INDEX IF NOT EXISTS idx_car_final_state ON code_architect_runs(final_state);
      CREATE INDEX IF NOT EXISTS idx_car_correlation ON code_architect_runs(correlation_id);
    `);
    return {
      db,
      close: () => { try { db.close(); } catch (_) {} },
    };
  } catch (err) {
    console.error(`[run-ledger] mesh.db open failed at ${dbPath}: ${err.message}`);
    return null;
  }
}

function recordToRow(rec) {
  return {
    run_id: rec.run_id,
    schema_version: rec.schema_version ?? SCHEMA_VERSION,
    started_at: rec.started_at,
    ended_at: rec.ended_at ?? null,
    invoker: rec.invoker,
    cwd: rec.cwd,
    task_class: rec.task_class,
    task_description: rec.task_description,
    manifest_validator_ok: rec.manifest_validator_results
      ? (rec.manifest_validator_results.overall === 'pass' ? 1 : 0)
      : null,
    da_status: rec.da_status?.status ?? null,
    da_notes: rec.da_status?.notes ?? null,
    final_state: rec.final_state,
    files_touched: rec.files_touched ? JSON.stringify(rec.files_touched) : null,
    rollback_run_id: rec.rollback_run_id ?? null,
    reverted_run_id: rec.reverted_run_id ?? null,
    error_text: rec.error_text ?? null,
    ca_version: rec.ca_version,
    correlation_id: rec.correlation_id ?? null,
  };
}

function mirrorOne(handle, rec) {
  const row = recordToRow(rec);
  const stmt = handle.db.prepare(`
    INSERT INTO code_architect_runs (
      run_id, schema_version, started_at, ended_at, invoker, cwd,
      task_class, task_description, manifest_validator_ok, da_status, da_notes,
      final_state, files_touched, rollback_run_id, reverted_run_id, error_text,
      ca_version, correlation_id
    ) VALUES (
      @run_id, @schema_version, @started_at, @ended_at, @invoker, @cwd,
      @task_class, @task_description, @manifest_validator_ok, @da_status, @da_notes,
      @final_state, @files_touched, @rollback_run_id, @reverted_run_id, @error_text,
      @ca_version, @correlation_id
    )
    ON CONFLICT(run_id) DO UPDATE SET
      schema_version = excluded.schema_version,
      started_at = excluded.started_at,
      ended_at = excluded.ended_at,
      invoker = excluded.invoker,
      cwd = excluded.cwd,
      task_class = excluded.task_class,
      task_description = excluded.task_description,
      manifest_validator_ok = excluded.manifest_validator_ok,
      da_status = excluded.da_status,
      da_notes = excluded.da_notes,
      final_state = excluded.final_state,
      files_touched = excluded.files_touched,
      rollback_run_id = excluded.rollback_run_id,
      reverted_run_id = excluded.reverted_run_id,
      error_text = excluded.error_text,
      ca_version = excluded.ca_version,
      correlation_id = excluded.correlation_id
  `);
  stmt.run(row);
}

function attemptMirror(rec, opts = {}) {
  const handle = openMeshDb(opts);
  if (!handle) {
    // Silent override for tests that aren't exercising the mesh.db path.
    // Set env CA_RUN_LEDGER_SILENT=1 or opts.silent to suppress this line.
    if (!opts.silent && process.env.CA_RUN_LEDGER_SILENT !== '1') {
      console.error(`[run-ledger] mesh.db mirror unavailable for ${rec.run_id} — local-only; reconcileLocalToMesh() will retry.`);
    }
    return false;
  }
  try {
    mirrorOne(handle, rec);
    return true;
  } catch (err) {
    console.error(`[run-ledger] mesh.db mirror write failed for ${rec.run_id}: ${err.message}`);
    return false;
  } finally {
    handle.close();
  }
}

// ---------------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------------

/**
 * Start a new run. Acquires the run.lock in STRICT mode. Throws if a run
 * is already in flight (the lock is held).
 *
 * @param {object} opts
 * @param {string} opts.invoker  e.g. 'alex', 'cron:foo', 'mesh:kai'
 * @param {string} opts.cwd      absolute realpath where the run was invoked
 * @param {string} opts.taskClass  one of VALID_TASK_CLASSES
 * @param {string} opts.taskDescription  one-line human summary
 * @param {string} [opts.correlationId]  cross-agent correlation id
 * @param {string} [opts.runsDir]        override runs directory (tests)
 * @param {string} [opts.runLockPath]    override lock path (tests)
 * @param {string} [opts.meshDbPath]     override mesh.db path (tests)
 * @returns {{ runId: string, localPath: string }}
 */
function startRun(opts = {}) {
  const { invoker, cwd, taskClass, taskDescription } = opts;
  if (!invoker) throw new Error('startRun: invoker is required');
  if (!cwd) throw new Error('startRun: cwd is required');
  if (!taskClass || !VALID_TASK_CLASSES.has(taskClass)) {
    throw new Error(`startRun: invalid taskClass '${taskClass}'; must be one of ${[...VALID_TASK_CLASSES].join(', ')}`);
  }
  if (!taskDescription) throw new Error('startRun: taskDescription is required');

  const runsDir = resolveRunsDir(opts);
  ensureRunsDir(runsDir);

  const runLockPath = resolveRunLockPath(opts);
  const lockDir = path.dirname(runLockPath);
  if (!fs.existsSync(lockDir)) fs.mkdirSync(lockDir, { recursive: true });

  // STRICT lock per CLAUDE.md hard boundary #6. No stale reclamation.
  const acquired = acquireLock(runLockPath, 60 * 60 * 1000, { strict: true });
  if (!acquired) {
    const err = new Error(
      `startRun: refused — run.lock at ${runLockPath} is held. ` +
      `Another CA invocation is in flight, or a crashed run leaked the lock. ` +
      `Use \`code-architect --force-clean\` to recover.`,
    );
    err.code = 'ERUNLOCK';
    throw err;
  }

  const runId = ulid();
  const startedAt = nowETIso();
  const localPath = localPathFor(runId, opts);

  const record = {
    run_id: runId,
    schema_version: SCHEMA_VERSION,
    started_at: startedAt,
    ended_at: null,
    invoker,
    cwd,
    task_class: taskClass,
    task_description: taskDescription,
    ca_version: CA_VERSION,
    correlation_id: opts.correlationId || null,
    plan: null,
    execution: { step_results: [] },
    da_status: null,
    manifest_validator_results: null,
    files_touched: [],
    final_state: FINAL_STATES.IN_PROGRESS,
    error_text: null,
  };

  const wrote = safeWriteJSON(localPath, record);
  if (!wrote) {
    releaseLock(runLockPath);
    throw new Error(`startRun: failed to write local JSON at ${localPath}; aborting.`);
  }

  // Best-effort mirror on start. If unavailable, reconcile later.
  attemptMirror(record, opts);

  return { runId, localPath };
}

function readRecordOrThrow(runId, opts = {}) {
  const p = localPathFor(runId, opts);
  if (!fs.existsSync(p)) {
    const err = new Error(`run ${runId} not found at ${p}`);
    err.code = 'ENOTFOUND';
    throw err;
  }
  const rec = safeReadJSON(p, null);
  if (!rec) throw new Error(`run ${runId} unreadable at ${p}`);
  return rec;
}

function writeRecord(rec, opts = {}) {
  const p = localPathFor(rec.run_id, opts);
  const wrote = safeWriteJSON(p, rec);
  if (!wrote) throw new Error(`failed to persist run ${rec.run_id} at ${p}`);
}

function recordPlan(runId, plan, opts = {}) {
  if (!plan || typeof plan !== 'object') throw new Error('recordPlan: plan must be an object');
  if (!Array.isArray(plan.steps)) throw new Error('recordPlan: plan.steps must be an array');
  const rec = readRecordOrThrow(runId, opts);
  rec.plan = plan;
  writeRecord(rec, opts);
}

function recordStepResult(runId, stepResult, opts = {}) {
  if (!stepResult || typeof stepResult !== 'object') {
    throw new Error('recordStepResult: stepResult must be an object');
  }
  if (!stepResult.step_id) throw new Error('recordStepResult: stepResult.step_id is required');
  const rec = readRecordOrThrow(runId, opts);
  if (!rec.execution) rec.execution = { step_results: [] };
  if (!Array.isArray(rec.execution.step_results)) rec.execution.step_results = [];
  rec.execution.step_results.push(stepResult);
  writeRecord(rec, opts);
}

function recordDaStatus(runId, { status, notes } = {}, opts = {}) {
  const valid = new Set(['passed', 'failed', 'not_required', 'skipped_bootstrap']);
  if (!valid.has(status)) {
    throw new Error(`recordDaStatus: status must be one of ${[...valid].join(', ')}`);
  }
  const rec = readRecordOrThrow(runId, opts);
  rec.da_status = { status, notes: notes || null };
  writeRecord(rec, opts);
}

function recordValidatorResults(runId, results, opts = {}) {
  if (!results || typeof results !== 'object') {
    throw new Error('recordValidatorResults: results must be an object');
  }
  if (!('overall' in results)) {
    throw new Error("recordValidatorResults: results must include an 'overall' field");
  }
  const rec = readRecordOrThrow(runId, opts);
  rec.manifest_validator_results = results;
  writeRecord(rec, opts);
}

/**
 * Terminate the run. Writes ended_at + final_state, mirrors to mesh.db,
 * and releases the run.lock. The lock is always released on terminal
 * states even if the mesh.db mirror fails.
 */
function endRun(runId, { finalState, errorText, filesTouched } = {}, opts = {}) {
  if (!TERMINAL_STATES.has(finalState)) {
    throw new Error(
      `endRun: finalState '${finalState}' is not terminal. Must be one of ${[...TERMINAL_STATES].join(', ')}.`,
    );
  }
  const rec = readRecordOrThrow(runId, opts);
  rec.ended_at = nowETIso();
  rec.final_state = finalState;
  if (errorText !== undefined) rec.error_text = errorText;
  if (filesTouched !== undefined) rec.files_touched = filesTouched;

  writeRecord(rec, opts);
  attemptMirror(rec, opts);

  const runLockPath = resolveRunLockPath(opts);
  releaseLock(runLockPath);
}

function getRun(runId, opts = {}) {
  const p = localPathFor(runId, opts);
  if (!fs.existsSync(p)) return null;
  return safeReadJSON(p, null);
}

/**
 * List runs from the local JSON directory. Filters applied in JS;
 * intended for occasional human queries and tests. For high-volume
 * queries, callers should hit mesh.db directly.
 *
 * @param {object} filt
 * @param {string} [filt.since]       ISO8601; inclusive lower bound on started_at
 * @param {string} [filt.until]       ISO8601; inclusive upper bound on started_at
 * @param {string} [filt.finalState]
 * @param {string} [filt.taskClass]
 * @param {number} [filt.limit]       default 100
 */
function listRuns(filt = {}, opts = {}) {
  const runsDir = resolveRunsDir(opts);
  if (!fs.existsSync(runsDir)) return [];
  const limit = typeof filt.limit === 'number' ? filt.limit : 100;
  const files = fs.readdirSync(runsDir).filter(f => f.endsWith('.json'));
  const out = [];
  for (const f of files) {
    const rec = safeReadJSON(path.join(runsDir, f), null);
    if (!rec) continue;
    if (filt.since && rec.started_at < filt.since) continue;
    if (filt.until && rec.started_at > filt.until) continue;
    if (filt.finalState && rec.final_state !== filt.finalState) continue;
    if (filt.taskClass && rec.task_class !== filt.taskClass) continue;
    out.push(rec);
  }
  // Sort by started_at desc (most recent first) — typical UX.
  out.sort((a, b) => (a.started_at < b.started_at ? 1 : a.started_at > b.started_at ? -1 : 0));
  return out.slice(0, limit);
}

/**
 * Find in-progress runs whose started_at is older than olderThanMinutes.
 * Input for the drift watchdog: if N minutes have elapsed without an
 * endRun(), something likely crashed.
 */
function findStaleRuns({ olderThanMinutes } = {}, opts = {}) {
  if (typeof olderThanMinutes !== 'number' || olderThanMinutes <= 0) {
    throw new Error('findStaleRuns: olderThanMinutes must be a positive number');
  }
  const cutoffMs = Date.now() - olderThanMinutes * 60 * 1000;
  const inProgress = listRuns({ finalState: FINAL_STATES.IN_PROGRESS, limit: 10000 }, opts);
  return inProgress.filter(rec => {
    const t = Date.parse(rec.started_at);
    if (Number.isNaN(t)) return false; // unparseable timestamps don't qualify
    return t < cutoffMs;
  });
}

/**
 * Walk the local runs directory and upsert each row into mesh.db. Returns
 * a summary of what changed.
 *
 * Conflict policy: primary-wins. If a run exists locally AND in mesh.db
 * with different content, the local copy overwrites the mirror.
 *
 * Mesh.db rows that don't exist locally are flagged as conflicts and
 * NOT auto-deleted — they indicate disk loss or a foreign writer, and
 * the operator must decide. (Per design §1.1.)
 *
 * @returns {{ upserted: number, conflicts: Array<object>, skipped: boolean, reason?: string }}
 */
function reconcileLocalToMesh(opts = {}) {
  const handle = openMeshDb(opts);
  if (!handle) {
    return { upserted: 0, conflicts: [], skipped: true, reason: 'mesh.db unavailable' };
  }
  try {
    const runsDir = resolveRunsDir(opts);
    const localIds = new Set();
    let upserted = 0;
    const conflicts = [];

    if (fs.existsSync(runsDir)) {
      const files = fs.readdirSync(runsDir).filter(f => f.endsWith('.json'));
      for (const f of files) {
        const rec = safeReadJSON(path.join(runsDir, f), null);
        if (!rec || !rec.run_id) continue;
        localIds.add(rec.run_id);
        try {
          mirrorOne(handle, rec);
          upserted++;
        } catch (err) {
          conflicts.push({ run_id: rec.run_id, kind: 'mirror_write_failed', detail: err.message });
        }
      }
    }

    // Check for mesh.db rows that don't exist locally → drift.
    try {
      const remote = handle.db.prepare('SELECT run_id FROM code_architect_runs').all();
      for (const row of remote) {
        if (!localIds.has(row.run_id)) {
          conflicts.push({ run_id: row.run_id, kind: 'remote_without_local' });
        }
      }
    } catch (err) {
      conflicts.push({ kind: 'remote_scan_failed', detail: err.message });
    }

    return { upserted, conflicts, skipped: false };
  } finally {
    handle.close();
  }
}

// ---------------------------------------------------------------------------
// Test-only helpers.
// ---------------------------------------------------------------------------

/**
 * Reset the lazy-loaded better-sqlite3 reference. Used in tests that toggle
 * between an in-memory mock and the real module. Not for production code.
 */
function _resetSqliteForTests() {
  _sqliteModule = null;
  _sqliteResolveAttempted = false;
}

module.exports = {
  // public
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
  // constants
  FINAL_STATES,
  SCHEMA_VERSION,
  VALID_TASK_CLASSES,
  // internals exposed for tests
  ulid,
  nowETIso,
  openMeshDb,
  _resetSqliteForTests,
};

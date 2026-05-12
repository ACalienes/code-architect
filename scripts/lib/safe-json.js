/**
 * safe-json.js — Atomic JSON I/O, file locks, and ET-zone date helpers.
 *
 * Ported from Kai (`Kai Executive Assistant/scripts/lib/safe-json.js`) with
 * Kai-specific helpers trimmed (task ID generation, fuzzy match, project
 * filters). CA-specific helpers may be added below the universal surface.
 *
 * Drift policy: CA does NOT require() Kai's version at runtime. When the
 * universal surface (read/write/lock/date) diverges between repos, treat as
 * an explicit fork — promote to a shared mesh library only if it justifies
 * the cross-repo coordination cost.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Module-level map of active locks: lockPath → ownerToken string.
// Lets releaseLock verify ownership before unlinking so a late release
// doesn't delete a newer owner's lock after stale reclamation.
const _activeLocks = new Map();

/**
 * Safely read and parse a JSON file. Never throws.
 *
 * On any failure (missing file, corrupt JSON, permission error):
 *   1. If the file exists but can't parse, copy to .bak for investigation
 *   2. Log structured error to stderr
 *   3. Return defaultValue
 *
 * @param {string} filePath  Absolute path to JSON file
 * @param {*}      defaultValue  Value returned on failure (default: [])
 * @returns {*} parsed JSON or defaultValue
 */
function safeReadJSON(filePath, defaultValue = []) {
  try {
    if (!fs.existsSync(filePath)) return defaultValue;
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) return defaultValue;
    return JSON.parse(raw);
  } catch (err) {
    console.error(`[safe-json] READ FAILED: ${filePath} — ${err.message}`);
    try {
      if (fs.existsSync(filePath)) {
        const bakPath = filePath + '.bak';
        fs.copyFileSync(filePath, bakPath);
        console.error(`[safe-json] Backed up corrupt file to ${bakPath}`);
      }
    } catch (bakErr) {
      console.error(`[safe-json] Could not create backup: ${bakErr.message}`);
    }
    return defaultValue;
  }
}

/**
 * Safely write JSON with atomic rename, rolling backup, and shrink guard.
 *
 * Steps:
 *   1. Acquire write lock (3 attempts, exponential backoff)
 *   2. If file exists and >10KB, refuse a write that shrinks it by >90% unless opts.force
 *   3. Copy existing → .bak (rolling backup)
 *   4. Serialize, validate, write to .tmp, atomic rename .tmp → file
 *
 * Never throws — returns true/false.
 */
function safeWriteJSON(filePath, data, opts = {}) {
  const lockPath = filePath + '.write-lock';
  let locked = false;
  try {
    for (let attempt = 0; attempt < 3 && !locked; attempt++) {
      locked = acquireLock(lockPath, 5000);
      if (!locked && attempt < 2) {
        const waitMs = 100 * (attempt + 1);
        const start = Date.now();
        while (Date.now() - start < waitMs) { /* spin wait — sync context */ }
      }
    }
    if (!locked) {
      console.error(`[safe-json] CRITICAL: Could not acquire write lock for ${filePath} after 3 attempts — ABORTING write to prevent corruption`);
      return false;
    }

    const json = JSON.stringify(data, null, 2);
    JSON.parse(json); // validate roundtrip before disk write

    // Shrink guard — catches the read-[]→write-[] corruption pattern.
    if (!opts.force && fs.existsSync(filePath)) {
      const currentSize = fs.statSync(filePath).size;
      if (currentSize > 10000 && json.length < currentSize * 0.1) {
        console.error(`[safe-json] CRITICAL: Refusing to overwrite ${filePath} (${currentSize} bytes) with ${json.length} bytes (>90% shrinkage) — possible corruption. Data NOT written.`);
        return false;
      }
    }

    if (fs.existsSync(filePath)) {
      try {
        fs.copyFileSync(filePath, filePath + '.bak');
      } catch (bakErr) {
        console.error(`[safe-json] Backup failed for ${filePath}: ${bakErr.message}`);
      }
    }

    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const tmpPath = filePath + '.tmp';
    fs.writeFileSync(tmpPath, json);
    fs.renameSync(tmpPath, filePath);
    return true;
  } catch (err) {
    console.error(`[safe-json] WRITE FAILED: ${filePath} — ${err.message}`);
    try { fs.unlinkSync(filePath + '.tmp'); } catch {}
    return false;
  } finally {
    if (locked) releaseLock(lockPath);
  }
}

/**
 * Acquire an exclusive file lock using the link(2) atomic pattern.
 *
 * Protocol:
 *   1. Write owner token ({pid, time, nonce}) to a unique tmp file
 *   2. link(tmp, lockPath) — atomic; fails EEXIST if lock is held
 *   3. On EEXIST, check staleness via filesystem mtime; if stale, reclaim once
 *   4. Verify lockPath contents match our token after link (defense in depth)
 *
 * Boolean return; the owner token is stashed in _activeLocks so releaseLock
 * can verify ownership and avoid the "late release deletes newer owner's lock"
 * bug.
 */
function acquireLock(lockPath, staleMs = 5 * 60 * 1000) {
  return _acquireLockWithRetry(lockPath, staleMs, true);
}

function _acquireLockWithRetry(lockPath, staleMs, allowStaleReclaim) {
  const nonce = crypto.randomBytes(12).toString('hex');
  const token = JSON.stringify({ pid: process.pid, time: Date.now(), nonce });
  const tmpPath = `${lockPath}.tmp.${process.pid}.${nonce}`;

  try {
    const dir = path.dirname(lockPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch (_) {}

  try {
    fs.writeFileSync(tmpPath, token);
  } catch (err) {
    console.error(`[safe-json] LOCK tmp write FAILED: ${lockPath} — ${err.message}`);
    return false;
  }

  try {
    fs.linkSync(tmpPath, lockPath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch (_) {}

    if (err.code !== 'EEXIST') {
      console.error(`[safe-json] LOCK FAILED: ${lockPath} — ${err.message}`);
      return false;
    }

    if (allowStaleReclaim) {
      try {
        const st = fs.statSync(lockPath);
        const ageMs = Date.now() - st.mtimeMs;
        if (ageMs > staleMs) {
          try { fs.unlinkSync(lockPath); } catch (_) {}
          return _acquireLockWithRetry(lockPath, staleMs, false);
        }
      } catch (_) {
        return _acquireLockWithRetry(lockPath, staleMs, false);
      }
    }
    return false;
  }

  try { fs.unlinkSync(tmpPath); } catch (_) {}

  try {
    const contents = fs.readFileSync(lockPath, 'utf8');
    if (contents !== token) return false;
  } catch (_) {
    return false;
  }

  _activeLocks.set(lockPath, token);
  return true;
}

/**
 * Release a file lock. Ownership-checked — only unlinks if the lock file
 * still contains our exact owner token from the original acquireLock call.
 */
function releaseLock(lockPath) {
  const ownerToken = _activeLocks.get(lockPath);
  if (!ownerToken) return;
  _activeLocks.delete(lockPath);

  try {
    const contents = fs.readFileSync(lockPath, 'utf8');
    if (contents === ownerToken) {
      try { fs.unlinkSync(lockPath); } catch (_) {}
    }
  } catch (_) {}
}

/**
 * Today's date as YYYY-MM-DD in Eastern Time.
 *
 * Do NOT use `new Date().toISOString().split('T')[0]` — that returns UTC date,
 * which is wrong after 7 PM ET (becomes the next day in UTC).
 */
function todayET() {
  return etDateFromDate(new Date());
}

/**
 * The ET-zone calendar date (YYYY-MM-DD) for a given Date instance.
 */
function etDateFromDate(date) {
  return date.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

/**
 * Safely append a line to a file with optional locking.
 */
function safeAppend(filePath, text, lockPath) {
  let locked = false;
  try {
    if (lockPath) locked = acquireLock(lockPath, 10000);
    const needsNewline = text && !text.endsWith('\n');
    fs.appendFileSync(filePath, needsNewline ? text + '\n' : text);
    return true;
  } catch (err) {
    console.error(`[safe-json] APPEND FAILED: ${filePath} — ${err.message}`);
    return false;
  } finally {
    if (locked && lockPath) releaseLock(lockPath);
  }
}

module.exports = {
  safeReadJSON,
  safeWriteJSON,
  acquireLock,
  releaseLock,
  todayET,
  etDateFromDate,
  safeAppend,
};

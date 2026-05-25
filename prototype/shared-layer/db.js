'use strict';
/**
 * Driver-agnostic SQLite open — the better-sqlite3 port (roadmap deploy step).
 * The prototype runs on node:sqlite (built-in, zero-install) for demonstrability; the Mini/mesh
 * stack is better-sqlite3. Their surface is identical for what this layer uses — `db.exec(sql)`,
 * `db.prepare(sql).run(...)/.get(...)/.all(...)`, positional `?` params — so the SAME module code
 * runs on both behind this one open shim.
 *
 *   default            → node:sqlite (tests, laptop)
 *   SL_DB_DRIVER=better-sqlite3  (or openDatabase(path,{driver:'better-sqlite3'}))  → the Mini
 *
 * Binding note for the port: better-sqlite3 is strict — it rejects `undefined` and JS booleans as
 * bound values. The modules already normalize with `?? null` and store flags as text/ints, so the
 * surface stays compatible; keep that discipline in any new query.
 */
function openDatabase(path = ':memory:', { driver } = {}) {
  driver = driver || process.env.SL_DB_DRIVER || 'node';
  if (driver === 'better-sqlite3' || driver === 'better') {
    const Database = require('better-sqlite3');
    return new Database(path);
  }
  const { DatabaseSync } = require('node:sqlite');
  return new DatabaseSync(path);
}

// Re-entrant transaction wrapper (Codex: multi-step durable writes must be atomic). Runs fn inside a
// single BEGIN/COMMIT; rolls back on throw. If the db is already mid-transaction (a nested call like
// promoteClaim → writeFactValidated → writeFact), it runs inline under the OUTER transaction — so the
// whole compound write commits or rolls back as one. Works on both node:sqlite and better-sqlite3.
const _inTx = new WeakSet();
function withTx(db, fn) {
  if (_inTx.has(db)) return fn();
  _inTx.add(db);
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { try { db.exec('ROLLBACK'); } catch (_) { /* already rolled back */ } throw e; }
  finally { _inTx.delete(db); }
}

module.exports = { openDatabase, withTx };

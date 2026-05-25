'use strict';
/**
 * Physical per-client projections — Shared Layer hardening roadmap increment #3.
 * Code Architect · 2026-05-25.
 *
 * Defense-in-depth BENEATH the logical delivery-split (B1). Logical isolation holds only as
 * long as a client repo uses the sanctioned drain()/peek() path and never opens the central
 * kameha-mesh.db directly. This increment removes that trust assumption: a trusted projector
 * materializes each client repo's deliveries into ITS OWN file — `<dir>/<agent>/inbox.db` —
 * OS-permissioned so the client process can only ever read its own bytes. Another client's
 * data is not in any file this client is allowed to open, so even raw SQL / a compromised
 * client repo cannot cross clients.
 *
 * Two independent guards on the same invariant:
 *   1. route() writes per-recipient, per-client-scoped deliveries (logical, already proven).
 *   2. projectClient() REFUSES to copy any delivery whose fact.client_id != the projection's
 *      client — so a hypothetical route() bug can't leak across the physical boundary either.
 *
 * Design choices:
 *   - Per-client SQLite (not JSONL) so the runner (#1) rides it UNCHANGED: a client repo runs
 *     the same createDrainer, just pointed at openProjectionDb(file) instead of the central db.
 *   - journal_mode=DELETE (central stays WAL) → no persistent -wal/-shm sidecars holding
 *     un-checkpointed bytes, so the file IS the whole truth (clean to permission + to prove).
 *
 * What the prototype proves vs. what deployment owes:
 *   - PROVEN here: a client's file contains ONLY its client's bytes (adversarial raw-byte read),
 *     restrictive modes (0600 file / 0700 dir) are applied, the projector refuses cross-client
 *     rows, and the runner rides the projection unchanged.
 *   - OWED at deploy (Mini): chown each `<dir>/<agent>/` to that client's dedicated unix user so
 *     a DIFFERENT uid is denied by the OS. In-process (single uid) we can set mode but not prove
 *     cross-uid denial — that is the deployment integration test, documented, not faked.
 *
 * NOTE: internal agents (acd, nami; scope '*') are cross-client BY DESIGN and are NOT projected
 * per-client — they read the central deliveries path. Physical projection is specifically the
 * client-repo guarantee ("client X's process must never read client Y").
 */

const fs = require('node:fs');
const path = require('node:path');
const { applySchema } = require('./shared-layer');
const { openDatabase } = require('./db');

const now = () => new Date().toISOString();

function audit(db, event, detail) {
  db.prepare('INSERT INTO audit_log (ts, event, detail) VALUES (?, ?, ?)')
    .run(now(), event, detail ? JSON.stringify(detail) : null);
}

/** Open a per-client projection db: identical schema to central, but DELETE journal so the
 *  single .db file holds all bytes (no persistent WAL sidecar). The client's runner uses this. */
function openProjectionDb(file, opts = {}) {
  const db = openDatabase(file, opts);
  db.exec('PRAGMA journal_mode = DELETE;');
  return applySchema(db);
}

const FACT_COLS = ['fact_id', 'fact_type', 'client_id', 'subject_type', 'subject_id', 'visibility',
  'data_class', 'payload', 'source_agent', 'observed_at', 'created_at', 'revoked_at', 'superseded_by'];

// INSERT OR REPLACE keeps a projected fact fresh on re-projection (e.g. a later revoke sets
// revoked_at; the matching correction delivery re-pulls the fact, so revocation propagates).
function upsertFact(pdb, fact) {
  const placeholders = FACT_COLS.map(() => '?').join(', ');
  pdb.prepare(`INSERT OR REPLACE INTO facts (${FACT_COLS.join(', ')}) VALUES (${placeholders})`)
    .run(...FACT_COLS.map(c => fact[c] ?? null));
}

/**
 * Materialize agent's not-yet-projected central deliveries into its own permissioned file.
 * @param centralDb        the central shared-layer db.
 * @param {object} opts
 * @param {string} opts.dir       projections root (e.g. ~/.kameha/projections).
 * @param {string} opts.agent     the client-repo agent (e.g. 'dag-repo').
 * @param {string} opts.clientId  the ONE client this agent is bound to (e.g. 'dagdc').
 * @param {number} [opts.mode]    file mode (default 0o600).
 * @param {number} [opts.dirMode] dir mode (default 0o700).
 * @returns { file, projected, refused:[{delivery_id, fact_client}] }
 */
function projectClient(centralDb, { dir, agent, clientId, mode = 0o600, dirMode = 0o700 }) {
  if (!dir || !agent || !clientId) throw new Error('projectClient requires { dir, agent, clientId }');
  const clientDir = path.join(dir, agent);
  fs.mkdirSync(clientDir, { recursive: true });
  const file = path.join(clientDir, 'inbox.db');
  const pdb = openProjectionDb(file);

  const candidates = centralDb.prepare(
    `SELECT delivery_id, fact_id, recipient_agent, scope, kind, created_at
       FROM deliveries WHERE recipient_agent = ? AND status = 'pending'`
  ).all(agent);

  let projected = 0;
  const refused = [];
  for (const d of candidates) {
    const fact = centralDb.prepare('SELECT * FROM facts WHERE fact_id = ?').get(d.fact_id);
    // ── DEFENSE-IN-DEPTH GUARD: a client projection may ONLY ever hold its own client's data ──
    if (fact.client_id !== clientId) {
      refused.push({ delivery_id: d.delivery_id, fact_client: fact.client_id });
      centralDb.prepare("UPDATE deliveries SET status='projection_refused' WHERE delivery_id=?").run(d.delivery_id);
      audit(centralDb, 'projection_refused_cross_client',
        { agent, clientId, delivery_id: d.delivery_id, fact_client: fact.client_id });
      continue; // never written to the file — the cross-client byte never touches disk here
    }
    upsertFact(pdb, fact);
    pdb.prepare(`INSERT OR IGNORE INTO deliveries
      (delivery_id, fact_id, recipient_agent, scope, kind, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?)`).run(d.delivery_id, d.fact_id, agent, d.scope, d.kind, d.created_at);
    centralDb.prepare("UPDATE deliveries SET status='projected' WHERE delivery_id=?").run(d.delivery_id);
    projected++;
  }
  pdb.close();

  // Restrictive perms on the file(s) + the dir. (chown to the client's unix user is the Mini step.)
  for (const f of fs.readdirSync(clientDir)) {
    if (f.startsWith('inbox.db')) fs.chmodSync(path.join(clientDir, f), mode);
  }
  fs.chmodSync(clientDir, dirMode);

  audit(centralDb, 'projected', { agent, clientId, projected, refused: refused.length });
  return { file, projected, refused };
}

module.exports = { projectClient, openProjectionDb };

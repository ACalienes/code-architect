'use strict';
/**
 * The Shared Layer — one facade over the whole library. This is the surface Kai adopts: instead of
 * wiring 8 modules by hand, `createSharedLayer({ db, registry, projectionsDir })` returns the cohesive
 * operations with the right composition already assembled (the production write door is
 * verify-identity → authZ → schema → core, and drainers come with heartbeat wired for observability).
 *
 * The individual modules remain importable directly (and their tests prove them); this is convenience
 * + a single adoption point, not new behavior.
 */

const core = require('./shared-layer');
const reg = require('./registry');
const id = require('./identity');
const proj = require('./projection');
const bf = require('./backfill');
const { createDrainer } = require('./runner');
const notify = require('./notify');
const hm = require('./health');

function createSharedLayer({ db, registry = reg.defaultRegistry, projectionsDir = null } = {}) {
  if (!db) throw new Error('createSharedLayer requires { db }');
  const needDir = () => { if (!projectionsDir) throw new Error('projectionsDir not configured'); return projectionsDir; };

  return {
    db, registry,

    // ── enrollment (privileged) ──
    generateIdentity: id.generateIdentity,
    registerIdentity: (spec) => id.registerIdentity(db, spec),

    // ── subscriptions (authorized: client-bound identities can't cross the client boundary) ──
    authorizeSubscribe: (agent, factType, scope) => id.authorizeSubscribe(db, agent, factType, scope),

    // ── writes ──
    sign: id.signFact,
    /** The production door: verify signature → authZ → schema → core write+route. */
    write: (fact, signature) => id.writeSignedFact(db, fact, signature, { registry }),
    /** Schema-only write for trusted internal producers / promoted claims (no signature). */
    writeValidated: (fact) => reg.writeFactValidated(db, fact, registry),
    revoke: (factId, reason) => core.revoke(db, factId, reason),

    // ── backfill (history → quarantined claims → human-gated promotion) ──
    ingestClaim: (claim) => bf.ingestClaim(db, claim),
    listClaims: (opts) => bf.listClaims(db, opts),
    promoteClaim: (claimId, reviewer) => bf.promoteClaim(db, claimId, reviewer),
    rejectClaim: (claimId, reviewer, reason) => bf.rejectClaim(db, claimId, reviewer, reason),

    // ── per-client physical projection ──
    project: (agent, clientId, opts = {}) => proj.projectClient(db, { dir: needDir(), agent, clientId, ...opts }),
    openProjection: proj.openProjectionDb,

    // ── drainers (heartbeat auto-wired for observability) ──
    drainer: (agent, handler, opts = {}) => createDrainer({ db, agent, handler, onTick: (s) => hm.recordHeartbeat(db, agent, s), ...opts }),
    /** A client repo's drainer rides its OWN projection file, not the central store. */
    clientDrainer: (agent, file, handler, opts = {}) => createDrainer({ db: proj.openProjectionDb(file), agent, handler, ...opts }),

    // ── event-driven wake ──
    signalWake: (agent) => notify.signalWake(needDir(), agent),
    watchWake: (agent, runner) => notify.watchWake(needDir(), agent, runner),

    // ── observability ──
    health: (opts = {}) => hm.health(db, { registry, ...opts }),
    renderHealthText: hm.renderHealthText,
    renderHealthHtml: hm.renderHealthHtml,
  };
}

module.exports = {
  createSharedLayer,
  // re-exports for direct/low-level use
  openDb: core.openDb, defaultRegistry: reg.defaultRegistry,
  core, registry: reg, identity: id, projection: proj, backfill: bf, notify, healthMod: hm,
};

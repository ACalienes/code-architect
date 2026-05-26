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
const adapter = require('./adapter-mesh');

function createSharedLayer({ db, registry = reg.defaultRegistry, projectionsDir = null, adapterIdentity = null } = {}) {
  if (!db) throw new Error('createSharedLayer requires { db }');
  // The agent-facing surface MUST enforce schema — refuse a null/absent registry that would silently
  // disable validation on write() (Codex round 4). Bypasses live only on the direct trusted primitives.
  if (!registry) throw new Error('createSharedLayer: a registry is required (schema enforcement) — pass defaultRegistry');
  const needDir = () => { if (!projectionsDir) throw new Error('projectionsDir not configured'); return projectionsDir; };

  return {
    db, registry,

    // NOTE: enrollment (generate/register/rotate identity) is NOT here — it's a privileged admin
    // operation on createAdminLayer(), so an agent reaching this facade can't replace another agent's
    // key (Codex critical). This surface is agent-facing: subscribe (authorized), write (signed), etc.

    // ── subscriptions (authorized: client-bound identities can't cross the client boundary) ──
    authorizeSubscribe: (agent, factType, scope) => id.authorizeSubscribe(db, agent, factType, scope),

    // ── writes ──
    sign: id.signFact,
    /** The ONLY write the facade exposes: verify signature → authZ → schema → core write+route.
     *  There is deliberately no unsigned/lenient write on this surface (Codex REVISE: no bypass). */
    write: (fact, signature) => id.writeSignedFact(db, fact, signature, { registry }),
    revoke: (factId, reason) => core.revoke(db, factId, reason),

    // ── legacy bridge (the one live loop) — signed ingress via the enrolled adapter identity ──
    ingestEnvelope: (env, opts = {}) => adapter.ingestEnvelope(db, env, { registry, adapterIdentity, ...opts }),

    // ── backfill (history → quarantined claims → human-gated promotion; promotion is schema-gated) ──
    ingestClaim: (claim) => bf.ingestClaim(db, claim),
    listClaims: (opts) => bf.listClaims(db, opts),
    promoteClaim: (claimId, reviewer) => bf.promoteClaim(db, claimId, reviewer, { registry }),
    rejectClaim: (claimId, reviewer, reason) => bf.rejectClaim(db, claimId, reviewer, reason),

    // ── per-client physical projection ──
    project: (agent, clientId, opts = {}) => proj.projectClient(db, { dir: needDir(), agent, clientId, ...opts }),
    openProjection: proj.openProjectionDb,

    // ── drainers (heartbeat auto-wired for observability) ──
    drainer: (agent, handler, opts = {}) => createDrainer({ db, agent, handler, onTick: (s) => hm.recordHeartbeat(db, agent, s), ...opts }),
    /** A client repo's drainer rides its READ-ONLY projection and acks into its OWN ack-store
     *  (a separate client-owned file, `ackFile`), so the projection dir needn't be client-writable. */
    clientDrainer: (agent, file, handler, opts = {}) => {
      const { ackFile, ...rest } = opts;
      return createDrainer({ db: proj.openProjectionDb(file), agent, handler, ackStore: ackFile ? core.openDb(ackFile) : null, ...rest });
    },

    // ── event-driven wake ──
    signalWake: (agent) => notify.signalWake(needDir(), agent),
    watchWake: (agent, runner) => notify.watchWake(needDir(), agent, runner),

    // ── observability ──
    health: (opts = {}) => hm.health(db, { registry, ...opts }),
    renderHealthText: hm.renderHealthText,
    renderHealthHtml: hm.renderHealthHtml,
  };
}

/**
 * The ADMIN surface — privileged bootstrap/enrollment, SEPARATE from the agent-facing facade. Only the
 * trusted operator/bootstrap process constructs this (it must never be exposed to an agent RPC).
 * Enrollment is insert-only; replacing an existing identity requires an explicit `rotate` ceremony.
 */
function createAdminLayer({ db } = {}) {
  if (!db) throw new Error('createAdminLayer requires { db }');
  return {
    generateIdentity: id.generateIdentity,
    registerIdentity: (spec) => id.registerIdentity(db, spec),                 // insert-only
    rotateIdentity: (spec) => id.registerIdentity(db, { ...spec, rotate: true }), // explicit rotation
    enrollFleet: (roster, opts) => require('./enroll').enrollFleet(db, roster, opts),
  };
}

// The agent-facing facade exposes ONLY hardened operations and NO enrollment. The raw module primitives
// (lenient writeFact/subscribe) are intentionally NOT re-exported — they live in their modules for the
// TRUSTED service + tests. JS cannot truly hide an export, so the real enforcement is the DEPLOYMENT
// process boundary: only the trusted service process holds the db handle + imports the core/admin;
// agents are separate processes that reach the layer only through createSharedLayer's door. (Codex.)
module.exports = {
  createSharedLayer,
  createAdminLayer,
  openDb: core.openDb,            // db construction (not a write path)
  defaultRegistry: reg.defaultRegistry,
};

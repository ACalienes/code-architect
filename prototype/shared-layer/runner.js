'use strict';
/**
 * The drainer runner — Shared Layer production-hardening roadmap increment #1.
 * Code Architect · 2026-05-25.
 *
 * The always-on loop EVERY agent rides. On a jittered ~60s cadence it peeks its own
 * pending deliveries, hands each to a handler, and acks ONLY on success — so a crash
 * or thrown handler mid-fact redelivers next tick instead of dropping the fact
 * (at-least-once). Poison deliveries (handler fails maxAttempts times) are parked in
 * dead_letter so one bad fact can't wedge an agent's queue forever.
 *
 * Why injected time: `clock` and `scheduler` are parameters so the loop is fully
 * deterministic under test (no real waiting, no flaky timers). Production gets the
 * real Date/setTimeout defaults. This is the piece Kai deploys per-agent on the Mini;
 * it wraps shared-layer's peek()/ack() and adds nothing the core can't already prove.
 *
 * Isolation note: the runner only ever calls peek(db, agent, ...) for its own agent,
 * so the B1 structural-isolation guarantee is inherited verbatim — the runner cannot
 * widen an agent's view, it only schedules the reads the agent could already make.
 */

const { peek, ack, deadLetterDelivery, pendingStats } = require('./shared-layer');

// Production scheduler: thin wrapper over the real timer so tests can swap it out.
const realScheduler = {
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => clearTimeout(h),
};

/**
 * @param {object}   o
 * @param {object}   o.db            shared-layer db handle (openDb()).
 * @param {string}   o.agent         the agent this runner drains for.
 * @param {function} o.handler       async (fact) => void. Throw to signal failure (→ retry).
 * @param {number}   [o.intervalMs]  base cadence when idle (default 60_000).
 * @param {number}   [o.jitterRatio] ± fraction of intervalMs to randomize (default 0.1 → ±10%).
 * @param {number}   [o.batchSize]   max deliveries handled per tick (default 100).
 * @param {number}   [o.maxAttempts] handler failures before a delivery is dead-lettered (default 5).
 * @param {function} [o.clock]       () => epoch ms (default Date.now).
 * @param {object}   [o.scheduler]   { setTimer(fn,ms)->h, clearTimer(h) } (default real timers).
 * @param {function} [o.rng]         () => [0,1) for jitter (default Math.random).
 * @param {function} [o.onError]     (err, fact|null, attempt) => void — observability hook.
 */
function createDrainer(o) {
  const {
    db, agent, handler,
    intervalMs = 60000,
    jitterRatio = 0.1,
    batchSize = 100,
    maxAttempts = 5,
    clock = () => Date.now(),
    scheduler = realScheduler,
    rng = Math.random,
    onError = null,
    onTick = null,
    ackStore = null, // a SEPARATE client-owned db for ack-state — used when `db` is a READ-ONLY
                     // projection the client must not (and cannot) write (Codex round 4 critical).
  } = o || {};

  if (!db || !agent || typeof handler !== 'function') {
    throw new Error('createDrainer requires { db, agent, handler }');
  }

  // When riding a read-only projection, ack-state lives in the client's OWN store, never the
  // projection — so the projection directory needn't be client-writable (no symlink/replace attack).
  if (ackStore) ackStore.exec('CREATE TABLE IF NOT EXISTS acked (delivery_id TEXT PRIMARY KEY, ts TEXT); CREATE TABLE IF NOT EXISTS dead_letter (fact_id TEXT, reason TEXT, ts TEXT);');
  const isAcked = (id) => ackStore && ackStore.prepare('SELECT 1 FROM acked WHERE delivery_id = ?').get(id);
  const commitAck = (id) => ackStore
    ? ackStore.prepare('INSERT OR IGNORE INTO acked (delivery_id, ts) VALUES (?, ?)').run(id, new Date().toISOString())
    : ack(db, id);
  const parkPoison = (fact, n, err) => {
    if (ackStore) {
      ackStore.prepare('INSERT OR IGNORE INTO acked (delivery_id, ts) VALUES (?, ?)').run(fact.delivery_id, new Date().toISOString());
      ackStore.prepare('INSERT INTO dead_letter (fact_id, reason, ts) VALUES (?, ?, ?)').run(fact.fact_id, `handler_failed_${n}x: ${err && err.message}`, new Date().toISOString());
    } else deadLetterDelivery(db, fact.delivery_id, `handler_failed_${n}x: ${err && err.message}`);
  };

  const attempts = new Map(); // delivery_id -> consecutive failure count (in-memory; resets on restart)
  const stats = {
    agent, running: false, ticks: 0, wakes: 0,
    lastTickAt: null, lastDrainCount: 0,
    totalHandled: 0, totalFailed: 0, totalDeadLettered: 0,
  };
  let timer = null;
  let inTick = false;       // true only while a drain pass is awaiting its handler
  let wakePending = false;  // a wake() arrived mid-tick → drain again immediately when it finishes

  // A point-in-time view of this runner: durable backlog/lag (re-read from the db) + the
  // process-local counters. getStats() returns it; onTick/heartbeat publish it.
  function snapshot() {
    const p = pendingStats(db, agent);
    // with an ackStore the projection's rows stay 'pending' forever (client never writes them);
    // true pending = delivered − acked-in-the-client-store.
    const ackedN = ackStore ? ackStore.prepare('SELECT COUNT(*) AS n FROM acked').get().n : 0;
    const pending = Math.max(0, p.pending - ackedN);
    const lagMs = p.oldest && pending > 0 ? Math.max(0, clock() - Date.parse(p.oldest)) : 0;
    return { ...stats, pending, lagMs, at: clock() };
  }

  // ±jitterRatio around intervalMs, or 0 when catching up on a backlog.
  function nextDelay(immediate) {
    if (immediate) return 0;
    const j = intervalMs * jitterRatio;
    return intervalMs - j + rng() * 2 * j;
  }

  // One drain pass. Returns { drainedFull } so run() can decide whether to catch up now.
  async function tick() {
    stats.ticks++;
    stats.lastTickAt = clock();
    // A read-only projection's rows never flip to 'read', so peek a wider window and filter out what
    // we've already acked in the client store; otherwise the simple status='pending' read suffices.
    let batch = peek(db, agent, ackStore ? Math.max(batchSize * 10, 1000) : batchSize);
    if (ackStore) batch = batch.filter(f => !isAcked(f.delivery_id)).slice(0, batchSize);
    stats.lastDrainCount = batch.length;
    let handled = 0;

    for (const fact of batch) {
      try {
        await handler(fact);
        commitAck(fact.delivery_id);
        attempts.delete(fact.delivery_id);
        stats.totalHandled++;
        handled++;
      } catch (err) {
        const n = (attempts.get(fact.delivery_id) || 0) + 1;
        attempts.set(fact.delivery_id, n);
        stats.totalFailed++;
        if (n >= maxAttempts) {
          parkPoison(fact, n, err);
          attempts.delete(fact.delivery_id);
          stats.totalDeadLettered++;
        }
        if (onError) { try { onError(err, fact, n); } catch (_) { /* never let the hook break the loop */ } }
      }
    }

    // Backpressure: a full batch that made progress means more is probably waiting —
    // drain again immediately. A full batch that made NO progress (all poison) waits the
    // normal interval, so a poison run can't hot-loop the CPU.
    const drainedFull = batch.length === batchSize && handled > 0;
    // Observability seam: publish a snapshot each tick (e.g. recordHeartbeat) — never lets the
    // hook break the loop, and is liveness only (health re-audits the store for what was delivered).
    if (onTick) { try { onTick(snapshot()); } catch (_) {} }
    return { drainedFull };
  }

  function schedule(immediate) {
    if (!stats.running) return;
    timer = scheduler.setTimer(run, nextDelay(immediate));
  }

  async function run() {
    let drainedFull = false;
    inTick = true;
    try {
      ({ drainedFull } = await tick());
    } catch (err) {
      // peek/pendingStats DB error — surface it, keep the loop alive.
      if (onError) { try { onError(err, null, 0); } catch (_) {} }
    } finally {
      inTick = false;
    }
    // A wake() that arrived mid-tick (e.g. a delivery landed while we were handling) drains now.
    const immediate = drainedFull || wakePending;
    wakePending = false;
    schedule(immediate);
  }

  return {
    start() {
      if (stats.running) return this;
      stats.running = true;
      schedule(true); // first drain promptly, not after a full interval
      return this;
    },
    stop() {
      stats.running = false;
      if (timer) { scheduler.clearTimer(timer); timer = null; }
      return this;
    },
    /**
     * Event-driven kick: drain ASAP instead of waiting out the idle interval. The producer
     * (router/projector) calls this after delivering to this agent — giving near-immediate
     * latency with zero extra empty polls, while the jittered interval stays the safety-net
     * heartbeat. Coalesced: many wakes between ticks collapse to one immediate drain; a wake
     * during an in-flight tick re-drains right after it (so a delivery that lands mid-handle
     * isn't missed). No-op when stopped.
     */
    wake() {
      if (!stats.running) return this;
      stats.wakes++;
      if (inTick) { wakePending = true; return this; } // run() will reschedule immediate
      if (timer) { scheduler.clearTimer(timer); timer = null; }
      schedule(true);
      return this;
    },
    /** Run exactly one drain pass now (tests / manual one-shot / cron-style invocation). */
    async tickOnce() { return tick(); },
    getStats() { return snapshot(); },
  };
}

module.exports = { createDrainer, realScheduler };

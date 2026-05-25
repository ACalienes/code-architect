'use strict';
/**
 * Drainer-runner proof. Deterministic — a fake scheduler + injected clock drive every
 * tick by hand, so there is no real waiting and nothing flakes. Exits non-zero on any
 * failed invariant (same contract as demo.js).
 *
 *   node prototype/shared-layer/runner.test.js
 */
const { openDb, subscribe, writeFact } = require('./shared-layer');
const { createDrainer } = require('./runner');

let failures = 0;
const check = (label, cond) => {
  console.log(`  ${cond ? '✓' : '✗ FAIL'}  ${label}`);
  if (!cond) failures++;
};
const h = (s) => console.log(`\n\x1b[1m${s}\x1b[0m`);

// Single-slot fake scheduler: this runner only ever has one timer outstanding, so a
// FIFO queue + manual fire() is a faithful, fully-deterministic stand-in for setTimeout.
function makeFakeScheduler() {
  let queue = [];
  let nextId = 1;
  return {
    setTimer(fn, ms) { const id = nextId++; queue.push({ id, fn, ms }); return id; },
    clearTimer(id) { queue = queue.filter(t => t.id !== id); },
    get pending() { return queue.length; },
    lastDelay() { return queue.length ? queue[queue.length - 1].ms : null; },
    async fire() { const t = queue.shift(); if (!t) return null; await t.fn(); return t.ms; },
    take() { return queue.shift(); }, // grab the pending timer WITHOUT invoking (drive it by hand)
  };
}

const feedback = (client_id, subject_id) => ({
  fact_type: 'client_feedback', client_id, subject_type: 'campaign', subject_id,
  visibility: 'client', data_class: 'client_confidential', source_agent: 'test',
  payload: { subject_id },
});

(async () => {
  // ── 1. Basic: a tick drains, hands to the handler, and acks (no redelivery) ──
  h('1. A tick drains pending deliveries, hands each to the handler, and acks them');
  {
    const db = openDb();
    subscribe(db, 'acd', 'client_feedback', '*');
    writeFact(db, feedback('dagdc', 'memorial-day'));
    const got = [];
    const d = createDrainer({ db, agent: 'acd', handler: async (f) => { got.push(f.subject_id); } });
    await d.tickOnce();
    check('handler received the fact', got.length === 1 && got[0] === 'memorial-day');
    check('delivery acked → 0 pending after handling', d.getStats().pending === 0);
    await d.tickOnce();
    check('no redelivery on the next tick (acked stays acked)', got.length === 1);
    check('stats: totalHandled === 1, totalFailed === 0', d.getStats().totalHandled === 1 && d.getStats().totalFailed === 0);
  }

  // ── 2. At-least-once: a handler that throws does NOT lose the fact; it redelivers ──
  h('2. At-least-once — a thrown handler leaves the fact pending; it redelivers next tick');
  {
    const db = openDb();
    subscribe(db, 'acd', 'client_feedback', '*');
    writeFact(db, feedback('dagdc', 'retry-me'));
    let attempts = 0;
    const got = [];
    const d = createDrainer({
      db, agent: 'acd',
      handler: async (f) => { attempts++; if (attempts === 1) throw new Error('transient'); got.push(f.subject_id); },
    });
    await d.tickOnce();
    check('first attempt threw → fact still pending (not lost)', d.getStats().pending === 1 && got.length === 0);
    check('failure counted', d.getStats().totalFailed === 1);
    await d.tickOnce();
    check('redelivered and handled on the retry', got.length === 1 && got[0] === 'retry-me');
    check('now acked → 0 pending', d.getStats().pending === 0);
  }

  // ── 3. Poison pill: a forever-failing handler is parked after maxAttempts ──
  h('3. Poison pill — a handler that always fails is dead-lettered after maxAttempts (queue not wedged)');
  {
    const db = openDb();
    subscribe(db, 'acd', 'client_feedback', '*');
    writeFact(db, feedback('dagdc', 'poison'));
    const d = createDrainer({
      db, agent: 'acd', maxAttempts: 3,
      handler: async () => { throw new Error('always fails'); },
    });
    await d.tickOnce(); // 1
    await d.tickOnce(); // 2
    check('still pending before the limit', d.getStats().pending === 1);
    await d.tickOnce(); // 3 → dead-letter
    check('parked after maxAttempts → 0 pending', d.getStats().pending === 0);
    check('counted as dead-lettered', d.getStats().totalDeadLettered === 1);
    const dl = db.prepare('SELECT COUNT(*) AS n FROM dead_letter').get();
    check('recorded in dead_letter (alertable)', dl.n === 1);
    await d.tickOnce(); // 4 → nothing left to fail
    check('no further attempts after parking (poison cannot hot-loop)', d.getStats().lastDrainCount === 0);
  }

  // ── 4. Isolation through the runner: a client repo's runner only ever sees its client ──
  h('4. Isolation — the runner inherits B1; a DAG-scoped runner never sees a TDB fact');
  {
    const db = openDb();
    subscribe(db, 'dag-repo', 'client_feedback', 'dagdc');
    subscribe(db, 'tdb-repo', 'client_feedback', 'tdb');
    writeFact(db, feedback('tdb', 'tdb-secret'));
    const dagGot = [], tdbGot = [];
    const dag = createDrainer({ db, agent: 'dag-repo', handler: async (f) => dagGot.push(f.subject_id) });
    const tdb = createDrainer({ db, agent: 'tdb-repo', handler: async (f) => tdbGot.push(f.subject_id) });
    await dag.tickOnce();
    await tdb.tickOnce();
    check('DAG runner drained NOTHING (structural isolation holds through the runner)', dagGot.length === 0);
    check('TDB runner drained its own fact', tdbGot.length === 1 && tdbGot[0] === 'tdb-secret');
  }

  // ── 5. Backpressure + cadence: catch up on a backlog immediately, idle at interval ──
  h('5. Backpressure — full batches drain back-to-back (delay 0); a partial batch idles at the interval');
  {
    const db = openDb();
    subscribe(db, 'acd', 'client_feedback', '*');
    for (let i = 0; i < 5; i++) writeFact(db, feedback('dagdc', `f${i}`));
    const sched = makeFakeScheduler();
    const got = [];
    const d = createDrainer({
      db, agent: 'acd', handler: async (f) => got.push(f.subject_id),
      batchSize: 2, intervalMs: 1000, jitterRatio: 0.1, rng: () => 0.5, scheduler: sched,
    });
    d.start();
    check('start() schedules the first drain immediately (delay 0)', sched.lastDelay() === 0);
    await sched.fire(); // handles 2 (full, progress) → reschedule immediate
    check('full batch w/ progress reschedules immediately', sched.lastDelay() === 0);
    await sched.fire(); // handles 2 (full, progress) → immediate
    check('still catching up at delay 0', sched.lastDelay() === 0);
    await sched.fire(); // handles last 1 (partial) → idle at interval
    check('partial batch idles at the base interval (rng 0.5 → exactly 1000)', sched.lastDelay() === 1000);
    check('all 5 facts drained across the backlog', got.length === 5);
    d.stop();
    check('stop() clears the outstanding timer', sched.pending === 0);
  }

  // ── 6. Jitter stays within ±jitterRatio of intervalMs ──
  h('6. Jitter — idle reschedule stays within ±jitterRatio of the base interval');
  {
    const db = openDb();
    subscribe(db, 'acd', 'client_feedback', '*'); // no facts → empty drains → jittered idle reschedule
    const mk = (rng) => {
      const sched = makeFakeScheduler();
      createDrainer({ db, agent: 'acd', handler: async () => {}, intervalMs: 1000, jitterRatio: 0.1, rng, scheduler: sched }).start();
      return sched;
    };
    const low = mk(() => 0);            // floor: 1000 - 100 = 900
    await low.fire();
    check('jitter floor === intervalMs - jitter (900)', low.lastDelay() === 900);
    const high = mk(() => 0.999999);    // ceil: ~1000 + 100
    await high.fire();
    check('jitter ceiling < intervalMs + jitter (≤1100)', high.lastDelay() > 1000 && high.lastDelay() <= 1100);
  }

  // ── 7. Lag: getStats reports how stale the oldest pending delivery is ──
  h('7. Observability — getStats() reports backlog lag from the oldest pending delivery');
  {
    const db = openDb();
    subscribe(db, 'acd', 'client_feedback', '*');
    writeFact(db, feedback('dagdc', 'laggy'));
    // Freeze the clock 5s after the delivery was created to assert a deterministic lag.
    const created = db.prepare("SELECT created_at FROM deliveries WHERE recipient_agent = 'acd'").get().created_at;
    const fakeNow = Date.parse(created) + 5000;
    const d = createDrainer({ db, agent: 'acd', handler: async () => {}, clock: () => fakeNow });
    const s = d.getStats();
    check('pending count surfaced', s.pending === 1);
    check('lagMs ≈ 5000 (now - oldest pending created_at)', s.lagMs === 5000);
  }

  // ── 8. wake() — event-driven kick collapses the idle wait to an immediate drain ──
  h('8. wake() — a delivery signal drains ASAP instead of waiting out the idle interval');
  {
    const db = openDb();
    subscribe(db, 'acd', 'client_feedback', '*');
    const sched = makeFakeScheduler();
    const d = createDrainer({ db, agent: 'acd', handler: async () => {}, intervalMs: 1000, jitterRatio: 0.1, rng: () => 0.5, scheduler: sched });
    d.start();
    await sched.fire(); // empty first tick → idle reschedule
    check('idle reschedule sits at the interval (1000)', sched.lastDelay() === 1000);
    d.wake();
    check('wake() collapses it to an immediate drain (delay 0)', sched.lastDelay() === 0);
    check('two more wakes coalesce — still exactly one pending timer', (d.wake(), d.wake(), sched.pending === 1));
    check('wakes counted in stats', d.getStats().wakes === 3);
    d.stop();
  }

  // ── 9. wake() while stopped is a no-op; wake() mid-tick re-drains right after ──
  h('9. wake() — no-op when stopped; honored after an in-flight tick');
  {
    const stopped = createDrainer({ db: openDb(), agent: 'acd', handler: async () => {}, scheduler: makeFakeScheduler() });
    stopped.wake();
    check('wake() before start is a no-op (not counted)', stopped.getStats().wakes === 0);

    const db = openDb();
    subscribe(db, 'acd', 'client_feedback', '*');
    writeFact(db, feedback('dagdc', 'mid-tick'));
    const sched = makeFakeScheduler();
    let release; let calls = 0;
    const handler = async () => { calls++; if (calls === 1) return new Promise((r) => { release = r; }); };
    const d = createDrainer({ db, agent: 'acd', handler, intervalMs: 1000, jitterRatio: 0.1, rng: () => 0.5, scheduler: sched });
    d.start();
    const t = sched.take();   // grab the first (immediate) timer without awaiting
    const p = t.fn();         // run() starts; tick peeks the fact; handler suspends (gate open)
    d.wake();                 // arrives MID-tick → must be remembered, not lost
    check('a mid-tick wake is recorded', d.getStats().wakes === 1);
    release();                // let the handler finish
    await p;                  // run() completes and reschedules
    check('mid-tick wake forces an immediate re-drain (delay 0), not the idle interval', sched.lastDelay() === 0);
    d.stop();
  }

  // ── 10. onTick — the observability seam fires each tick with a snapshot ──
  h('10. onTick — publishes a snapshot every tick (the heartbeat/observability seam)');
  {
    const db = openDb();
    subscribe(db, 'acd', 'client_feedback', '*');
    writeFact(db, feedback('dagdc', 'seam'));
    const seen = [];
    const d = createDrainer({ db, agent: 'acd', handler: async () => {}, onTick: (s) => seen.push(s) });
    await d.tickOnce();
    check('onTick fired once with a snapshot', seen.length === 1 && typeof seen[0].pending === 'number' && 'lagMs' in seen[0]);
    check('a thrown onTick never breaks the loop', await (async () => {
      const d2 = createDrainer({ db: openDb(), agent: 'x', handler: async () => {}, onTick: () => { throw new Error('boom'); } });
      try { await d2.tickOnce(); return true; } catch (_) { return false; }
    })());
  }

  // ── result ──
  h(failures === 0 ? '\x1b[32mALL RUNNER INVARIANTS HOLD ✓\x1b[0m' : `\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`);
  process.exit(failures === 0 ? 0 : 1);
})();

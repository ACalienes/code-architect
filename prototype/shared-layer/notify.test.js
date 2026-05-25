'use strict';
/**
 * Event-driven wake proof — the fs glue end to end. Uses REAL fs.watch + REAL timers, so it's an
 * integration smoke test (polls with a timeout rather than asserting exact timing). Proves the
 * payoff: a drainer on a long idle interval still delivers within milliseconds of a signal — i.e.
 * low latency WITHOUT a tight poll. Cleans up its temp dir. Exits non-zero on failure.
 *
 *   node prototype/shared-layer/notify.test.js
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb, subscribe, writeFact } = require('./shared-layer');
const { createDrainer } = require('./runner');
const { signalWake, watchWake } = require('./notify');

let failures = 0;
const check = (label, cond) => {
  console.log(`  ${cond ? '✓' : '✗ FAIL'}  ${label}`);
  if (!cond) failures++;
};
const h = (s) => console.log(`\n\x1b[1m${s}\x1b[0m`);
const waitFor = async (cond, ms = 3000, step = 10) => {
  const start = Date.now();
  while (Date.now() - start < ms) { if (cond()) return true; await new Promise((r) => setTimeout(r, step)); }
  return cond();
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-notify-'));

(async () => {
  // ── 1. signalWake writes the per-agent wake file ──
  h('1. signalWake — drops a per-agent wake file (creates the dir if needed)');
  {
    signalWake(tmp, 'acd');
    check('.wake file exists at <dir>/<agent>/.wake', fs.existsSync(path.join(tmp, 'acd', '.wake')));
  }

  // ── 2. watchWake turns a signal into runner.wake() ──
  h('2. watchWake — a signal triggers runner.wake() (real fs.watch)');
  {
    let wakes = 0;
    const stub = { wake() { wakes++; return this; } };
    const w = watchWake(tmp, 'beta', stub);
    // re-signal each poll: fs.watch can drop the very first event, and the heartbeat-style retry is
    // exactly how production behaves (a missed wake just falls back) — so the test isn't racy.
    const ok = await waitFor(() => { if (wakes < 1) signalWake(tmp, 'beta'); return wakes >= 1; }, 4000, 50);
    check('runner.wake() fired from a filesystem signal', ok);
    w.stop();
  }

  // ── 3. END TO END: a long-interval drainer still delivers within ms of a signal ──
  h('3. low latency without a tight poll — a 60s-idle drainer drains on signal, not on the clock');
  {
    const db = openDb();
    subscribe(db, 'gamma', 'client_feedback', 'dagdc');
    const got = [];
    // intervalMs huge → it will NOT tick on its own during this test. Only a wake can drain it.
    const d = createDrainer({ db, agent: 'gamma', handler: async (f) => got.push(f.subject_id), intervalMs: 600000 });
    d.start();
    await waitFor(() => d.getStats().ticks >= 1); // the initial prompt tick (drains nothing yet)
    const w = watchWake(tmp, 'gamma', d);

    // A fact arrives; the producer signals gamma. Without the signal we'd wait up to 600s.
    writeFact(db, {
      fact_type: 'client_feedback', client_id: 'dagdc', subject_id: 'urgent-ping',
      visibility: 'client', data_class: 'client_confidential', source_agent: 'router', payload: {},
    });
    const t0 = Date.now();
    const delivered = await waitFor(() => { if (got.length === 0) signalWake(tmp, 'gamma'); return got.length === 1; }, 4000, 50);
    const latency = Date.now() - t0;
    check('fact delivered via the wake signal', delivered && got[0] === 'urgent-ping');
    check(`delivered in well under the idle interval (${latency}ms ≪ 600000ms)`, delivered && latency < 2000);
    w.stop();
    d.stop();
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  h(failures === 0 ? '\x1b[32mALL NOTIFY INVARIANTS HOLD ✓\x1b[0m' : `\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`);
  process.exit(failures === 0 ? 0 : 1);
})();

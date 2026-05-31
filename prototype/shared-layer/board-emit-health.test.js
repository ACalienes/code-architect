'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { evaluateHealth, reconcileActive } = require('./board-emit-health');

const TH = { backlog: 50, flapping: 5 };
const PAUSED = new Set(['kai-bot', 'kai-dashboard']);
const ev = (o) => evaluateHealth({ thresholds: TH, pausedOk: PAUSED, ...o });
const keys = (r) => r.fire.map(a => a.key).sort();

test('all healthy, no prior state → nothing fires', () => {
  const r = ev({ procs: [{ name: 'board-gateway', status: 'online', restarts: 0 }], backlogs: [], prev: {} });
  assert.deepEqual(r.fire, []);
  assert.deepEqual(r.state.active, {});
});

test('a process that is not online (and not paused) → one critical process_down', () => {
  const r = ev({ procs: [{ name: 'board-emit-cfo', status: 'errored', restarts: 9 }], backlogs: [], prev: {} });
  assert.deepEqual(keys(r), ['board-emit-cfo:process_down']);
  assert.equal(r.fire[0].severity, 'critical');
  assert.equal(r.fire[0].source, 'pm2');
});

test('a deliberately PAUSED process being stopped does NOT alert', () => {
  const r = ev({ procs: [{ name: 'kai-bot', status: 'stopped', restarts: 9 }], backlogs: [], prev: {} });
  assert.deepEqual(r.fire, []);
  assert.deepEqual(r.state.active, {});
});

test('transition-only: a standing alert does NOT re-fire next cycle', () => {
  const procs = [{ name: 'board-emit-cfo', status: 'errored', restarts: 9 }];
  const r1 = ev({ procs, backlogs: [], prev: {} });
  assert.deepEqual(keys(r1), ['board-emit-cfo:process_down']);
  const r2 = ev({ procs, backlogs: [], prev: r1.state });   // same condition, carry prev
  assert.deepEqual(r2.fire, [], 'no re-fire while the condition persists');
  assert.ok(r2.state.active['board-emit-cfo:process_down'], 'still tracked active');
});

test('recovery: a previously-active condition that clears → one info recovered (key carries the cleared condition)', () => {
  const down = ev({ procs: [{ name: 'board-emit-cfo', status: 'errored', restarts: 9 }], backlogs: [], prev: {} });
  const up = ev({ procs: [{ name: 'board-emit-cfo', status: 'online', restarts: 9 }], backlogs: [], prev: down.state });
  assert.deepEqual(keys(up), ['board-emit-cfo:process_down:recovered']);
  assert.equal(up.fire[0].severity, 'info');
  assert.equal(up.fire[0].condition, 'recovered');
  assert.deepEqual(up.state.active, {}, 'no longer active after recovery');
});

test('two conditions for the SAME subject clearing in one tick → distinct recovery keys (no idempotency collision)', () => {
  // subject down AND flapping simultaneously, then both clear.
  const prev = { restarts: { 'board-emit-cfo': 0 }, active: { 'board-emit-cfo:process_down': true, 'board-emit-cfo:flapping': true } };
  const up = ev({ procs: [{ name: 'board-emit-cfo', status: 'online', restarts: 0 }], backlogs: [], prev });
  assert.deepEqual(keys(up), ['board-emit-cfo:flapping:recovered', 'board-emit-cfo:process_down:recovered']);
  assert.equal(new Set(up.fire.map(a => a.key)).size, 2, 'distinct keys → distinct idempotency');
});

test('reconcileActive: a newly-fired condition whose emit FAILED is dropped from active (re-fires next cycle)', () => {
  const r = ev({ procs: [{ name: 'board-emit-cfo', status: 'errored', restarts: 0 }], backlogs: [], prev: {} });
  assert.ok(r.state.active['board-emit-cfo:process_down']);
  const reconciled = reconcileActive(r.state, [{ key: 'board-emit-cfo:process_down', ok: false }]);
  assert.equal(reconciled.active['board-emit-cfo:process_down'], undefined, 'failed emit → not suppressed; will re-fire');
});

test('reconcileActive: a successful emit stays active (does not re-fire)', () => {
  const r = ev({ procs: [{ name: 'board-emit-cfo', status: 'errored', restarts: 0 }], backlogs: [], prev: {} });
  const reconciled = reconcileActive(r.state, [{ key: 'board-emit-cfo:process_down', ok: true }]);
  assert.ok(reconciled.active['board-emit-cfo:process_down'], 'success stays active');
});

test('reconcileActive: a FAILED flapping emit rolls the restart baseline back so it re-fires (Codex r3)', () => {
  const prev = { restarts: { 'board-emit-mesh': 2 }, active: {} };
  // delta 9-2=7 ≥ 5 → flapping fires; evaluateHealth advances state.restarts to 9.
  const r = ev({ procs: [{ name: 'board-emit-mesh', status: 'online', restarts: 9 }], backlogs: [], prev });
  assert.deepEqual(r.fire.map(a => a.key), ['board-emit-mesh:flapping']);
  assert.equal(r.state.restarts['board-emit-mesh'], 9, 'baseline advanced before reconcile');
  // emit FAILS → baseline must roll back to prev (2), so next cycle delta is still >= threshold.
  const reconciled = reconcileActive(r.state, [{ key: 'board-emit-mesh:flapping', ok: false }], prev);
  assert.equal(reconciled.restarts['board-emit-mesh'], 2, 'baseline rolled back → delta re-fires next cycle');
  // prove it re-fires next cycle from the rolled-back baseline:
  const next = ev({ procs: [{ name: 'board-emit-mesh', status: 'online', restarts: 9 }], backlogs: [], prev: reconciled });
  assert.deepEqual(next.fire.map(a => a.key), ['board-emit-mesh:flapping'], 're-fired after failed emit');
});

test('reconcileActive: a SUCCESSFUL flapping emit advances the baseline (does not re-fire)', () => {
  const prev = { restarts: { 'board-emit-mesh': 2 }, active: {} };
  const r = ev({ procs: [{ name: 'board-emit-mesh', status: 'online', restarts: 9 }], backlogs: [], prev });
  const reconciled = reconcileActive(r.state, [{ key: 'board-emit-mesh:flapping', ok: true }], prev);
  assert.equal(reconciled.restarts['board-emit-mesh'], 9, 'baseline stays advanced on success');
  // Next cycle (restarts steady at 9 → delta 0): the flapping WARN must not re-fire. The condition having
  // cleared correctly yields a recovery info — that's expected, just not a duplicate flapping warn.
  const next = ev({ procs: [{ name: 'board-emit-mesh', status: 'online', restarts: 9 }], backlogs: [], prev: reconciled });
  assert.ok(!next.fire.some(a => a.key === 'board-emit-mesh:flapping'), 'flapping warn does not re-fire on a successful emit');
  assert.deepEqual(next.fire.map(a => a.key), ['board-emit-mesh:flapping:recovered'], 'cleared flapping recovers once');
});

test('flapping: restart count jumping >= threshold in one cycle → warn', () => {
  const prev = { restarts: { 'board-emit-mesh': 2 }, active: {} };
  const r = ev({ procs: [{ name: 'board-emit-mesh', status: 'online', restarts: 9 }], backlogs: [], prev });   // delta 7 >= 5
  assert.deepEqual(keys(r), ['board-emit-mesh:flapping']);
  assert.equal(r.fire[0].severity, 'warn');
  assert.equal(r.fire[0].value, '7');
});

test('flapping does NOT fire below threshold', () => {
  const prev = { restarts: { 'board-emit-mesh': 2 }, active: {} };
  const r = ev({ procs: [{ name: 'board-emit-mesh', status: 'online', restarts: 5 }], backlogs: [], prev });   // delta 3 < 5
  assert.deepEqual(r.fire, []);
});

test('backlog over threshold → warn; at/under → nothing', () => {
  const over = ev({ procs: [], backlogs: [{ agent: 'kai', pending: 128 }], prev: {} });
  assert.deepEqual(keys(over), ['kai:backlog']);
  assert.equal(over.fire[0].value, '128');
  const under = ev({ procs: [], backlogs: [{ agent: 'kai', pending: 50 }], prev: {} });   // not > 50
  assert.deepEqual(under.fire, []);
});

test('state carries restart counts forward for the next flapping delta', () => {
  const r = ev({ procs: [{ name: 'board-gateway', status: 'online', restarts: 4 }], backlogs: [], prev: {} });
  assert.equal(r.state.restarts['board-gateway'], 4);
});

test('multiple simultaneous conditions all fire once', () => {
  const r = ev({ procs: [
    { name: 'board-emit-cfo', status: 'errored', restarts: 0 },
    { name: 'board-gateway', status: 'online', restarts: 0 },
  ], backlogs: [{ agent: 'kai', pending: 200 }], prev: {} });
  assert.deepEqual(keys(r), ['board-emit-cfo:process_down', 'kai:backlog']);
});

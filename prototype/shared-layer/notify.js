'use strict';
/**
 * Event-driven wake — the "priority cadence" piece of the drainer runner (roadmap #1's deferred
 * half). Code Architect · 2026-05-25.
 *
 * WHY: a shorter poll interval optimizes the EMPTY case (most ticks find nothing) while taxing a
 * single-node SQLite store with empty reads, WAL contention, and projection write-amplification.
 * The right way to get low latency is to wake the relevant drainer ON delivery instead of making
 * everyone poll faster. This gives near-immediate latency with zero extra empty polls; the jittered
 * ~60s interval stays as the safety-net heartbeat (and the fallback if a wake is ever missed).
 *
 * Transport: a per-agent wake file `<dir>/<agent>/.wake`. The producer (router/projector) calls
 * signalWake() after delivering to an agent; that agent's runner watches the file (watchWake) and
 * calls runner.wake() on change. A file touch is dependency-free, works across separate processes
 * on one host (the Mini), and degrades safely — if fs.watch misses an event, the heartbeat still
 * drains within one interval. (On the Mini this rides the same filesystem the projections live on.)
 */

const fs = require('node:fs');
const path = require('node:path');

/** Producer side: poke an agent so its runner drains ASAP. Idempotent; creates the dir if needed. */
function signalWake(dir, agent) {
  const agentDir = path.join(dir, agent);
  fs.mkdirSync(agentDir, { recursive: true });
  // Writing a fresh timestamp guarantees an mtime change → a watch event even on rapid repeats.
  fs.writeFileSync(path.join(agentDir, '.wake'), String(Date.now()));
}

/**
 * Consumer side: watch an agent's wake file and call runner.wake() on each signal. Watches the
 * DIRECTORY (the file may not exist yet, and replaced files break a file-level watch) and filters
 * for '.wake'. Returns { stop } to close the watcher. runner.wake() is itself coalesced, so
 * duplicate fs events are harmless.
 *
 * @returns {{stop: () => void}}
 */
function watchWake(dir, agent, runner) {
  const agentDir = path.join(dir, agent);
  fs.mkdirSync(agentDir, { recursive: true });
  const watcher = fs.watch(agentDir, (_event, filename) => {
    if (!filename || filename === '.wake') runner.wake();
  });
  return { stop() { try { watcher.close(); } catch (_) {} } };
}

module.exports = { signalWake, watchWake };

# Codex review prompt — Shared Layer drainer runner (hardening increment #1)

Paste into the Codex VS Code plugin with these files open:
`prototype/shared-layer/runner.js`, `prototype/shared-layer/runner.test.js`,
`prototype/shared-layer/shared-layer.js`, `prototype/shared-layer/README.md`.
This is a **code review** of the first production-hardening increment built on the
already-blessed, Codex-reviewed v2 design (`docs/design-kameha-shared-layer-2026-05-25.md`).

---

You are reviewing the **drainer runner** for a cross-agent fact-sharing system. ~16 autonomous
agents each run one of these as an always-on loop that reads facts addressed to it from a shared
SQLite store and hands them to a handler. The core store + its isolation/routing invariants were
already reviewed and proven (see `demo.js`). This increment adds: an at-least-once read path
(`peek`/`ack`/`deadLetterDelivery`/`pendingStats` in `shared-layer.js`) and the runner itself
(`runner.js`), with deterministic tests (`runner.test.js`, injected clock + fake scheduler).

The design is deliberately **at-least-once** (peek → handle → ack-on-success; redeliver on
crash/throw; park as dead_letter after `maxAttempts`; jittered ~60s cadence with backpressure).
The README documents three accepted v1 assumptions: (1) handlers must be idempotent, (2) one
runner per agent (peek doesn't claim rows), (3) attempt counts are in-memory (reset on restart).

Review **objectively and adversarially** — assume it has flaws and find them. Probe specifically:

1. **At-least-once correctness.** Is the peek→handle→ack ordering actually crash-safe, or is there
   a window where a fact is lost (not just double-handled)? Does anything mark a delivery `read`
   *before* the handler succeeds? Trace `ack`/`deadLetterDelivery` status transitions vs. what
   `peek` filters on (`status='pending'`).

2. **Poison-pill / backpressure interaction.** Can a batch that mixes successes and always-failing
   facts hot-loop at delay 0 (because `handled > 0`)? Is `drainedFull = batch.length===batchSize &&
   handled>0` the right backpressure predicate, or can it either starve (never catch up) or spin?

3. **The "one runner per agent" assumption.** How bad is the failure if it's violated (double
   deploy, overlapping cron + start())? Is `tickOnce()` safe to expose given it ignores `running`?
   Is the recommended claim/lease fix (`UPDATE…SET status='claimed'`) sound, or does it introduce a
   stuck-claim failure mode that needs its own reclaim (cf. the project's `run.lock` 5-min reclaim)?

4. **In-memory attempt counter.** Beyond "more retries on restart," can the reset ever cause a
   *correctness* problem (e.g., a fact that should be parked instead keeps redelivering and blocking
   newer facts behind it, given `peek` is ORDER BY created_at)? Does head-of-line blocking matter
   here, and should the runner skip-and-continue past a repeatedly-failing delivery rather than let
   it sit at the front?

5. **Observability sufficiency.** Are `lagMs` / `pending` / the counters enough to alert on a wedged
   or lagging agent? What's missing for a real dashboard (per-fact-type lag? dead_letter age? last
   successful ack time vs. now)?

6. **Test gaps.** What invariant is NOT covered that should be? Specifically: head-of-line blocking,
   concurrent `tickOnce` + `start`, an async handler that rejects vs. throws synchronously, a handler
   that mutates the DB, ordering guarantees across ticks.

Give a verdict (READY / REVISE / REJECT) with specific file:line findings ranked by severity.
Distinguish "must fix before this increment ships" from "fine as a documented roadmap follow-up."

---

## Addendum — event-driven wake (`runner.wake()` + `notify.js`)

Also review the wake mechanism added to close the latency question (why ~60s and not tighter). The
runner gains `wake()`: a coalesced, in-tick-safe kick that collapses the idle wait to an immediate
drain. `notify.js` is the cross-process glue — `signalWake(dir,agent)` touches `<dir>/<agent>/.wake`;
`watchWake(dir,agent,runner)` uses `fs.watch` to call `runner.wake()`. Open `notify.js` /
`notify.test.js`. Probe:

7. **wake() correctness.** Trace `inTick`/`wakePending` in `run()`/`wake()`. Is there any interleaving
   (the gap between `inTick=false` and `schedule()`, multiple overlapping wakes, wake racing `stop()`)
   where a wake is lost or causes a double-tick / two outstanding timers? Is coalescing correct under
   a burst?
8. **fs.watch trust.** `fs.watch` misses events, fires duplicates, and behaves differently per OS. The
   design leans on the ~60s heartbeat as the backstop — is that argument sound, and is the worst-case
   latency really bounded by one interval? Any fd/watcher leak if `stop()` isn't called?
9. **Wake as an abuse vector.** The `.wake` file is a local timestamp carrying no payload. Can a local
   actor use it for anything beyond forcing spurious empty drains (a mild DoS)? Confirm it can't inject
   or influence which facts are delivered.
10. **Wiring.** Producers (router/projector) must call `signalWake` after delivering. Is leaving that
    to the integrator right, or should `projectClient`/`writeFact` call it directly? Any ordering hazard
    (signal before the delivery row is committed → wake finds nothing, then the heartbeat catches it)?

# The Shared Layer — reference prototype

**Code Architect · 2026-05-25 · runnable proof of the Codex-hardened v2 design.**

Not the production system — a tested reference Kai can adopt onto the Mini. It proves the
hard parts are sound *before* we build for real.

## Run it

```bash
node prototype/shared-layer/demo.js     # Node 22+ (uses built-in node:sqlite). Exits non-zero on any failed invariant.
```

14 checks across: the DAG→ACD/NAMI flow, adversarial cross-client isolation, write-preflight,
fail-closed dead-letter, and retraction. All pass.

## What it proves (maps 1:1 to the Codex findings)

| Codex finding | Proven here |
|---|---|
| **B1** isolation must be structural, not a filter | Agents read ONLY their router-written `deliveries` via `drain()`; there is no agent-facing "read all facts". A DAG-scoped repo drain returns nothing for a TDB fact — adversarially tested. |
| **B2 / S6** reject bad writes at the door | `writeFact()` preflight refuses unknown `fact_type` and client-confidential facts missing `client_id`, before any durable write. |
| **B3** trusted router writes per-recipient deliveries | `route()` is the only writer of `deliveries`; it matches subscriptions where `client_scope = '*'` (internal) or `= fact.client_id` (the client's own repo). No other match is possible → no cross-client leak. |
| **R1** fail-closed | Unroutable facts go to `dead_letter` (recoverable/alertable), never silently dropped. |
| **G19** retraction | `revoke()` issues correction deliveries to everyone who received the original. |

The key contrast the demo makes explicit: **internal agents (ACD, NAMI) are cross-client by
design (`*`); client repos (DAG, TDB) see only their own client.** That single subscription
rule + the deliveries split *is* the isolation boundary.

## Files

- `shared-layer.js` — schema + library. Core: `openDb`, `subscribe`, `writeFact`, `drain`, `revoke`.
  At-least-once read path (added for the runner): `peek`, `ack`, `deadLetterDelivery`, `pendingStats`.
- `demo.js` — the runnable proof of the core invariants (asserts every one).
- `runner.js` — the **drainer runner** (hardening roadmap #1): the always-on ~60s loop every agent
  rides. `createDrainer({db, agent, handler, ...})` → `.start()/.stop()/.tickOnce()/.getStats()`.
- `runner.test.js` — the runnable proof of the runner (23 checks, deterministic via injected clock + fake scheduler).

```bash
node prototype/shared-layer/demo.js          # core invariants
node prototype/shared-layer/runner.test.js   # drainer-runner invariants
```

## The drainer runner — what it guarantees, and its v1 assumptions

The runner is intentionally **at-least-once**, not exactly-once: it `peek()`s its own pending
deliveries, hands each to the handler, and `ack()`s only on success — so a crash mid-handle
redelivers instead of dropping a fact. A handler that throws leaves the fact pending (retried next
tick); a handler that fails `maxAttempts` times is parked in `dead_letter` so one poison fact can't
wedge the queue. Cadence is jittered ~60s when idle, with backpressure (full batches drain
back-to-back, then idle at interval). All of this is proven in `runner.test.js`.

Three deliberate v1 assumptions (each a named hardening follow-up, surfaced by the CA-internal DA):

1. **Handlers must be idempotent.** At-least-once means a fact can be handled twice (crash between
   handler success and `ack`). This is the "semantic idempotency" item already owed by the design.
2. **One runner per agent.** `peek()` reads without claiming a row, so two runners for the same agent
   would double-handle. v1 assumes single-writer-per-agent (mirrors the `.kameha/run.lock` discipline).
   Production fix: a claim/lease (`UPDATE … SET status='claimed' WHERE status='pending'`).
3. **Attempt counts are in-memory.** A restart resets a poison fact's failure count, so parking is
   bounded *per process run*, not globally. Worst case is more retries — never a silent drop.
   Production fix: persist `attempts` on the delivery row.

## For Kai (adoption notes)

- Built on **`node:sqlite`** (built-in) for zero-install demonstrability. Port to
  **`better-sqlite3`** (the mesh stack) is near-verbatim — same `prepare().run()/.get()/.all()` surface.
- This is the **logical** model. Production hardening still owed (per the design v2 + Codex S/G items):
  per-client **physical** projection files with OS permissions (defense-in-depth beyond the
  delivery split), authN/Z + signed source claims, observability (drainer lag, DLQ age, blocked
  cross-client attempts), `fact_type` JSON-Schema versioning, semantic idempotency, and the
  scheduled-drainer runner. The prototype intentionally proves the core invariants first.

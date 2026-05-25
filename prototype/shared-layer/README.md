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
  rides. `createDrainer({db, agent, handler, ...})` → `.start()/.stop()/.tickOnce()/.wake()/.getStats()`.
- `runner.test.js` — the runnable proof of the runner (30 checks, deterministic via injected clock + fake scheduler).
- `notify.js` — **event-driven wake** (the "priority cadence" half of #1): `signalWake(dir,agent)` (producer
  pokes an agent) + `watchWake(dir,agent,runner)` (consumer turns the poke into `runner.wake()`). Low
  latency without a tighter poll; the ~60s interval stays the safety-net heartbeat.
- `notify.test.js` — the runnable proof (5 checks), incl. an end-to-end: a 600s-idle drainer delivers in ~20ms on signal.
- `backfill.js` — **backfill-as-claims ingest** (hardening roadmap #2): seeds accumulated context as
  scrubbed, quarantined, provenance-stamped **claims** that are NEVER routed until a human-gated
  `promoteClaim()`. `ingestClaim`/`listClaims`/`promoteClaim`/`rejectClaim`/`scrub*`.
- `backfill.test.js` — the runnable proof of backfill (35 checks): claims never route, secrets/PII
  scrubbed at the door, only known fact_types promote, promotion routes the real fact, idempotent
  re-ingest, terminal rejection.

- `projection.js` — **physical per-client projections** (hardening roadmap #3): a trusted
  `projectClient()` materializes each client repo's deliveries into its own OS-permissioned
  `<dir>/<agent>/inbox.db`, so a client process can't even open another client's bytes.
- `projection.test.js` — the runnable proof (19 checks): the decisive one reads a client's RAW
  FILE BYTES and asserts another client's data is physically absent.

```bash
node prototype/shared-layer/demo.js            # core invariants (18)
node prototype/shared-layer/runner.test.js     # drainer-runner invariants (23)
node prototype/shared-layer/backfill.test.js   # backfill-as-claims invariants (35)
node prototype/shared-layer/projection.test.js # physical per-client isolation (19)
node prototype/shared-layer/notify.test.js     # event-driven wake / low latency (5)
```

## Why ~60s, and why not tighter

The interval governs only the **idle heartbeat**, not the loaded path: backpressure already drains a
backlog immediately and only relaxes to ~60s when the inbox is empty. So ~60s is the worst-case
latency for the *first* fact after a quiet spell — and it matches the fleet's existing mesh-poller
cadence (human-timescale facts; sub-minute latency is invisible downstream). Shrinking the number
optimizes the empty case (no payoff) while taxing one Mac Mini: empty-poll waste (~16 agents × 60/min
of nothing at 1s), SQLite/WAL contention, and per-client projection write-amplification. The correct
lever for low latency is `notify.js` — wake the relevant drainer **on delivery** instead of polling
faster: near-immediate (~20ms measured) with zero extra empty polls, heartbeat as the safe fallback.

## Physical per-client projections — defense in depth, and the deploy line

Logical isolation (the delivery split) holds only while a client repo behaves — uses `drain()`/
`peek()` and never opens the central db directly. Physical projection removes that trust: the
trusted projector writes each client's deliveries into **its own file**, and the runner (#1) rides
that file unchanged (per-client SQLite, `journal_mode=DELETE` so no `-wal` sidecar leaks bytes).
The projector is a **second guard** — it refuses to copy any delivery whose `fact.client_id` ≠ the
projection's client, catching a hypothetical `route()` bug at the physical boundary too.

**What's proven vs. what deploy owes (DA-recorded):**
- *Proven in-process:* content isolation (a client's file has zero bytes of any other client —
  tested by reading raw file bytes), restrictive modes applied (0600 file / 0700 dir), the
  cross-client refusal guard, runner drop-in, idempotency, and revocation propagation.
- *Owed at deploy (Mini):* `chmod` only restricts by owner — true cross-client denial needs each
  `<dir>/<agent>/` **`chown`ed to that client's dedicated unix user**, so a *different* uid is
  denied by the OS. In-process (single uid) that can't be exercised; it's the documented
  deployment integration test, not faked here. Also roadmap: ack-back sync (central learns the
  client actually read), and the projector's cadence pairs with the drainer runner's.

## Backfill-as-claims — what it guarantees, and its limits

Backfilled context enters as **claims, not facts**: a claim is scrubbed of secrets/PII at ingest,
stored in a `claims` table that **no agent can read**, and **never creates a delivery**. The only
path to a routed fact is `promoteClaim()` — human-gated, and run through the same proven
`writeFact()` preflight (an unknown `fact_type` or a client-confidential claim with no `client_id`
**cannot** be promoted; it stays quarantined). Re-ingest is idempotent (provenance+content hash).

**DA-recorded limitation (the headline one):** `scrub()` is **best-effort regex**, not exhaustive.
It covers known-shape secrets (provider API keys, PEM/JWT/connection-string/credit-card, `key=value`
secrets) and emails/phones, and records a redaction *summary* (type→count, never the value). Secrets
of unrecognized shape — or free-text PII like names/addresses/SSNs — can survive into the (trusted,
access-controlled) claims store and would ride along on promotion. The mitigations are structural:
claims are quarantined, never routed, and a human reviews each one (with its redaction summary)
before promotion. Hardening follow-ups: entropy-based detection for high-entropy tokens, dedicated
PII handling, and re-scrub-on-promotion so later pattern improvements apply to old claims.

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

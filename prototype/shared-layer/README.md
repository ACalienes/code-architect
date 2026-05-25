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
- `runner.test.js` — the runnable proof of the runner (35 checks, deterministic via injected clock + fake scheduler).
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
- `health.js` — **observability** (hardening roadmap #5): `health(db)` RE-AUDITS the central store
  into a report + synthesized `alerts[]` (isolation=critical, dead-letter by age, lag attributed to
  drainer vs projector, liveness). `recordHeartbeat` (liveness only), `renderHealthText`/`renderHealthHtml`.
- `health.test.js` — the runnable proof (28 checks). `health-dashboard.js` — emits a live dashboard
  HTML from a representative fleet state.
- `registry.js` — **fact_type schema + versioning** (hardening roadmap #6): the action-vocabulary
  registry, concrete. `defaultRegistry` (typed payload contract + version per fact_type), a JSON-Schema
  -subset `validate`, `validatePayload`, and `writeFactValidated()` (validate → stamp version → core writeFact).
- `registry.test.js` — the runnable proof (25 checks): validator subset, vocabulary accept/reject,
  reject-at-the-door, version stamping, schema evolution (v1→v2), registry/core drift guard.
- `identity.js` — **agent identity + signed source claims** (hardening roadmap #4): Ed25519 identities
  (the layer stores only public keys), `signFact`/`verifyFact`, `writeSignedFact()` (verify → authZ →
  schema → core write), `authorizeSubscribe()` (refuses cross-client subscription). `registerIdentity`
  is privileged enrollment.
- `identity.test.js` — the runnable proof (19 checks): unforgeable attribution, tamper/impersonation
  rejection, client-binding on produce + subscribe, composition with the registry, no key leakage.

```bash
node prototype/shared-layer/demo.js            # core invariants
node prototype/shared-layer/runner.test.js     # drainer-runner + wake + onTick
node prototype/shared-layer/backfill.test.js   # backfill-as-claims
node prototype/shared-layer/projection.test.js # physical per-client isolation
node prototype/shared-layer/notify.test.js     # event-driven wake / low latency
node prototype/shared-layer/health.test.js     # observability / alert synthesis
node prototype/shared-layer/registry.test.js   # fact_type schemas + versioning
node prototype/shared-layer/identity.test.js   # agent identity + signed source claims
node prototype/shared-layer/integration.test.js  # full-system capstone (all modules composed)
node prototype/shared-layer/index.test.js        # the createSharedLayer() facade
node prototype/shared-layer/adapter-mesh.test.js # legacy A2A envelope ↔ fact bridge (#7)
node prototype/shared-layer/health-dashboard.js  # → writes a live health dashboard HTML
# 222 checks total across 11 suites, all green.
```

## Adopting it — one entry point

`index.js` exposes `createSharedLayer({ db, registry, projectionsDir })` — the cohesive API Kai
imports instead of wiring 9 modules by hand. It pre-assembles the production write door
(verify-identity → authZ → schema → core), heartbeat-wired drainers, projection, claims, wake, and
health. `integration.test.js` is the capstone: the real DAG→ACD/NAMI flow through every module at once
(the #8 pilot rehearsed in-process), including the adversarial cases the system must catch.

`adapter-mesh.js` (#7) bridges the legacy A2A v1.0 envelope ↔ a fact so the one live ACD↔Kai loop can
ride the layer during the cutover (trusted, unsigned ingress — inherits mesh-api auth; removed at sunset).

Going live is a separate, gated effort — see **`docs/shared-layer-deployment-plan-2026-05-25.md`** (port
to better-sqlite3, enrollment, per-client chown, the adapter, mesh-api sunset, the pre-deploy Codex round).

## Identity & authorization (signed source claims)

The lenient core trusts `source_agent` (a string) and lets anyone subscribe anything — `identity.js`
fixes both. Each agent has an Ed25519 keypair; the layer stores **only public keys** (HB#9 — private
keys never touch it). `writeSignedFact()` is the authenticated door: it **verifies** the signature
against the registered key (forged/tampered/impersonated → rejected, nothing persists), enforces
**authZ** (an identity may only produce its permitted fact_types, and a client-bound identity may only
produce its own client's facts), then writes — composing with the registry as verify → authZ → schema →
core. `authorizeSubscribe()` closes the cross-client subscription hole (a client repo can't subscribe to
another client). Additive + opt-in (core stays lenient → prior checks green; production routes through
these). DA-recorded limits/roadmap: replay protection (nonce + seen-window), stored signatures for
after-the-fact non-repudiation, key-rotation history, and a privileged enrollment trust root at deploy.

## fact_type contracts (the action-vocabulary registry)

The core preflight checks the type *name* is known; `registry.js` extends that to the payload: each
fact_type has a typed contract + version, and `writeFactValidated()` rejects a non-conforming payload
**at the door** (never persisted), stamps `payload._schema_ver`, then hands to the proven `writeFact()`.
It's **additive and opt-in** — the lenient `writeFact()` is untouched (so all prior checks stay green);
production routes writes through `writeFactValidated`. Versioning means a schema can gain a field (v1→v2)
without stranding v1-stamped facts — a reader knows which contract produced each fact. DA-recorded
limits: the validator is a JSON-Schema *subset* (production may swap in ajv behind `validatePayload`);
cross-version payload *migration* and tightening the `_`-prefixed metadata allowlist are roadmap.

## Observability — re-audit, not telemetry-trust

`health(db)` answers the operational questions by reading the store, never by trusting a runner's
self-report: **isolation violations** (`projection_refused_cross_client`) are always CRITICAL;
**dead-letters** warn, or go critical past an age threshold; **backlog/lag is attributed** — an
internal agent's pending blames its own drainer, a client repo's pending blames the *projector*
(the client isn't at fault). Runners may only assert *liveness* (`recordHeartbeat`, wired via the
runner's `onTick`); health folds that in for "is the consumer alive", never for "what got delivered".
Honest gap: a client repo heartbeats into its own projection file, so central client-liveness needs
`opts.projections` (read their files) — supported optionally, documented as the ack-back roadmap item.

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

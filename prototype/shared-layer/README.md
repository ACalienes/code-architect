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

- `shared-layer.js` — schema + library (`openDb`, `subscribe`, `writeFact`, `drain`, `revoke`).
- `demo.js` — the runnable proof (asserts every invariant).

## For Kai (adoption notes)

- Built on **`node:sqlite`** (built-in) for zero-install demonstrability. Port to
  **`better-sqlite3`** (the mesh stack) is near-verbatim — same `prepare().run()/.get()/.all()` surface.
- This is the **logical** model. Production hardening still owed (per the design v2 + Codex S/G items):
  per-client **physical** projection files with OS permissions (defense-in-depth beyond the
  delivery split), authN/Z + signed source claims, observability (drainer lag, DLQ age, blocked
  cross-client attempts), `fact_type` JSON-Schema versioning, semantic idempotency, and the
  scheduled-drainer runner. The prototype intentionally proves the core invariants first.

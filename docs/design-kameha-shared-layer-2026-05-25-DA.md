# CA-internal Devil's Advocate — Kameha Shared Layer design

**Run:** CA session 5, 2026-05-25. **Target:** `docs/design-kameha-shared-layer-2026-05-25.md`.
**Gate:** mandatory (mesh contracts + cross-cutting, >1 repo). **Verdict:** **REVISE → proceed to Codex after folding 4 required revisions.** The architecture is sound and correctly diagnoses the root cause; four invariants must be hardened before Phase 1 builds.

## Adversarial findings

### 🔴 R1 — Misrouted/unmapped facts must fail CLOSED, not silently drop
The routing map (D1) is a new central coupling. If a `fact_type` is unmapped, or an agent's subscription is stale, the obvious failure is a fact that silently reaches no one — **the exact silent-failure class we've been hunting fleet-wide** ([[pattern-silent-failure-class-fleetwide]]). 
**Required:** unmapped/unroutable facts go to a **dead-letter queue that alerts Alex**, never a silent drop. Routing-map and subscription changes are versioned + reviewed. Define fail-open vs fail-closed explicitly (recommend fail-closed-with-alert).

### 🔴 R2 — Per-client isolation (D3) is the highest-stakes invariant; design it as default-deny + a human gate
A single subscription-scope or missing-`subject` bug leaks DAG↔TDB client data. Convention won't hold it. 
**Required:** isolation enforced at the **read/query layer as default-deny** — an agent's read is *always* filtered to its authorized subjects; a fact with no/!matching subject is invisible, not accidentally global. Adversarial cross-client tests (a DAG drainer must never return a TDB fact). And `shareable_learning` anonymization **cannot be fully automated** — for v1, cross-client shares pass a **human approval gate** before they're visible to other client repos. Do not ship auto-anonymized cross-client sharing on trust.

### 🔴 R3 — Backfill (D2) needs quarantine + scrub + review, not auto-publish
Ingesting weeks of session logs/memory risks sweeping in tokens, credentials, and PII (HB#9). Automated scrubbing is imperfect. 
**Required:** backfilled facts land **quarantined** (not visible to drainers) until a scrub pass + spot review clears them; never auto-publish backfill into client-visible scopes. Dedupe by content hash; stamp provenance; `backfilled=true`.

### 🔴 R4 — Decide EXTEND vs NEW store before Phase 1 (avoid the parallel-system trap)
The design defers the DB choice (extend `conductor.db` vs new `kameha-mesh.db`). Deferring past Phase 1 risks building a second mesh alongside the under-operated one — doubling maintenance and recreating the multi-transport mess we're trying to kill. 
**Required:** make this call up front. Lean: extend the already-authoritative `conductor.db` (it's the live shared SQLite on the Mini) + port mesh-api's route/audit tables in, rather than a greenfield DB. Confirm with Kai (owner).

### 🟡 R5 — Single store = single point of failure
The store on the Mini is the fleet's nervous system. Mini down/asleep → comms stall. 
**Should-fix:** document backup/restore (litestream-style replication already used elsewhere) + drainer retry/backoff when the store is briefly unreachable. Acceptable for v1 since the Mini is already the de-facto hub (conductor.db lives there), but the recovery story must be written, not assumed.

### 🟡 R6 — Don't let drainers burn LLM cost on every fact
If an agent wakes and LLM-reasons over each incoming fact, cost grows with traffic. 
**Should-fix:** drainers do **cheap rule-based triage first**; only escalate to an LLM when the fact genuinely needs reasoning. Ties to the cost discipline (fleet API ~$30–100/mo; keep this layer ~$0/message).

### 🟡 R7 — Consumers must tolerate reordering + replays
Facts are append-only with timestamps, delivered by independent ~60s drainers — order isn't guaranteed (e.g., "delivered" could arrive before "feedback"). 
**Should-fix:** require consumers to be idempotent and order-tolerant; document it. Reuse mesh-api's idempotency_key.

### 🟢 R8 — SQLite contention at fleet scale
~16+ agents polling one SQLite every 60s. Fine now with WAL + short transactions, but jitter the schedules and coalesce to avoid a thundering herd. Note for impl.

## What's solid (no change)
- Diagnosis is correct and now triangulated 4 ways (DAGDC, CFO, CA audit, the live CA-has-no-routes proof).
- "Push what's relevant, pull what's needed" is the right addressing philosophy — avoids both discipline-fragility and broadcast-noise.
- Keeping mesh-api's routes/audit/idempotency while fixing operability (scheduled drainers, governance-as-library) is the right reuse, not a rewrite.
- Phased rollout with a small real pilot (DAG→ACD/NAMI) de-risks correctly.

## Disposition
Fold R1–R4 (required) into the design before/within Phase 1; carry R5–R8 (should/note) into impl. Then Codex review (`docs/codex-prompt-kameha-shared-layer-2026-05-25.md`) for an independent objective pass. No code until both clear and Alex approves direction.

# Design — The Kameha Shared Layer (cross-agent information sharing)

**Author:** Code Architect · 2026-05-25
**Status:** PROPOSAL — for Alex direction → CA-internal DA → Codex review → phased build.
**Companion:** `explainers/plan-kameha-shared-layer-2026-05-25.html` (visual).
**Domain:** comms infra is Kai-led/shared; CA designs, drafts code across repos, coordinates.
**Origin:** Alex's north-star ([[project-cross-agent-info-sharing-goal]]) + the convergence of 3 session-4/5 signals (DAGDC relay-bypass, CFO mesh-not-operated, CA architecture audit) + the live proof that `code-architect` has zero mesh routes.

---

## 1. Problem

Facts get trapped in whichever repo they're typed into. Example (real, 2026-05-25): Alex told the DAG agent "Dan loved the Memorial Day posts." That matters to ACD (designed the concept) and NAMI (captioned + shipped), but neither hears it. The mesh exists but was built and never fully operated — drainers unscheduled, multiple competing transports, a buggy reply path, and entire agents (CA) never wired into the route table. There is no shared place every agent reads.

## 2. Goals & non-goals

**Goals:** (1) a fact entered anywhere reaches the agents who need it within ~60s; (2) repos stay separate; (3) durable across a sleeping/waking fleet; (4) cheap (DB I/O, not LLM calls); (5) governed (routes + audit); (6) typed, queryable memory, not just transient messages.

**Non-goals:** merging repos; replacing each agent's internal memory; real-time (<1s) delivery; an LLM in the delivery path.

## 3. Decisions (this revision — from Alex 2026-05-25)

### D1 — Addressing: typed facts + topic subscriptions + routing map (NOT discipline, NOT broadcast)

- Every record is a **typed fact**: `{ fact_type, subject, payload, source_agent, created_at, provenance }`.
  - `fact_type` ∈ a controlled vocabulary (`client_feedback`, `creative_brief`, `decision`, `status_update`, `work_order`, …) — this is the action-vocabulary registry, finally concrete ([[pattern-silent-failure-class-fleetwide]]).
  - `subject` = a client id and/or campaign/project id (the "topic").
- Each agent has a **subscription manifest**: the fact-types + subject-scopes it wants.
- A central, versioned **routing map** maps `fact_type → interested roles`, so a sender doesn't need to know the org chart — it records what happened; the layer fans out to subscribers.
- **Direct addressing** remains available for one-to-one.
- Principle: **push what's relevant (subscriptions), pull what's needed (queryable brain).** No flooding; nothing lost. An agent that later needs context queries the store rather than us pre-pushing everything.

### D2 — Backfill the shared state from existing artifacts

A one-time **ingest pass** seeds the store from what we've already accumulated: session logs, intake docs, memory cards, the architecture audit, decision records, client facts. Guardrails: dedupe by content hash; stamp `provenance` (source file + date); **scrub secrets/PII** on ingest; mark `backfilled=true` so live vs historical is distinguishable. The fleet starts with shared history.

### D3 — Client repos are first-class participants, with hard per-client isolation

Client repos (DAG, TDB, …) both contribute facts and learn from the fleet. **Hard rule:** a client repo sees only **its own client's** subjects by default. Raw cross-client data never crosses. A separate, explicit **`shareable_learning`** fact-type carries *anonymized* patterns (no client identifiers) for cross-pollination. The isolation boundary is enforced at the read/routing layer, not by convention.

## 4. Architecture

**A shared store + scheduled drainers + governance-as-a-library.**

- **Shared store** — a durable SQLite DB on the Mac Mini (extend the existing `conductor.db`, or a dedicated `kameha-mesh.db`; decision deferred to impl). Tables:
  - `facts` — the bus: append-only, typed (D1 schema), with `status`, `idempotency_key`.
  - `decision_log` — append-only cross-agent decisions (universal-brain Layer 1).
  - `client_facts` — typed client constraints/state (universal-brain Layer 1).
  - `subscriptions` — each agent's manifest (D1).
  - `route_permissions` + `audit_log` — ported from mesh-api (keep the governance).
- **Write path** — an agent records a typed fact (durable immediately). Governance (route allowed? tier? size?) runs as a **shared library call**, not a separate HTTP service that can be down.
- **Read path** — every agent runs a **scheduled drainer** (~60s, tunable) that selects facts matching its subscription + isolation scope, acts, marks read. This is the operability fix — drainers exist but were never scheduled.
- **Wire everyone in** — including CA (zero routes today) and the client repos (D3).

**Why optimized:** durable (survives sleep/wake), fast (60s), ~$0/message (DB I/O), repos stay separate, transient→permanent memory, one source of truth instead of three pipes.

## 5. The DAG pilot (Phase 1 proof)

1. Alex tells DAG "Dan loved the Memorial Day posts."
2. DAG writes `client_feedback` { subject: DAG/memorial-day, sentiment: loved }.
3. Routing map + subscriptions → ACD and NAMI drainers pick it up in ~60s. ACD logs concept-validated; NAMI marks campaign delivered.
4. The fact persists in `decision_log`/`client_facts` — queryable indefinitely.

## 6. Keep / retire

**Keep:** route permissions + tiers, audit trail, durable filesystem-backed storage, idempotency.
**Retire:** the accidental dashboard-relay path; unscheduled drainers; governance-as-separate-HTTP-service (→ shared library); silent route-table omissions (CA).

## 7. Phased rollout

- **Phase 0 — stop the bleeding:** wire all agents (incl. CA) into the route table; schedule the existing drainers; retire the relay path. Small, immediate.
- **Phase 1 — shared store + pilot:** stand up the `facts`/typed tables + governance library + subscriptions; prove the DAG→ACD/NAMI loop end-to-end.
- **Phase 1.5 — backfill (D2):** ingest existing artifacts with guardrails.
- **Phase 2 — everyone on the bus:** migrate all agents to read/write the store; topic subscriptions live; client repos onboarded with isolation (D3).
- **Phase 3 — the brain answers:** on-demand queries over the shared memory.

## 8. Open questions for DA + Codex (see DA doc + Codex prompt)

1. Single store = single point of failure — backup/restore + drainer behavior when briefly unreachable.
2. Subscription/routing-map drift — what happens when an agent's manifest is stale or a fact-type is unmapped (fail-open vs fail-closed)?
3. Per-client isolation enforcement — can a routing/subscription bug leak cross-client data? (D3 is the highest-stakes invariant.)
4. Backfill data quality + PII scrubbing correctness (D2).
5. Drain cadence vs Mini load and Alex's latency expectation.
6. Migration: old path + new path coexistence during cutover without dropped messages.
7. Ordering/causality: do facts need ordering guarantees (e.g., feedback before delivery)?

## 9. Ownership / boundaries

Kai owns comms infra; CA designs + drafts code across repos + coordinates. Per-agent edits remain governed by each repo's `.kameha/owners.json` (CA drafts, owners apply where `human_review_required`). Alex's single point of contact is CA ([[feedback-alex-relies-on-ca-to-drive]]).

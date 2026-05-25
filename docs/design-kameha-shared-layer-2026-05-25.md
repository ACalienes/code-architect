# Design — The Shared Layer (cross-agent information sharing)

**Author:** Code Architect · 2026-05-25
**Status:** PROPOSAL **v2 (post-Codex)** — CA-internal DA ✓ + Codex review ✓ done; isolation model redesigned per Codex verdict. Phase 0 ready; Phase 1 builds after this v2 is confirmed.
**Companion:** `explainers/plan-kameha-shared-layer-2026-05-25.html` (visual). **Review trail:** `…-DA.md`, `codex-review-kameha-shared-layer-2026-05-25-results.md`.

> **v2 headline (Codex B1 — accepted, retraction recorded):** isolation is NOT a shared-library filter over one readable DB (that's convention, bypassable by any direct reader). It is **structural**: a trusted router writes per-recipient `deliveries`; agents — especially client repos — read ONLY their own delivery/projection rows, never the raw `facts` table. See §4 + the codex-results doc.
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
- **v2 (Codex B2/B3/S6/S7):** `subject` string-convention is replaced by **explicit scope columns** — `client_id`, `subject_type`, `subject_id`, `visibility`, `data_class` — with FK/CHECK constraints. Ambiguous/missing client scope is **rejected at write time (preflight)**, as is an unknown `fact_type` (fails before durable publish, not into the DLQ). Routing is enforced by a **trusted router that writes immutable per-recipient `deliveries` rows**, not by each drainer's query filter. Record **classes** (fact / command / state / decision) get distinct schemas + lifecycles; commands may route through the existing mesh rather than `facts`.

### D2 — Backfill the shared state from existing artifacts

A one-time **ingest pass** seeds the store from what we've already accumulated: session logs, intake docs, memory cards, the architecture audit, decision records, client facts. Guardrails: dedupe by content hash; stamp `provenance` (source file + date); **scrub secrets/PII** on ingest; mark `backfilled=true` so live vs historical is distinguishable. The fleet starts with shared history.

### D3 — Client repos are first-class participants, with STRUCTURAL per-client isolation

Client repos (DAG, TDB, …) contribute facts and learn from the fleet. **Hard rule:** a client repo sees only **its own client's** data — enforced **structurally, not by filter** (Codex B1). Client repos **never get raw access to the central DB**; each reads a **mediated surface or a per-client projection** (separate file/DB with OS-level permissions) containing only its slice. DAG physically cannot read TDB's rows. Onboarding a client repo is **gated** behind this projection layer existing + adversarial cross-client tests passing.

**Cross-client sharing is removed from v1** (Codex B4 — `shareable_learning` is a covert re-identification channel in a 16-client universe). It returns only later, behind a redaction checklist + minimum-aggregation threshold + named reviewer + approval artifact.

## 4. Architecture

**A shared store + scheduled drainers + governance-as-a-library.**

- **Shared store** — a **dedicated** durable SQLite DB on the Mac Mini, `kameha-mesh.db` (v2/Codex S9/B1: *not* extending the production `conductor.db` — blast radius + the need for OS-level per-client isolation tilt to a separate store). Tables:
  - `facts` — internal, write-once, typed (D1 scope columns), `semantic_key` + `idempotency_key`, `observed_at`, `revoked_at`/`superseded_by`. **No agent reads this directly.**
  - `deliveries` — **per-recipient rows the trusted router writes on publish**: `(fact_id, recipient_agent, scope, status)`. A drainer reads ONLY its own delivery rows. Uniqueness `(fact_id, recipient_agent)`.
  - per-client **projections** — materialized, already-filtered slices a client repo reads via a mediated surface / OS-permissioned file (D3). DAG can't read TDB's.
  - `decision_log`, `client_facts` — universal-brain Layer 1 (claims carry `confidence`/`promotion_status`, esp. backfilled — Codex B5).
  - `subscriptions`, `route_permissions`, `audit_log` — manifests + governance (ported from mesh-api).
- **Write path** — agent records a typed record; **write preflight** rejects missing client-scope or unknown `fact_type` (Codex B2/S6) *before* durable publish. The **router** then computes `deliveries`. Governance is a shared library, but **isolation is structural (the delivery/projection split), not a filter** (Codex B1).
- **Read path** — every agent runs a **scheduled drainer** (jittered, priority-cadence per Codex S10 — fast while Alex active, slower idle) reading only its `deliveries`/projection rows; cheap rule-triage first, LLM only when an action needs it (Codex S6/S10). Consumers are idempotent + order-tolerant via `observed_at`/supersede + contract tests (Codex S11/S12).
- **Wire everyone in** — CA (zero routes today) + all agents. Client repos onboard only after the projection layer + cross-client tests exist.
- **Also designed before Phase 1** (Codex G15-G19): per-agent authN/Z + signed source claims; query-path isolation for the Phase 3 "brain" (same structural boundary); observability (drainer lag, DLQ age, **blocked cross-client attempts**); `fact_type` JSON Schema + versioning (folds in the action-vocabulary registry); first-class **retraction/correction** delivery.

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
- **Phase 2 — everyone on the bus:** migrate all agents (route-by-route matrix w/ dual-write + shadow-read, Codex S13); topic subscriptions live; **client repos onboarded ONLY after the projection layer + adversarial cross-client tests pass** (D3/Codex B1).
- **Phase 3 — the brain answers:** on-demand queries over the shared memory.

## 8. Review status (DA ✓ + Codex ✓ — both complete)

The DA (REVISE, 4 fixes) and Codex (Phase 0 sound; Phase 1 unsafe until isolation redesigned) both ran; all findings dispositioned in `codex-review-kameha-shared-layer-2026-05-25-results.md` and folded into v2 above. The one decision still owed before Phase 1 code:

- **Canonical transport + registry must be declared (Codex S14):** is Kameha the typed-memory/projection layer *on top of* the existing mesh/conductor substrate, or is mesh-api formally deprecated (with dates + adapters)? No silent parallel system. Recommend deciding this with Kai at Phase 0.

Residual items carried into impl (Codex S5/S8/S10): single-store backup/restore + corruption drill, SQLite contention (WAL/busy_timeout/jitter), priority-specific drain cadence.

## 9. Ownership / boundaries

Kai owns comms infra; CA designs + drafts code across repos + coordinates. Per-agent edits remain governed by each repo's `.kameha/owners.json` (CA drafts, owners apply where `human_review_required`). Alex's single point of contact is CA ([[feedback-alex-relies-on-ca-to-drive]]).

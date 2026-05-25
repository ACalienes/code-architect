# Codex review — Kameha Shared Layer — results & disposition

**Reviewed:** `docs/design-kameha-shared-layer-2026-05-25.md` + DA. **Date:** 2026-05-25.
**Codex verdict:** *Phase 0 sound; Phase 1 NOT safe until isolation is redesigned around enforced scoped projections/deliveries rather than shared-library filters over one readable SQLite file.*
**CA disposition:** **Accept the verdict.** Phase 0 proceeds; Phase 1 data model is redesigned before any build. 5 blockers + 9 should-fix + 5 gaps, dispositioned below.

## 🔁 Explicit retraction (per self-retraction discipline)

**What I got wrong:** the v1 design proposed *governance/isolation as a shared library* over one readable SQLite store, with drainers applying default-deny filters. **Codex Blocker #1 is correct: that is convention, not a boundary.** Any direct DB reader — a debug script, the backfill tool, a stale copy of the library, ad-hoc SQL — bypasses a library filter, and SQLite file access is all-or-nothing. The DA (R2) caught that isolation was high-stakes but still framed enforcement as a query-layer filter; that was insufficient. **Isolation must be structural, not advisory.**

**The correction:** isolation is enforced by *what an agent can physically read*, not by a filter it's trusted to apply:
- **Split `facts` (internal, write-once) from `deliveries` (per-recipient rows a trusted router computes on write).** Drainers read ONLY their own `deliveries`/projection rows — never `facts` directly.
- **Client repos never get raw access to the central DB.** They read a **mediated surface or a per-client projection** (separate file/DB with OS-level permissions) containing only their client's slice. DAG physically cannot read TDB's rows.

This also shifts **DA R4**: extending the production `conductor.db` increases blast radius and complicates per-client OS-level isolation. **Revised lean: a dedicated `kameha-mesh.db` (+ per-client projection files)**, decided on Codex #9 criteria (blast radius, RPO, authZ, schema churn) — not "avoid greenfield."

## Blockers (all accepted → folded into v2 design)

- **B1 Library isolation isn't a boundary** → facts/deliveries split + per-client projections + no raw client DB access (above). *Gates Phase 1; gates client-repo onboarding.*
- **B2 `subject` overloaded** → replace string convention with explicit columns: `client_id`, `subject_type`, `subject_id`, `visibility`, `data_class`; FK/CHECK constraints; **reject ambiguous/missing client scope at write time** (write preflight).
- **B3 Dynamic subscription queries are the wrong enforcement point** → trusted **router computes immutable `deliveries` rows on write**; drainers read only their delivery rows; client agents read materialized, already-filtered projections.
- **B4 `shareable_learning` is a covert leak channel** → **removed from v1.** Re-introduce later only with a redaction checklist + minimum aggregation threshold + reviewer identity + approval artifact + "no client/niche/date/location/staff/campaign clues" rule.
- **B5 Backfill can poison permanently** → backfilled records are **claims, not facts**: `confidence`, `source_kind`, `observed_at`, `superseded_by`, `revoked_at`, `promotion_status`. Drainers do **not** auto-act on backfilled claims until promoted.

## Should-fix (accepted → folded)

- **S6 DLQ incomplete** → unknown `fact_type` fails at **write preflight** (not after durable publish); DLQ alerts by severity/owner, batches dupes, exposes aging/SLA, distinguishes "invalid fact" from "valid fact, no subscribers."
- **S7 Mixing facts/events/commands/state** → define **record classes** with distinct schemas + lifecycles (command=ack/retry; state=upsert/supersede; fact=provenance; decision=immutable), OR keep `facts` narrow and route commands through the existing mesh/A2A path.
- **S8 SQLite failure story** → WAL + `busy_timeout` + short txns + jitter + backup/restore drill + corruption recovery + disk-space alerting + explicit drainer behavior when DB unreachable.
- **S9 conductor.db vs new** → decide on blast radius / RPO / schema churn / authZ / migration risk (see retraction; leans dedicated DB).
- **S10 60s as universal SLA is wrong** → jitter + batch + rule-triage-first + LLM only on selected actions + **priority-specific cadence** (fast while "Alex active," slower idle, push/wake later).
- **S11 Idempotency needs semantic identity** → add `semantic_key`/content hash scoped by `(fact_type, client_id, subject_id, observed_at/source)` + delivery uniqueness `(fact_id, recipient_agent)`.
- **S12 "Order-tolerant" isn't enforceable as a slogan** → per-subject sequence or `observed_at` + upsert/supersede + causal links + **consumer contract tests** for duplicate/out-of-order delivery.
- **S13 Migration double-process/drop** → route-by-route migration matrix: source of truth, dual-write key mapping, shadow-read/no-act phase, cutover date, rollback, bridge-loop prevention.
- **S14 Risk of mesh-api v2** → **declare the canonical transport + canonical registry now.** Either Kameha is typed-memory/projections *on top of* the existing mesh/conductor substrate, or mesh-api is formally deprecated with dates + adapters. No silent parallel system.

## Missing → added to scope

- **G15 AuthN/AuthZ** — per-agent identity, signed source claims, per-agent tokens, secret storage, audit-log sensitivity. *Design before Phase 1.*
- **G16 Query-path isolation** — Phase 3 "brain answers" needs the *same* tenant filter + tests as drainers. Same structural boundary, not a second filter.
- **G17 Observability** — drainer heartbeat, lag, DLQ age, route misses, pending deliveries, retry counts, **blocked cross-client attempts**, surfaced on a dashboard/briefing.
- **G18 Schema evolution** — `fact_type` gets JSON Schema + versioning + compatibility rules; **fold the action-vocabulary registry in** (not adjacent).
- **G19 Retraction/correction** — first-class: Alex can say "that fact was wrong"; agents receive corrections, not just new facts (`revoked_at`/`superseded_by` + a correction delivery).

## Net effect on the plan

- **Phase 0 unchanged and proceeds** (wire all agents incl. CA into routes, schedule drainers, retire the relay) — no client-data isolation surface there.
- **Phase 1 is redesigned before build:** facts/deliveries split, explicit scope columns + write preflight, per-client projections with OS-level isolation, dedicated DB, record classes, semantic idempotency, retraction, authZ, observability. No cross-client sharing in v1.
- **Client-repo onboarding (was Phase 2) is gated** behind the structural isolation being built + adversarial cross-client tests passing.

Next: revise the design doc to v2 with the above; re-DA the isolation model specifically; then Phase 0 implementation (lowest risk, highest relief) on Alex's go.

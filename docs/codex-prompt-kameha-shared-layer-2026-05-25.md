# Codex review prompt — Kameha Shared Layer design

Paste into the Codex VS Code plugin with `docs/design-kameha-shared-layer-2026-05-25.md` and
its DA (`-DA.md`) open. This is an **architecture/design review** (no code yet) — your job is
to objectively find holes in the logic and gaps in the plan before any implementation.

---

You are reviewing a proposed architecture for cross-agent information sharing in a fleet of
~16 autonomous AI agents, each living in its own git repo, coordinated on a Mac Mini. Today
each agent is siloed: a fact typed into one repo (e.g. "the client loved the campaign") never
reaches the other agents that need it. An older message bus ("mesh-api") exists but was built
and never fully operated — unscheduled drainers, multiple competing transports, and some agents
not even wired into the routing table.

The proposal ("Kameha Shared Layer"): **one durable shared store (SQLite on the Mini) + every
agent runs a scheduled ~60s "drainer" that reads facts addressed to it + governance (routes,
audit, isolation) as a shared library rather than a separate HTTP service.** Facts are typed
(`fact_type` + `subject`) and routed via per-agent subscriptions + a central routing map; client
repos are first-class participants but must only see their own client's data; existing accumulated
context is backfilled in once.

Read the design doc + DA for full detail. Then review **objectively and adversarially**. Don't
rubber-stamp it — assume it has flaws and find them.

Probe specifically:

1. **Addressing model.** Is "typed facts + subscriptions + routing map + direct addressing" coherent
   and complete? Where does it break — unmapped fact-types, stale subscriptions, a sender that
   mis-tags `subject`? Is fail-closed-with-dead-letter (DA R1) the right call, or does it create a
   different failure mode? Is there a simpler model that achieves the same guarantees?

2. **Per-client data isolation (the highest-stakes invariant).** Can you construct a sequence where
   one client repo (DAG) sees another client's (TDB) data — via routing bug, subject collision,
   `shareable_learning` leakage, backfill, or query-filter gap? Is a default-deny read filter + human
   gate on cross-client shares (DA R2) sufficient, or naive? What would you require instead?

3. **Single shared store.** Single point of failure on the Mini. Is SQLite + drainers the right
   substrate at this scale, or does it hit write-contention / locking / sleep-wake problems? Is the
   "extend conductor.db vs new DB" decision (DA R4) being made on the right criteria?

4. **Backfill.** Ingesting weeks of session logs + memory risks pulling in secrets/PII and low-quality
   or contradictory facts. Is quarantine + scrub + review (DA R3) enough? What's the failure mode if a
   bad fact gets in and agents act on it?

5. **Drain cadence + cost.** ~60s polling by 16+ agents — load, cost (if agents LLM-process facts),
   latency. Is the cheap-triage-then-escalate model (DA R6) right? Is 60s the wrong number either way?

6. **Ordering / causality / idempotency.** Independent drainers mean no global order. Where does
   out-of-order or duplicate delivery cause incorrect behavior? Is "consumers must be idempotent +
   order-tolerant" (DA R7) realistic to enforce across independent agents?

7. **Is this just rebuilding mesh-api?** Are we fixing operability or quietly building a parallel
   system that doubles maintenance? Where's the line, and is the keep/retire split right?

8. **Migration.** Dual-path coexistence during cutover. Where do messages get dropped or double-processed?

9. **What's missing entirely?** Anything the design and DA both failed to consider — security/authZ,
   observability, schema evolution of `fact_type`, multi-writer races, the human (Alex) as a
   participant, etc.

For each finding: severity (blocker / should-fix / nit), the concrete scenario, and a suggested
remedy. Call out anywhere the plan's logic is internally inconsistent or hand-waves a hard part.
End with a one-line verdict: is the architecture sound enough to implement Phase 0–1 after folding
the DA's required revisions, or does something fundamental need rethinking first?

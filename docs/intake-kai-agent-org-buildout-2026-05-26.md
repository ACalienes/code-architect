# INTAKE — Agent Org Buildout work order

**Origin:** Kai (on Alex's behalf), relayed by Alex into CA's session 2026-05-26.
**Original artifact:** Kai memory node `wo_ca_agent_org_buildout_2026-05-26` (DRAFT work order, type: project).
**Delivery note:** laptop Kai → CA mesh response visibility is known-broken (`feedback_mesh_response_visibility`). This brief was hand-relayed into CA's session by Alex; CA's plan returns to Alex directly.
**CA classification:** T3 (org-wide, mesh-contract + identity + multi-repo) → DA-mandatory deliverable. Deliverable is an **implementation PLAN only** — no code, no commit, no push until Alex approves the approach.

---

## Verbatim work order (as relayed)

**Ask:** Produce an implementation PLAN (NOT code yet) for the agent-org redesign. Alex approves the approach before any build. Full vision in `explainers/` (the-org-chart-vision, how-the-split-works, the-wall-goes-around-clients, the-full-office-roster, kai-mira-split-and-risks — all 2026-05-26) and `memory/project_agent_org_vision_2026-05-26.md`.

### 1. The org (v2)
- Alex (CEO) — sole human, final authority.
- Personal sphere (reports to Alex, outside business): Mira (NEW personal EA) + Chronicle (existing, wellness only).
- C-suite (report to Alex): Kai = COO (promoted from EA) + CFO (promoted, peer beside Kai).
- Control room (reports to Alex, separate): Code Architect — watches all code+agents, fixes/improves/builds.
- Office, under Kai (COO): ACD (creative lead → NAMI, Framer, Enso) · Offer Architect (sales lead → Lead Engine, Pitch Deck; dotted line to CFO) · KMG (brand spearhead — Kameha's own brand as flagship + brand standard for all client managers) · Conductor (see §4).
- Client account managers (NET-NEW): one per client, in KMG's image; first two DAG + Dental Boutique. Matrixed: solid→Kai (COO), diagonal→ACD (creative per project), functional→each working agent. KMG = elevate existing agent, not create.

### 2. Kai → COO + Mira split — "shared engine, two identities"
- Do NOT clone the Kai codebase. Build ONE shared engine (calendar, email, tasks, memory, mesh messaging); Kai + Mira are two identities on top = {personality+job, allowed tools, data lane, own memory}.
- Mira = personal lane (personal calendar, email, reminders, errands, travel, household). Kai = business lane (office ops, agent coordination, project oversight, business calendar/email, standup). Peers on the mesh — Kai does NOT command Mira; Alex bosses both.
- Mira's interface: her own dedicated channel — RECOMMEND her own Telegram bot (separate chat). Optional dashboard view.
- Mira's packaging (CA to decide in plan): own agent for sure (own process/identity/data/memory/mesh seat). Repo = shared core + thin Mira layer preferred; CA recommends exact structure.
- STAGED, never big-bang — proof gate each step: (1) stand Mira up beside Kai [boots, joins mesh, <60s test msg; Kai untouched]; (2) Mira runs personal side in parallel ~1 week [real tasks clean, a live personal/business crossover reconciled, no double-book, no context dropped]; (3) Kai sheds personal → pure COO [clean handoff, office runs].

### 3. CORE REQUIREMENTS (hard constraints)
- ≤60s inter-agent comms (Alex's key requirement). NOT met today — most agents poll 300–600s (only kai + nami-bridge at 60). Tighten intervals or go event-driven/push. Central.
- No context lost on hand-offs — pass the full thread, not a summary (Shared Layer territory).
- Clean lanes + open comms — per-identity data isolation (clean cubicles) + open mesh (anyone talks to anyone).
- Guardrails UNCHANGED — no external send without Alex approval, no financial transactions, no commitments on his behalf, no auto-chaining, never override Alex. COO = coordination authority, not autonomy.

### 4. Conductor — audit first
- Decision: Conductor becomes the COO's tracking system (infrastructure under Kai), NOT a seat in the org. Function fully preserved.
- FIRST: full objective audit of Conductor (outdated; not reviewed in a while). Document every function, surface better logic, THEN re-home. Audit-first, change-second.

### 5. Also fold in
- Mini deployment drift — Mini's deployed code behind the repo (e.g. `scripts/mesh/sync-agents-json.js` missing on Mini). Reconcile.
- agents.json refresh — Mini copy is 12 (missing kmg); sync from authoritative mesh seed (13).

### 6. Deliverable from CA
Implementation plan: packaging/architecture for shared engine + identities, the ≤60s comms solution, staged rollout with proof gates, Conductor audit approach, client-agent build spec, sequencing, risk register. For Alex's approval before any code.

### Sequencing note
Up & running ASAP BUT staged/safe — do NOT do this surgery mid-fire. Current fires: 7TB Dropbox migration in progress, Mini deploy drift, recent 24h OAuth outage. Plan around them.

---

## AMENDMENT (Alex, 2026-05-26, post-plan)
1. **Kai = Chief of Staff** (not "COO") — title only, same role.
2. **Mira (EA) DEFERRED to Phase 2 — do NOT build this pass.** Kai wears both hats (Chief of Staff + EA) as one agent. Shared-engine/two-identities split kept as a fully-specified blueprint, deferred-until-triggered (EA load vs strategic work · hard personal/business data wall · business growth). Proceed with the org *structure* (Kai coordinating ACD/Offer-Architect/KMG/Conductor/client-managers) + ≤60s comms + Conductor audit-first + deploy-drift/agents.json refresh. Everything else in the WO stands.

## CA response pointer
Implementation plan → `docs/plan-agent-org-buildout-2026-05-26.md` + `explainers/agent-org-buildout-plan-2026-05-26.html` (both reflect the amendment).
Reliable-comms fix (surfaced from CFO empty-action) → `docs/impl-action-validation-2026-05-26.md`.

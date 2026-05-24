# Intake — CFO: the mesh was built but never operated (inbox drainer unscheduled, registry stale, dual transport)

- **Date:** 2026-05-24
- **Origin:** CFO agent (Claude Code session in `~/Desktop/Code/CFO/`), relayed by Alex inline.
- **Saved per:** [[project-intake-convention-docs-dated-files]] before CA-side analysis.
- **Severity:** Architectural / operational. Not a runtime crash — work orders silently rot; agents fall back to Alex-as-relay.
- **Convergence note:** This is the THIRD independent surfacing this session of the same systemic problem. See also `docs/intake-mesh-relay-policy-bypass-2026-05-24.md` (DAGDC — relay endpoint bypasses tier policy) and `docs/architecture-current-state-2026-05-20.md` (CA audit — dual transport, registry drift, 22 silent route failures/wk). Three agents, one root cause: **the mesh was built and never fully operated.**

---

## CFO's three findings (verbatim framing)

### 1. CFO's inbox drainer exists but was never scheduled
`scripts/process_inbox.py` is built and ready. But CFO's 7 launchd jobs (alerts, snapshot, heartbeat, keepalive, tax) — none runs `process_inbox.py`. So work orders arrive and rot. **10 backed up right now, oldest from March, newest from 5/7. Nothing's drained them in ~2 weeks.**

### 2. The agents being relayed-for aren't registered
`agents.json` knows 9 nodes (kai, cfo, lead-engine, chronicle, enso, conductor, offer-architect, pitch-deck, nami). **KMG, TDB, and ACD are NOT in it.** No inbox, no address → they physically cannot reach CFO except through Alex. Registry last touched Mar 19.

> CA cross-check: my architecture audit `/agents` probe on 2026-05-20 showed 13 agents via mesh-api, but mesh-api's registry ≠ `~/.kameha/agents.json` (the static one CFO references). This is the static-vs-runtime registry drift documented in [[reference-kameha-agent-registries]]. Worth reconciling which registry is authoritative as part of any fix. **TDB (The Dental Boutique) is a new name not previously in CA's agent map — verify it's a real intended mesh participant before registering.**

### 3. Two transports, neither carrying live traffic
A filesystem protocol (`~/.kameha/delegations/`) and an HTTP one (Mac Mini :3000 / :3336). Both exist; neither is moving this session's real traffic.

> CA cross-check: matches the DAGDC finding exactly — the `/api/delegations/receive` HTTP endpoint (:3000) writes to the `~/.kameha/delegations/` filesystem inbox, bypassing the mesh-api (:3341) entirely. So there are arguably THREE transports in play (:3000 dashboard relay, :3341 mesh-api, filesystem drops). Canonical-transport selection is the crux.

## CFO's stated boundary (correct per CLAUDE.md)

> "CFO can fix its own intake and co-author the spec. But making KMG/Kai/ACD actually use a protocol means changes in their codebases — and per your own CLAUDE.md, communication is Kai's domain, money is mine. So the cross-agent protocol should be Kai-led or shared-infra; CFO shouldn't unilaterally redraw the mesh."

This is the right call. CFO owns its slice; the cross-agent contract is Kai-led / shared-infra (and CA-designed/audited).

## CFO's proposed phased plan

- **Phase 0 — CFO-side, self-executable now (~20 min):** schedule `process_inbox.py` on the Mac Mini (per the darkwake lesson — not laptop), drain + triage the 10 stale WOs, refresh CFO's registry entry, fix the stale `qb_token_status` field in the heartbeat.
- **Phase 1 — spec (CFO drafts, Kai + Alex review):** register KMG/TDB/ACD as nodes; pick ONE canonical transport; standard message + ack schema; addressing convention.
- **Phase 2 — adoption:** each agent wires send/receive to the canonical transport; prove with a live CFO↔KMG round-trip (this brand-bible data request becomes the test case).
- **Phase 3 — reliability:** heartbeat-staleness alerts + dead-letter handling for undrained inboxes.

## CA disposition (this session)

**Queued, not actioned.** This is a substantial cross-agent design item, not a hotfix. It overlaps heavily with:
- The action-vocabulary registry design (`docs/design-action-vocabulary-registry-2026-05-19.md`)
- The DAGDC mesh-relay-bypass intake (canonical transport question)
- CA's own architecture audit (dual transport, registry drift)
- The universal-brain Layer-1 direction (conductor.db as shared state)

**Recommendation for the design session:** treat CFO's Phase 1 spec, the DAGDC remediation options, and the action-vocab registry as ONE consolidated mesh-operability design rather than three separate efforts. They're the same problem viewed from three agents. A single canonical-transport + registry-reconciliation + message-schema decision resolves all three.

**Phase 0 is CFO's own slice** — CFO can self-execute (schedule its own drainer, drain its own WOs, refresh its own registry entry in agents.json, fix its own heartbeat field). CA does NOT need to drive Phase 0; CFO acts in its own repo. CA's role begins at Phase 1 (the cross-agent spec), in support of Kai-led design.

**One caution to flag back to CFO:** scheduling `process_inbox.py` should follow the same launchd-on-Mini pattern its other 7 jobs use (per the darkwake lesson CFO references). CFO knows its own launchd setup; CA shouldn't reach into CFO's launchd. If CFO wants CA to review the schedule entry before it lands, CA can — but it's CFO's repo + CFO's domain.

## CFO follow-up detail (second relay, more formal)

Additional specifics from CFO's refined diagnosis:

- **CFO heartbeat self-reports `pending_work_orders: 10`** — the backlog is visible in CFO's own health output, not just inferred from the inbox dir.
- **Transport ports clarified:** HTTP is `:3000` (Kai) / `:3336` (CFO). Filesystem is `~/.kameha/delegations/`.
- **Heartbeat staleness is uneven:** Kai's `health/kai.json` last written **Mar 14** (stale); CFO's is fresh (today). So the heartbeat layer itself is partially dead — reinforces the "built but not operated" thesis and connects to the mesh-api status-demotion bug from CA's audit (NEXT-SESSION #7).
- **nami** is listed in agents.json but **inactive**.
- **CFO's named single-highest-leverage fix:** *"pick one transport and make every agent both write to AND drain its inbox on a schedule. Right now drainers either don't exist or aren't scheduled, so even valid messages rot."*

This last point is the crux. It collapses the whole problem to two decisions: **(1) which transport is canonical, (2) every agent runs a scheduled drainer for its inbox.** Everything else (schema, addressing, registry) is downstream of those two.

## Open question for Alex

Is TDB (The Dental Boutique) intended to be a live mesh participant, or is it a client-project repo that shouldn't be a mesh node? This affects whether "register TDB" belongs in Phase 1. (DAGDC raised "register DAGDC" similarly — there may be a wave of client-project repos wanting mesh addresses, which is a bigger policy question than just adding rows to agents.json.)

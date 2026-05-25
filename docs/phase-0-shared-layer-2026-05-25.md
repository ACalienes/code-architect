# Phase 0 — Shared Layer: stop the bleeding (relief now)

**Author:** Code Architect · 2026-05-25 · **Decision in force:** Option B, phased (build the Shared Layer, retire mesh-api gradually). **Domain:** Kai-led infra; CA drafts + coordinates; Alex/Kai execute live-infra changes.

Phase 0 makes *today's* messaging actually work so the fleet stops losing information **immediately**, while Phase 1 (the new Shared Layer) is built. **Not throwaway under Option B:** the governance data (who-can-talk-to-whom) and the operational discipline (scheduled drainers) port straight into the new system; only the mesh-api HTTP plumbing is eventually retired.

Three workstreams, sequenced safest-first. Every live-infra change gets Alex's per-change go-ahead; nothing is big-bang.

---

## 0a — Wire agents into the route table (START: CA itself)

**Why first:** CA has **zero** mesh routes — it can't message any agent (this is why the NAMI "I shipped your WO" notice had to be hand-delivered). Adding routes for an agent that has none **cannot break any existing route** → lowest-risk possible change, highest relief.

**Mechanism (already exists — no code rebuild):** `PATCH /routes` on the mesh-api. The mesh deliberately allows only `alex`/`kai`/`system` to add routes, and forbids an agent from adding its own — **so this is yours (or Kai's) to run, by design.** CA does not self-provision.

**The change — run these (or have Kai run them).** Tier 2 = "queue for approval" — conservative start; the mesh auto-promotes to Tier 1 after clean approvals. NAMI is the immediate one; the rest complete CA's declared `sends_to`.

```bash
# From the laptop (Tailscale). Each gives CA one outbound route, queued-for-approval to start.
M=http://100.64.114.13:3341/routes
for to in nami kai framer enso acd cfo conductor offer-architect lead-engine; do
  curl -s -X PATCH $M -H 'Content-Type: application/json' \
    -d "{\"from\":\"code-architect\",\"to\":\"$to\",\"tier\":2,\"actor\":\"alex\",\"notes\":\"CA wire-in Phase 0 2026-05-25 — notifications/WO-completion/audit\"}"; echo
done
```

**Verify:** `curl -s "$M?from=code-architect" ` should list 9 routes.

**Durability follow-up (for Kai, human-review):** `PATCH` writes to the live DB; to survive a mesh-api re-seed, the same 9 rows should be added to the seed array in `scripts/mesh/mesh-api.js` (~line 189). CA will draft those seed lines for Kai to apply. Until then the routes persist as long as the DB does.

**Decision needed (tier):** start at Tier 2 (safe) or Tier 1 for pure notifications (faster)? CA recommends **Tier 2 → let it auto-promote.**

## 0b — Schedule the drainers that exist but never ran

Several agents have inbox-drainers that were written but never scheduled, so messages rot (CFO's `process_inbox.py` — 10 work orders stuck since March). **Per-agent, in each agent's own process manager (launchd/pm2 on the Mini).**

- **Inventory first** (CA will produce): which agents have a drainer, whether it's scheduled, and where. Known: CFO (`process_inbox.py`, unscheduled). 
- **CFO's is CFO's own slice** (self-executable, no CA action) per prior intake — CFO schedules its own.
- For the rest, CA drafts the schedule entry; the agent's owner applies. ~60s cadence, jittered.

## 0c — Retire the accidental dashboard-relay path

DAGDC found `/api/delegations/receive` (`Kai .../scripts/routes/ecosystem.js:1299-1350`) — a file-writer that bypasses the mesh's tier policy + audit. It's the "third pipe."

**Caveat (must coordinate, NOT a clean delete):** externally-relayed work orders currently *use* this path (via `~/.kameha/shared/deliver-to-kai.js`). Retiring it needs a **replacement route through the proper mesh first**, or external relay breaks. So 0c = (1) identify what still depends on it, (2) route those through the mesh, (3) then lock/remove the bypass. Sequenced after 0a (CA + others have real routes). Kai's repo, human-review.

---

## Safety & sequencing

- **Live fleet infra** — every change gets Alex's per-change go-ahead; reversible; no big-bang.
- **Order:** 0a (CA first → then other missing routes) → 0b (schedule drainers) → 0c (retire relay, only after replacement routes exist).
- **CA's role:** draft every change + verify after; Alex/Kai execute the live-infra and human-review parts.

## The canonical-transport decision (confirm with Kai)

Option B (phased) is chosen: the Shared Layer becomes canonical; mesh-api is retired gradually. **To confirm with Kai before Phase 1 code:** does the Shared Layer sit *on top of* the existing mesh substrate during transition, or do we deprecate mesh-api outright with adapters + dates? This shapes how 0a's routes carry into Phase 1. No silent parallel systems.

## Relay to Kai (copy-paste — CA still can't reach Kai until 0a runs)

> **From CA, via Alex — Shared Layer Phase 0 kickoff.** Decision: Option B, phased — we build the Shared Layer as the one canonical message+memory system and retire mesh-api gradually (agent-by-agent, dual-run during each handoff). Design + DA + Codex review are done (Codex forced an isolation redesign: per-recipient deliveries + per-client projections, not library filters).
>
> **Phase 0 asks (your infra):** (1) confirm we can add CA's 9 outbound routes via `PATCH /routes` (drafted, Tier 2) + add them to the mesh-api seed for durability; (2) inventory which agents' drainers are unscheduled so we can schedule them ~60s; (3) plan to retire the `/api/delegations/receive` relay *after* its dependents are routed through the mesh properly. (4) **Canonical-transport call:** Shared Layer on top of mesh during transition, or formal mesh-api deprecation with adapters+dates? CA's lean: Shared Layer canonical, mesh retired gradually. Your read?

# Intake — Kai work order: board fact types + kai→CA route

**Origin:** Kai (Chief of Staff), hand-relayed by Alex (mesh route `kai → code-architect` was Tier-3 blocked — the work order's own #0).
**Received:** 2026-05-27 · **Source file:** `~/Desktop/ca-board-fact-types.md`
**Classification:** T3, DA-mandatory (mesh-contract: fact-type registry + route permissions; affects all agents).

## Triangulation (CA re-verifies sender claims)
- ✅ **`kai → code-architect` blocked** — confirmed against live `route_permissions`: not listed → Tier 3. Kai's claim accurate. Mesh failed *closed* (logged + refused, not silent-dropped).
- ✅ **Board healthy** — 16 identities, 54 subs (pre-this-WO), 0 dead-letters. Confirmed.
- ⚠️ **"act-on-receipt hook exists"** — partially true. `createDrainer({db,agent,handler})` exists, but the deployed `board-drainer` uses a single generic handler that only appends to `~/.kameha/board-inbox/<agent>.ndjson`. **No agent has a per-type action handler wired** — which is exactly why all deliveries are status `read` (delivered, not acted on). The consumption contract (#3) is therefore *design + per-agent wiring*, not just config.

## The ask (3 parts)
1. **Whitelist `kai → code-architect` (Tier 2)** — so the Chief of Staff can message the engineer; ends hand-relaying.
2. **Add fact types** `objective`, `question`, `task` with all-agent subscriptions (broad fan-out like decision/status_update). Lifecycle: objective supersedable; question closeable; task = status+owner, updatable. Keep per-client-scope (internal types, client_id null unless client-scoped). Confirm the publish path.
3. **Consumption contract** — per-fact-type on-receipt behavior, with the action-gate preserved (seeing ≠ doing; work/tasks route through approval, no auto-chaining).

## CA disposition
- #1 → DONE (PATCH /routes, Tier 2, actor=alex).
- #2 → DONE (registry + all-agent subscriptions + publish CLI `board-publish.js`).
- #3 → DEFINED in `docs/spec-board-consumption-contract-2026-05-27.md`; per-agent handler **wiring deferred** (the real "consumption" build — agents currently get inbox delivery only).
- **Honest catch on closing the loop:** opening the route lets Kai *send* to CA, but CA is a single-shot CLI with **no mesh-listener daemon** (per CLAUDE.md). For "no more pasting," CA must **pull its inbox at session start** (GET /inbox/code-architect + its board-inbox). That convention is the actual loop-closer; the route is necessary but not sufficient.

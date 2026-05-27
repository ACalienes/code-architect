# Audit — Conductor (audit-first, before re-home)

**Author:** Code Architect · **Date:** 2026-05-26 · **Type:** read-only functional audit (T1). No changes.
**Purpose:** per the org plan Phase 2, document Conductor's function + every `conductor.db` consumer *before* re-homing it as the Chief-of-Staff tracking system. Audit-first, change-second.
**Code:** `scripts/conductor-agent.js` (36.7 KB) · **DB:** `~/.kameha/conductor.db` (196 KB + **3.6 MB WAL** — see §4).

---

## 1. What Conductor is

A **project/milestone tracking system** — not a judgment-making colleague. Confirms Kai's verdict ("a thing that happens, not a seat"). Capability handlers (`CAPABILITY_HANDLERS`, conductor-agent.js):

| Capability | Handler | Role |
|---|---|---|
| `project_status` | `handleProjectStatus` | report a project's state |
| `create_project` | `handleCreateProject` | register a new project |
| `update_milestone` | `handleUpdateMilestone` | advance milestone/stage |
| `scope_check` | `handleScopeCheck` | scope-vs-delivery check |
| `morning_report` | `handleMorningReport` | daily status roll-up |
| `weekly_summary` | `handleWeeklySummary` | weekly roll-up |
| `team_workload` | `handleTeamWorkload` | load across agents |

Dispatch: `processMessage(action, payload)` matches `action` to a capability by substring/keyword (conductor-agent.js:422-427) — **same loose match as CFO; same exposure to the empty/unknown-action class** (see `docs/impl-action-validation-2026-05-26.md`). Conductor is also a *sender* (submits work orders to Kai via mesh + filesystem: `submitWorkOrderToKai`, `submitWorkOrderToKaiFilesystem`) — so it rides both comms channels too.

Intake: dual — `pollMeshInbox` (mesh) + `pollInbox`/`processWorkOrder` (filesystem) + `cronCheck` (scheduled rollups). Heartbeats via `sendMeshHeartbeat` + `pulseWorkHeartbeats`.

## 2. `conductor.db` consumers (the re-home blocker — all must keep working)

~14 scripts read/write `conductor.db` directly (not via Conductor's API):
`conductor-agent.js`, `morning-briefing.js`, `email-intelligence.js`, `quickbooks-sync.js`, `project-monitor.js`, `malaga-daily-brief.js`, `verify-features.js`, `post-shoot-logger.js`, `backup-data.js`, `reconcile-projects-sync.js`, `migrate-projects-to-conductor.js`, `backfill-dagdc-conductor.js`, `seed-retainer-templates.js`, `seed-retainer-cycles.js`, `backfill-legacy-id.js`.

**Implication:** `conductor.db` is a shared project datastore that many non-Conductor scripts depend on. This is why a naive "remove Conductor the agent" would break the fleet.

## 3. Re-home assessment — it's a *reframe*, not a migration

The decision (Conductor → Chief-of-Staff tracking infra, off the org chart as a "seat") is **low-risk to execute** because:
- The **db stays put** and all 14 readers keep working — no data moves.
- Conductor's **process keeps running** (cron rollups, milestone tracking) — it just stops being modeled as a colleague.
- The only real change is **conceptual/organizational** + (optionally) how its outputs surface (under Kai's tracking, not as an independent agent voice).

**Do NOT** remove Conductor's mesh seat or process until/unless every consumer is repointed — and there's no need to, since re-home ≠ removal.

## 4. Health flags surfaced during audit
- **`conductor.db-wal` is 3.6 MB** (vs 196 KB main db). A WAL that large suggests checkpoints aren't running / a long-lived reader holds the WAL open. Worth a `PRAGMA wal_checkpoint(TRUNCATE)` health pass (separate, gated) — not part of re-home, but found here.
- Conductor shares the **empty/unknown-action exposure** (§1) — covered by the comms-fix registry; Conductor should be an early agent to add to the action-vocabulary registry.

## 5. Recommendation
Re-home is a **labeling + reporting reframe**, safe to do once the org structure is approved — no migration, no consumer changes. Two follow-ons (separate, gated): (a) WAL checkpoint health pass; (b) add Conductor's 7 capabilities to the action-vocabulary registry.

## 6. Open (deeper audit, if wanted)
Full `conductor.db` schema documentation + per-handler payload contracts were not exhaustively dumped here (this is the functional first pass). Flag if you want the schema-level audit before re-home.

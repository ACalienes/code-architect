# Intake — Audit A1: agent runtime triangulation (2026-05-19)

**Author:** Code Architect (CA), overnight read-only audit
**Scope:** triangulate online/offline truth for 13 known mesh agents across mesh-api, laptop registry, laptop health files, and static manifests
**Mutation:** none — read-only audit; this file is the only write
**Authoritative live source:** Mini mesh-api at `http://100.64.114.13:3341` (per memory card `reference_mac_mini_live_mesh_state_via_tailscale.md`)
**Sample taken at:** 2026-05-19 ~04:38 UTC

---

## 1. Summary

12 of 13 agents are live and heartbeating on Mini mesh-api. Chronicle is a P0 dead-PM2 process (no heartbeat in 4d+, mesh-api still reports `status:"active"` because the agent row was never demoted). KMG is correctly `inactive` — daemon ship is pending per W2 manifest, not a fault. The laptop-side artifacts (`~/.kameha/agents.json`, `~/.kameha/health/*.json`) are uniformly stale-by-design: nothing writes them anymore, so they are not a reliable signal source — only mesh-api is.

## 2. Per-agent triangulation table

`mesh-api` columns from `http://100.64.114.13:3341/health` + `/agents` (sampled 2026-05-19 04:38 UTC).
`laptop health` = mtime of `/Users/alex/.kameha/health/<agent>.json`.
`laptop reg.` = `status` field for the agent in `/Users/alex/.kameha/agents.json` (last updated `2026-03-19T00:00:00Z` per file:7).
`manifest` = presence of static manifest under `/Users/alex/Desktop/Code/Kai Executive Assistant/knowledge/manifests/<agent>.json` (or KMG repo for kmg).

| agent | mesh-api status | mesh-api last_hb (UTC) | laptop health mtime | laptop reg. status | manifest | verdict |
|---|---|---|---|---|---|---|
| kai | active | 2026-05-19 04:38:00 | 2026-03-14 (74d stale) | active | present (kai.json) | LIVE, healthy. 60s poll matches mesh-api cadence. |
| cfo | active | 2026-05-19 04:38:26 | 2026-05-19 00:24 (live) | active | present (cfo.json) | LIVE, healthy. Only laptop health file still fresh. `qb_token_status:"expired"` flagged in payload — non-fatal but P2. |
| lead-engine | active | 2026-05-19 04:33:19 | 2026-04-02 (47d stale) | active | present (lead-engine.json) | LIVE on Mini. Laptop health-file staleness is a data-flow artifact, not a problem (see drift #3). |
| chronicle | active | **2026-05-15 03:00:00** (4d stale) | 2026-04-01 (48d stale) | active | absent in Kai manifests dir | **DEAD-PM2-process candidate.** mesh-api also lists chronicle in `stale_agents:["chronicle"]`. P0. |
| enso | active | 2026-05-19 04:37:53 | 2026-05-03 (16d stale) | active | present (enso.json) | LIVE, healthy. |
| offer-architect | active | 2026-05-19 04:38:27 | 2026-03-19 (61d stale) | active | present (offer-architect.json) | LIVE, healthy. |
| pitch-deck | active | 2026-05-19 04:38:29 | 2026-03-31 (49d stale) | active | absent in Kai manifests dir | LIVE, healthy. Manifest absence is P2 doc drift. |
| nami | active | 2026-05-19 04:38:30 | (no health file) | **inactive** | present (nami.json) | LIVE on Render (runtime `render` per mesh-api). Laptop registry calls it `inactive` and `type:"session"` — both wrong by current truth. P1 registry drift. |
| conductor | active | 2026-05-19 04:38:26 | 2026-03-19 (61d stale, `status:"offline"`) | active | absent in Kai manifests dir | LIVE, healthy. Manifest absence is P2 doc drift. |
| acd | active | 2026-05-19 04:38:35 | (no health file) | **absent** | present (acd.json) | LIVE, healthy. Laptop registry never added ACD (registry file last updated 2026-03-19, pre-ACD). P1 registry drift. |
| framer | active | 2026-05-19 04:30:16 | (no health file) | **absent** | present (framer.json) | LIVE, healthy. Same root cause as acd — registry pre-dates framer's add. P1 registry drift. |
| nami-bridge | active | 2026-05-19 04:38:16 | (no health file) | **absent** | absent | LIVE, healthy. 60s poll matches mesh-api cadence. Registry + manifest both miss it. P1 doc drift. |
| kmg | **inactive** | null | (no health file) | **absent** | present (kmg.json in KMG repo) | EXPECTED inactive — manifest line states "status flips to active once daemon ships on Mini." Per CA manifest, daemon "ships on Mini W2"; still pending. See drift #2. |

**Source citations:**
- mesh-api `/health` and `/agents` JSON sampled 2026-05-19 04:38 UTC via Tailscale.
- Laptop registry: `/Users/alex/.kameha/agents.json` lines 1-135 (`updated_at:"2026-03-19T00:00:00Z"` at line 3; 9 agents enumerated).
- Health files: `/Users/alex/.kameha/health/{cfo,chronicle,conductor,enso,kai,lead-engine,offer-architect,pitch-deck}.json` (8 files; only cfo's is current).
- Kai manifests: `/Users/alex/Desktop/Code/Kai Executive Assistant/knowledge/manifests/{acd,cfo,enso,framer,kai,lead-engine,nami,offer-architect}.json` (8 files).
- KMG manifest: `/Users/alex/Desktop/Code/Kameha Media Group/knowledge/manifests/kmg.json` lines 1-30+.
- mesh-api routes: `/Users/alex/Desktop/Code/Kai Executive Assistant/scripts/mesh/mesh-api.js:138` (`agents.last_heartbeat` column), `:1238` (`POST /messages/:id/heartbeat` handler), `:152-158` (`message_log` heartbeat rows + `idx_log_heartbeat` partial index).
- CA manifest: `/Users/alex/Desktop/Code/Code Architect/manifest.json:1-52`.

## 3. Drift findings

### P0-1. Chronicle daemon appears dead — mesh-api still reports `active`
**Evidence:**
- mesh-api `/agents` shows chronicle `last_heartbeat:"2026-05-15T03:00:00.960Z"` — exactly **4 days, 1h, 38m stale** at sample time. Last heartbeat falls on a 600s poll boundary (matches manifested `poll_interval_seconds:600` to the second), which is the signature of the daemon dying immediately after one final heartbeat tick.
- mesh-api `/health` also lists chronicle in `stale_agents:["chronicle"]` — the API itself has flagged it; nothing has demoted the `status` field on the agent row.
- Laptop `~/.kameha/health/chronicle.json` mtime is 2026-04-01 (`whoop_sync_last:"2026-03-26"`, `status:"online"` self-claim) — consistent with the agent's local health-file writer also not running.
- No static manifest for chronicle in Kai's `knowledge/manifests/` (only kmg has a manifest outside Kai's dir, in KMG repo). Per `reference_kameha_agent_registries.md`, chronicle was a known static-manifest gap.

**Verdict:** PM2 process for chronicle is almost certainly down on Mini. The "still active" label is a mesh-api row that records last-heartbeat but does not transition `status:"active"` → `"stale"` when staleness threshold is exceeded. Per `feedback_audit_triangulate_sources.md`, three sources agree on the dead-process hypothesis: stale heartbeat, mesh-api self-declared stale list, and stale local health file.

**Severity:** P0 — Chronicle is the only health/fitness intelligence agent; 4d outage is material. Whoop/Strava sync paused since at least 2026-03-26.

### P0-2. mesh-api `status` field does not demote on heartbeat staleness
**Evidence:** chronicle is simultaneously `status:"active"` and listed in `stale_agents:["chronicle"]` on the same `/health` response. The `agents` table column `status` (mesh-api.js:138) is not automatically transitioned when `last_heartbeat` exceeds `poll_interval_seconds × N`. Operators reading `/agents` without cross-referencing `/health.stale_agents` will misread chronicle as healthy.

**Severity:** P0 design gap (not P1) because it is the single source of truth and silently lies. Caught only because this audit triangulated.

### P1-3. Laptop heartbeat data flow: writes go to Mini mesh.db only, never back to laptop
**Evidence:**
- Heartbeats are recorded via `POST /messages/:id/heartbeat` (mesh-api.js:1238) and via per-actor agent rows in mesh-api's local sqlite (`/Users/alex/.kameha/mesh/mesh.db` on Mini host).
- Laptop's `/Users/alex/.kameha/mesh.db` is **0 bytes**, mtime 2026-05-10 — never gets the Mini's writes (confirms memory card `reference_mac_mini_live_mesh_state_via_tailscale.md`).
- Laptop's `/Users/alex/.kameha/health/*.json` files are written by each agent's **own local process**, not by mesh-api fan-out. Agents that run on Mini (lead-engine, cfo, framer, …) only update those files when **that process runs on the laptop** — which it doesn't anymore for the Mini-resident agents. Hence 7 of 8 health files are 16d-74d stale even while their agents are healthily heartbeating on Mini.
- The hypothesis in the audit brief is **confirmed**: heartbeats go to Mini's mesh-api/mesh.db only. There is no sync back to laptop.

**Severity:** P1 — not a bug, but means any laptop-side audit that reads `~/.kameha/health/*.json` or `~/.kameha/mesh.db` is structurally blind. Locks in the rule from `reference_mac_mini_live_mesh_state_via_tailscale.md`: use HTTP to Mini, not local sqlite or local health files.

### P1-4. Laptop runtime registry `~/.kameha/agents.json` is stale by 61 days and incomplete
**Evidence:** file's own `updated_at` is `2026-03-19T00:00:00Z` (line 3). Enumerates only 9 agents; missing acd, framer, nami-bridge, kmg, chronicle (wait — chronicle is there; absent are acd/framer/nami-bridge/kmg/pitch-deck-as-registered-vs-actual + nami status wrong). Calls nami `inactive` + `type:"session"` when Mini mesh-api shows it as `active` + `runtime:"render"`.

**Severity:** P1 — this file is documented in the registry memory card as "runtime registry" but is in practice frozen. Any code that reads it for agent presence will return wrong answers. Either rewrite from mesh-api `/agents` (single source) or formally retire it.

### P1-5. Static-manifest coverage gaps in Kai's `knowledge/manifests/`
**Evidence:** present (8): acd, cfo, enso, framer, kai, lead-engine, nami, offer-architect. **Missing:** chronicle, conductor, pitch-deck, nami-bridge, kmg (kmg lives in KMG repo, by design). Mirrors the gap snapshot in `reference_kameha_agent_registries.md`.

**Severity:** P1 — affects discovery for any tool that walks Kai's manifests directory. Live agents without a manifest are invisible to that path.

### P2-6. KMG `inactive` is expected, not a bug
**Evidence:** KMG manifest (`/Users/alex/Desktop/Code/Kameha Media Group/knowledge/manifests/kmg.json:1-30+`) describes the daemon but mesh-api `kmg` row has `last_heartbeat:null`. CA's manifest (`manifest.json` not directly referencing it, but per the audit brief and CA agent card "ships on Mini W2") confirms daemon ship is W2 work and still pending.

**Severity:** P2 — expected state. Action is to confirm the W2 ship date hasn't slipped; not to fix anything tonight.

### P2-7. CFO `qb_token_status:"expired"`
**Evidence:** `/Users/alex/.kameha/health/cfo.json` (last write 2026-05-19 04:24 UTC) reports `qb_token_status:"expired"`, `pending_work_orders:10`. CFO daemon is heartbeating fine, but the QuickBooks token needs a refresh — pending work orders are likely stuck.

**Severity:** P2 — not an outage, but if 10 WOs accumulated they're going to clog. Surface to Alex.

### P2-8. Poll-interval ↔ heartbeat-cadence cross-check
| agent | declared `poll_interval_seconds` | observed gap from "now" | within tolerance? |
|---|---|---|---|
| kai | 60 | last_hb 38s before sample | yes |
| cfo | 300 | 12s | yes (fresh tick) |
| lead-engine | 300 | 5m 19s | yes (1× interval) |
| chronicle | 600 | 4d 1h | **NO — dead (P0-1)** |
| enso | 300 | 45s | yes |
| offer-architect | 300 | 11s | yes |
| pitch-deck | 300 | 9s | yes |
| nami | 600 | 8s | yes |
| conductor | 300 | 12s | yes |
| acd | 600 | 3s | yes |
| framer | 600 | 8m 22s | yes (within 1× interval + jitter) |
| nami-bridge | 60 | 22s | yes |
| kmg | 300 | n/a — inactive | n/a |

All live agents heartbeat within 1× poll_interval of sample time. No silent slow drift.

## 4. Recommended actions

### CA-can-fix-overnight (drafts only; no commits without go-ahead)
- **None at runtime.** All P0/P1 fixes require state-changing work on Mini or in other agents' repos. CA's session is read-only per the hard boundaries.
- CA can **draft** the following for Alex's review next session (no files written tonight beyond this intake doc):
  - Draft a chronicle stale-detection patch for `mesh-api.js` that transitions `agents.status` to `"stale"` when `last_heartbeat > 3 × poll_interval_seconds` (fixes P0-2).
  - Draft a `~/.kameha/agents.json` regenerator that pulls from mesh-api `/agents` and writes locally (fixes P1-4), or a deprecation note that retires the file.
  - Draft the missing Kai manifest stubs for chronicle, conductor, pitch-deck, nami-bridge (P1-5).

### Needs-Alex-go-ahead (next session)
- **P0-1 chronicle revival:** SSH to Mini, `pm2 status chronicle`, `pm2 logs chronicle --lines 200`. Likely `pm2 restart chronicle` after diagnosing why it died on 2026-05-15. Whoop/Strava credentials check.
- **P0-2 mesh-api stale transition:** apply the draft patch above + ship to Mini.
- **P1-4 registry retire-or-regen:** decision point — keep `~/.kameha/agents.json` and regenerate from mesh-api, or formally retire it. CA recommends regenerate-from-mesh-api as a cron, since several tools still read it.
- **P1-5 manifest gap fill:** add chronicle/conductor/pitch-deck/nami-bridge manifests under `knowledge/manifests/`.
- **P2-6 KMG W2 ship:** confirm W2 ship date for the kmg daemon and unblock if slipped.
- **P2-7 CFO QB token refresh:** ack the expired token and refresh; clear the 10 pending WOs.

### Needs-Mini-side-access (not from laptop CA session)
- `pm2 status chronicle`, `pm2 restart chronicle`, `pm2 logs chronicle` — P0-1.
- Apply any mesh-api.js patch — P0-2.
- KMG daemon initial ship — P2-6.

---

**Run ledger note:** per CA W3 rules, `run-ledger.js` ships in W4; this audit is a pre-W4 read-only run captured as a docs/ intake instead of a ledger entry.

**Origin attribution:** authored by Code Architect (CA) overnight session 2026-05-19, triggered by Alex's audit-A1 brief. No other agent authored this file.

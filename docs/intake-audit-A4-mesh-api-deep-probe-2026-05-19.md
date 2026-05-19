# Intake — Audit A4: mesh-api deep probe

- **Date:** 2026-05-19
- **Probe target:** http://100.64.114.13:3341 (Tailscale → Mac Mini)
- **Method:** Read-only HTTP GET via `curl --max-time 10`. No POSTs.
- **Source of truth for route handlers:** `/Users/alex/Desktop/Code/Kai Executive Assistant/scripts/mesh/mesh-api.js`
- **Origin:** CA self-initiated overnight audit (parent task A4). Authored by Code Architect.

---

## 1. Endpoint map

Enumerated from `mesh-api.js:792-1842`. All probed live.

| Route | Method | Status | Notes / shape |
|---|---|---|---|
| `/health` | GET | 200 | queue counters, agents, last_24h, phase1 flags |
| `/agents` | GET | 200 | 13 agents w/ capabilities (parent has this) |
| `/routes` | GET | 200 | 37 routes; `from_agent, to_agent, tier, approved_count, rejected_count` |
| `/stats` | GET | 200 | 7-day rollup by route, type, priority + `avg_response_seconds` |
| `/pending` | GET | 200 | T2-queued messages awaiting approval |
| `/blocked` | GET | 200 | route_blocked rejections (5 entries, all `nami→framer`) |
| `/recent?minutes=N` | GET | 200 | window default 10 min; 50-row cap |
| `/active-sessions` | GET | 200 | correlated work chains |
| `/inbox/:agentId` | GET | 200 | per-agent inbox |
| `/outbox/:agentId` | GET | 200 | per-agent outbox |
| `/conversation/:agentA/:agentB` | GET | 200 | full payloads |
| `/messages/:id` | GET | 200 | full message incl. `error_code`, `error_text`, `error_details` |
| `/messages/:id/chain` | GET | 200 | correlation chain |
| `/messages/:id/log` | GET | 200 | delivery log |
| `/messages` (GET) | — | 404 | only POST exists |
| `/version`, `/openapi.json`, `/docs`, `/capabilities`, `/actions`, `/metrics`, `/messages/recent`, `/messages/failed`, `/messages/rejected`, `/messages/pending` | GET | 404 | not implemented |

POST endpoints (untouched by this audit): `/messages`, `/messages/:id/heartbeat`, `/messages/:id/approve`, `/messages/:id/reject`.

---

## 2. Recent failures (7 days)

Source: `/recent?minutes=10080` filtered to `status=failed`, then `/messages/:id` for error fields.

| Created (UTC) | Sender → Receiver | Action | error_code | error_text | attempts |
|---|---|---|---|---|---|
| 2026-05-18T03:53:28 | acd → nami | social_deliverable_ready | TRANSFORM_REJECTED | "Transform social_deliverable rejected payload" — `payload missing file_path` | 3 |
| 2026-05-18T03:44:19 | acd → nami | creative_brief | UNSUPPORTED_ACTION | "Unsupported NAMI action: creative_brief" | 3 |

Both originate from the DAG holiday calendar dispatch (msg_id `dag-holiday-calendar-2026-2027-cleared`). Note: Nami's whitelist NOW includes `creative_brief` (see §5) — the cumulative `queue.failed: 39` includes earlier daemon state before Nami's handler was added. The most recent NAMI failure is the `social_deliverable_ready` v2 retry where ACD sent without `file_path`.

---

## 3. Recent rejections (7 days)

Source: `/blocked` + `/recent` filtered. All 6 are `route_blocked` (no `error_code`; rejection at the mesh-api routing layer, not at receiver).

| Created (UTC) | Sender → Receiver | Action | Reason |
|---|---|---|---|
| 2026-05-19T03:44:34 | nami → framer | schedule_post_response | route_blocked (no `nami→framer` route registered) |
| 2026-05-19T03:44:34 | nami → framer | schedule_post_response | route_blocked |
| 2026-05-19T03:44:34 | nami → framer | schedule_post_response | route_blocked |
| 2026-05-19T03:44:34 | nami → framer | schedule_post_response | route_blocked |
| 2026-05-19T02:30:33 | nami → framer | schedule_post_response | route_blocked |
| 2026-05-18T03:46:15 | acd → conductor | creative_brief | route_blocked (no `acd→conductor` route registered) |

`/stats` confirms `nami→framer total=5 rejected=5`. The `/health` "5 rejected in last 24h" matches the five nami→framer attempts.

---

## 4. Pending tier-2 detail

One queued T2 awaits Alex approval.

- **message_id:** `acd-nami-probe-1779108906`
- **Sent:** 2026-05-18T12:55:06 UTC (16h ago at probe time)
- **From → To:** acd → nami
- **Action:** `social_deliverable_ready`
- **Route tier:** T2 (`acd→nami` route in `/routes` is T2 with `approved_count=0`)
- **Payload:** `{subject: "ACD probe — contract still in place?", client: "dagdc", probe: true}` — explicit probe, not real content
- **Expires:** 2026-05-19T12:55:06 UTC (~8h after probe time — close to TTL expiry)
- **Approval needed:** Tier-2 first-time promotion of `acd→nami` route. Per `/routes` notes: "Phase 2 schedule_content originator. ACD signs off creative, fires Framer/Enso assets to NAMI bridge."

---

## 5. Per-agent action whitelist (verified vs source)

Pulled from receiver code, not from mesh-api (mesh-api routes traffic; whitelists live on receivers).

| Agent | Whitelist source | Accepted actions | Gap |
|---|---|---|---|
| **nami** | `Kai/scripts/nami-mesh-poller.js:394` | `review_reminder`, `sync_metrics`, `schedule_post`, `social_deliverable_ready`, `creative_brief` | **`creative_brief` now present** — confirms session-3 fix (Framer commit 98bf045 was Framer-side; Nami also handles it). However, `social_deliverable_ready` rejected the DAG retry for missing `file_path` (Transform-level guard, not whitelist) |
| **framer** | `Framer/scripts/daemon.py:114-145` | `generate_derivatives`, `cull_selects`, `apply_color_grade`, `retouch_photo`, `batch_export`, `expand_asset`, `generate_graphic`, `generate_layout`, `generate_text_graphic`, `generate_ai_image`, `generate_concept`, `generate_ai_video`, `generate_camera_prompt`, `generate_carousel`, `plan_carousel`, `creative_brief` | **`creative_brief` confirmed present** (session-3 fix landed). No daemon-level gap |
| **acd** | `ACD/scripts/daemon.py:115-156` | `create_project`, `generate_brief`, `project_status`, `production_snapshot`, `update_milestone`, `add_deliverable`, `update_deliverable`, `log_production_day`, `trigger_invoice`, `scope_change`, `save_inspiration`, `get_creative_direction`, `expand_asset`, `get_brand_system`, `creative_audit`, `production_strategy`, `generate_gear_list`, `add_lesson`, `get_relevant_lessons`, `weather_fetch`, `location_scout`, `release_tracking`, `shot_tracking`, `media_backup_status`, `client_review_capture`, `exif_comparison`, `project_tier_score`, `call_sheet_generate`, `production_briefing` | Receives `creative_brief_clarification` + `error` from Framer (visible in conversation log) but no explicit handler — falls through to unknown action path. Low impact (these are responses, not requests) |
| **enso** | `Enso-The-Editor/scripts/enso-daemon.py:51` | `INFORMATIONAL_ACTIONS = {status_update, briefing, notification, context_sync, acknowledgment, handoff}` + `PRODUCTION_HANDLERS` (ffmpeg auto-execute set, definition imported from a sibling module not in this scan) | Whitelist enforced at filesystem-WO router; production handler set not enumerable without deeper grep |
| **conductor, cfo, offer-architect, pitch-deck, lead-engine, chronicle, kmg, nami-bridge** | not enumerated this run | — | Out of scope for this 10-min probe. Recommend follow-up audit per agent |

---

## 6. Drift findings

### P0 — Missing routes for traffic agents are actively sending

**P0-1: `nami→framer` route is unregistered.** Nami is emitting `schedule_post_response` to Framer (5 attempts in last 24h, all rejected with `route_blocked`). This is a structured response pattern (Framer initiates `schedule_post` to Nami, Nami responds), so the missing route is breaking the reply leg. Either:
- (a) register `nami→framer` route in routes table (T1, low risk — it's a response action), OR
- (b) change Nami's reply mechanism to ride the existing `framer→nami` correlation (fire-and-forget on the reverse leg).

**Recommendation:** (a). The send pattern is already in use; the receiver-side route just isn't registered. Confirm whether the `register_routes` migration was run on prod and `nami→framer` was omitted.

**P0-2: `acd→conductor` route is unregistered.** One rejection on 2026-05-18. ACD sent a `creative_brief` as conductor-FYI (msg_id `dag-holiday-calendar-2026-2027-conductor-fyi`). Either register the route or drop the FYI sends — current behavior is a silent failure for ACD.

### P1 — Payload schema enforcement only at receiver (no contract anywhere)

**P1-1: `social_deliverable_ready` requires `file_path`** (per `TRANSFORM_REJECTED` on `dag-holiday-calendar-2026-2027-cleared-v2`). This requirement is enforced inside Nami's transform code but is NOT advertised anywhere queryable from the sender side. ACD had to fail 3 attempts to discover the requirement. Per CA scope doc §0.1 item 8: "payload-schema auto-derivation from poller AST (Phase 2; hand-extracted in v1)". This is a v1 case where a hand-extracted contract registry would have prevented the failure.

**Recommendation:** Add to CA's deferred-to-impl backlog: payload-contract registry per (receiver, action) — read-only initially, sourced from a hand-curated JSON file alongside `manifest.json`.

### P1 — ACD has no inbound handler for response actions

**P1-2:** ACD receives `creative_brief_clarification` and `error` from Framer but has no entry in its `handlers` map for either. These get `Unknown action` errors silently. Since they're responses (not requests requiring action), the impact is low — but session-2/3 noted Framer sending error replies after creative_brief failed; those errors are landing in ACD's inbox and being dropped without being surfaced.

**Recommendation:** Add `creative_brief_clarification` + `error` handlers to ACD that log to a structured `inbound_responses.jsonl` and surface a digest in the daily snapshot. Low effort, closes the visibility gap.

### P2 — Stale agent

**P2-1:** `chronicle` last_heartbeat = 2026-05-15T03:00 (4 days stale). `/health.stale_agents` lists it. No traffic during the audit window — verify intentional pause vs. silent failure.

### P2 — Tier-2 probe approaching TTL

**P2-2:** `acd-nami-probe-1779108906` expires at 12:55 UTC today (~8h from now). If left unapproved, it expires and the route stays unpromoted. Decide before TTL: approve to promote `acd→nami` T2→T1, or reject and re-issue post-fix.

---

## Recommended actions (prioritized)

1. **P0-1 (now):** Register `nami→framer` route at T1 with action whitelist `[schedule_post_response]`. Unblocks Nami's reply leg.
2. **P0-2 (this week):** Decide: register `acd→conductor` T1 with `[creative_brief]`, OR drop ACD's conductor-FYI send. Either way, silence the rejection.
3. **P2-2 (today):** Triage the queued `acd-nami-probe` — approve or reject before TTL expiry. If approving, also handle the `social_deliverable_ready` payload-schema mismatch (P1-1) before the real send.
4. **P1-1 (CA backlog):** File a deferred-to-impl note to add a hand-extracted payload-contract registry. Source: receiver transform code (`nami-mesh-poller.js` first).
5. **P1-2 (low):** ACD handler additions for `creative_brief_clarification` + `error` inbound.
6. **P2-1 (verify):** Confirm Chronicle's 4-day silence is intentional with Alex.

---

## What this audit did NOT cover (followups)

- Whitelist enumeration for conductor, cfo, offer-architect, pitch-deck, lead-engine, chronicle, kmg, nami-bridge (only nami/framer/acd/enso enumerated)
- Enso's `PRODUCTION_HANDLERS` set (imported from sibling module not in this scan)
- Verification that the `register_routes` migration history matches the live 37 routes
- Whether the 39 cumulative `failed` and 47 cumulative `rejected` counters include legacy pre-Phase-1 entries (pre-`message_log_retention` cleanup)

Authority model reminder: this is a read-only audit. No mesh state was mutated. Any route registration or schema fix above requires explicit go-ahead per change (W3 model).

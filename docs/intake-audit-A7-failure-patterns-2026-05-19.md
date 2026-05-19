# Audit A7 — Mesh Failure Patterns

**Date**: 2026-05-19
**Author**: Code Architect (overnight audit)
**Source of truth**: mesh-api at http://100.64.114.13:3341 (Mac Mini via Tailscale)
**Cumulative counts confirmed**: 328 completed / 39 failed / 47 rejected / 1 queued
**Last 24h**: 24 sent, 18 completed, 0 failed, 5 rejected

---

## 1. Data sources found

| Endpoint | Status | Useful for |
|---|---|---|
| `GET /health` | 200 | Cumulative queue counts, last_24h rollup, agent heartbeats, stale list |
| `GET /stats?days=7` | 200 | by_route / by_type / by_priority / avg_response_seconds over a window |
| `GET /agents` | 200 | Agent registry with status + heartbeat |
| `GET /inbox/<agent>?status=<failed\|rejected>&limit=N` | 200 | **Per-agent failure list with `error_code`, `error_text`, `error_details`, `payload`, `correlation_id`, `created_at`** — primary forensic source |
| `GET /outbox/<agent>?status=...` | 200 (different schema; `orders` key) | Sender-side view |
| `GET /messages*`, `/metrics`, `/failures`, `/api/v1/*`, `/` | 404 | — |

No "all failures" cross-agent endpoint exists; you must enumerate `/inbox/<agent>` per agent and union. I dumped all 13 agents to `/tmp/mesh-audit/` and flattened to TSV (55 events). Logs on disk: Kai's `logs/mesh-poller-log.jsonl` exists but is poller-side; the mesh-api itself has no on-disk error log surfaced via HTTP.

---

## 2. Failure cluster table

### By route + status (n=55 historical)

| From → To | failed | rejected | Notes |
|---|---|---|---|
| acd → kai | 0 | 16 | All `production_alert` (9) + `project_status_result` (7) — route_blocked. Pre-existing W2 issue. |
| framer → nami | 12 | 1 | **THE big cluster.** 7× `draft_caption_and_schedule` (action vocab miss), 5× `social_deliverable_ready` (payload schema miss). |
| nami → framer | 0 | **5 (all last 24h)** | `schedule_post_response` — **NEW route_blocked since session-3.** |
| kai → acd | 3 | 4 | Test traffic + pre-fix stalls + cancelled. |
| kai → nami | 0 | 2 | Cleanup-era ("duplicate from reprocessing bug"). |
| kai → cfo | 2 | 0 | `get_financial_context` failed, no error_text. |
| offer-architect → kai | 0 | 2 | `offer_approved` — route_blocked. |
| chronicle → enso | 0 | 2 | March test traffic. |
| other singletons | 4 | 5 | Synthetic test actions (`fake_unknown_action`), `Need more info`, cleaned dupes. |

### By error class

| Error | Count | Status |
|---|---|---|
| `route_blocked` (route_tier 3, no policy) | 14 | rejected |
| `duplicate from reprocessing bug` | 13 | rejected (cleanup) |
| `Unknown client slug "undefined"` (TRANSFORM_REJECTED) | 5 | failed |
| `Unsupported NAMI action: draft_caption_and_schedule` (UNSUPPORTED_ACTION) | 5 | failed |
| `unknown_action: fake_*` (synthetic test) | 4 | failed |
| Null / cancelled / Need more info | 14 | mixed (legacy, cleanup) |

### Time clustering

| Window | failed | rejected |
|---|---|---|
| March 2026 | 2 | 23 (mostly test traffic + cleanup) |
| April 2026 | 5 | 6 |
| May 2026 | **12** | **7** |
| **Last 24h** | **0** | **5** (all nami → framer) |

**Acceleration**: May is the biggest month for `failed`. All 5 last-24h rejections are the same NEW route (nami → framer responses).

---

## 3. Top P0 failures (newly identified, post-session-3)

### P0-A — nami → framer `schedule_post_response` is route_blocked (NEW, 5× in last 90 min)

- Action: `schedule_post_response` (message_type: `response`, route_tier 3)
- Error: `route_blocked` — no route policy allows nami → framer
- Correlation IDs: `wo_framer_dag_memorial_day_2026_fl3_v1`, `wo_framer_dag_independence_day_2026_v1`, `wo_framer_dag_labor_day_2026_v1`, `wo_framer_dag_veterans_day_2026_v1`, `wo_framer_dag_thanksgiving_2026_v1`
- These are all `status: draft_created` ACKs flowing **back** from Nami to Framer for DAG holiday posts. Framer kicked off batch holiday content; Nami created drafts; Nami's confirmation pings are being rejected at the mesh because the **reverse route was never added**.
- **Zero `nami → framer` messages have ever completed** — this is a brand-new route nobody whitelisted.
- Not covered by known findings. The Framer 98bf045 fix added forward direction (`creative_brief` handler) but not the return path.

### P0-B — Framer's `social_deliverable_ready` payload still missing `client` field (5× in May)

- Error: `Unknown client slug "undefined". Expected one of kameha, dag, direct_builders.`
- This is the **Nami v2 send payload schema mismatch** flagged in `docs/intake-framer-acd-nami-rca-2026-05-18.md`. Confirmed still failing — last occurrence 2026-05-10T15:30, all 5 events within 3ms of each other (batch retry burst). Same idempotency-pattern: 5 distinct message_ids, not a single message retried.
- Status: known but **not visibly remediated** in mesh-data terms. Worth re-asking Framer for fix-commit confirmation.

---

## 4. Suspected silent-failure classes

1. **Null `error_details` on `failed`** — 4 records (kai → acd `project_status`, kai → cfo `get_financial_context` ×2, kai → pitch-deck WO, framer → nami `draft_caption_and_schedule` ×2). The mesh marked them failed but stored no reason. Whatever code path errored never wrote into `error_details/error_code/error_text`. **A failure with no error string is the worst kind** — it tells the sender something broke but gives them nothing to debug.
2. **fire-and-forget response rejections do not back-propagate.** Nami's 5 `schedule_post_response` rejections succeeded only in mesh-rejecting them; Nami's daemon thinks the message was accepted because the reply model is `fire-and-forget`. Framer also doesn't know its work was successfully drafted. **Both sides falsely believe success.** This is the canonical silent failure the audit was hunting.
3. **`route_blocked` is a soft-fail in practice** — 14 of 47 rejections are `route_tier 3` blocks with no follow-up alert path. Senders learn only by polling the receiver's inbox state, which `nami` does not do for `framer`.
4. **`stale_agents: ["chronicle"]`** in `/health` — agent last heartbeat 2026-05-15T03:00. 4-day gap. Not a message failure but a delivery-impossibility for any traffic targeting chronicle. No alerts visible in the failure log because nobody has tried recently.

---

## 5. Recommended action-vocabulary registry contract (input to A6)

Each registry entry should expose enough for a sender to pre-validate **without sending**:

```jsonc
{
  "schema_version": 1,
  "agent_id": "nami",
  "vocabulary_version": "2026-05-19",
  "supported_actions": {
    "schedule_post": {
      "direction": "inbound",          // can be sent TO this agent
      "message_type": "request",
      "payload_schema_ref": "schemas/nami/schedule_post.v1.json",
      "required_fields": ["client", "deliverables", "caption_brief", "schedule_at"],
      "enum_constraints": { "client": ["kameha", "dag", "direct_builders"] },
      "idempotency": "required",
      "expected_response_action": "schedule_post_response",
      "response_route_required": "nami -> <sender>"  // KEY: forces route check
    }
  },
  "response_routes_advertised": [
    "nami -> framer", "nami -> kai", "nami -> acd"
  ],
  "rejected_actions_log_url": "/inbox/nami?status=rejected"
}
```

**Critical contract additions surfaced by this audit:**

1. `enum_constraints` per field — would have caught the `client: "undefined"` failure at the sender. Sender currently composes payload blind.
2. `expected_response_action` + `response_route_required` — would have caught the nami → framer route_blocked because Framer (sender of original `schedule_post`) would see Nami's contract demands a reverse route and fail-fast at compose time.
3. `vocabulary_version` so senders can cache + invalidate (avoid the Framer "creative_brief" stale-vocab class).
4. Mandatory `error_code` ENUM in mesh-api (e.g. `UNKNOWN_ACTION`, `TRANSFORM_REJECTED`, `ROUTE_BLOCKED`, `INTERNAL_ERROR`) — fixes the "null error_details" silent-failure class. Receiver MUST set error_code or mesh-api refuses to write status=failed.
5. **Bidirectional route registration** — when route policy adds `framer → nami`, it must also auto-add `nami → framer` for the matching `*_response` action unless explicitly suppressed. The current asymmetry is the root cause of P0-A.

---

## Raw data

- `/tmp/mesh-audit/*.json` — per-agent dumps
- `/tmp/mesh-audit/all-events.tsv` — flattened TSV (55 rows)

(Ephemeral location; not committed. Re-derivable from mesh-api in < 30s.)

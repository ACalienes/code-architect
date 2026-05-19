# Intake — A6 mesh-contract audit (2026-05-19)

Auditor: Code Architect (overnight read-only audit)
Scope: Find silent-failure risks where sender X sends action Z that receiver Y's daemon does not whitelist (the class that caused the session-2 Framer/`creative_brief` bug, fixed at Framer commit `98bf045`).

Verified: Framer commit `98bf045 feat(daemon): add creative_brief handler — land ACD briefs in human-review queue` is present in Framer's git log; Framer daemon at `/Users/alex/Desktop/Code/Framer/scripts/daemon.py:123-146` now routes `creative_brief` to `_handle_creative_brief` via `handlers` dict.

---

## 1. Per-agent action whitelist (code-truth, not manifest)

| Agent | Whitelist source | Whitelist (verbatim) |
|---|---|---|
| **ACD** | `/Users/alex/Desktop/Code/ACD/scripts/daemon.py:124-156` `handlers` dict | `create_project, generate_brief, project_status, production_snapshot, update_milestone, add_deliverable, update_deliverable, log_production_day, trigger_invoice, scope_change, save_inspiration, get_creative_direction, expand_asset, get_brand_system, creative_audit, production_strategy, generate_gear_list, add_lesson, get_relevant_lessons, weather_fetch, location_scout, release_tracking, shot_tracking, media_backup_status, client_review_capture, exif_comparison, project_tier_score, call_sheet_generate, production_briefing` |
| **Framer** | `/Users/alex/Desktop/Code/Framer/scripts/daemon.py:123-146` `handlers` dict | `generate_derivatives, cull_selects, apply_color_grade, retouch_photo, batch_export, generate_graphic, generate_layout, generate_text_graphic, expand_asset (alias→generate_derivatives), generate_ai_image, generate_concept, generate_ai_video, generate_camera_prompt, generate_carousel, plan_carousel, creative_brief` |
| **Enso** | `/Users/alex/Desktop/Code/Enso-The-Editor/scripts/enso-daemon.py:51-57,344-368` + `scripts/lib/production_handlers.py:622-634` | INFORMATIONAL: `status_update, briefing, notification, context_sync, acknowledgment, handoff`. PRODUCTION: `trim_video, concatenate_videos, color_grade_lut, export_platform, extract_audio, add_subtitles, remove_silence, reframe_video, probe_media, generate_thumbnail, convert_format`. **All other actions → human-review queue (notify_kai_for_review).** Never silent. |
| **CFO** (mesh path) | `/Users/alex/Desktop/Code/Kai Executive Assistant/scripts/cfo-agent.js:339-373` + `/Users/alex/Desktop/Code/CFO/scripts/telegram_bridge.py:470-476` WORK_ORDER_ACTIONS | mesh-side: `request_financial_context, financial_context`, plus capability-keyword fallback to `cash_summary, margin_data, invoice_status, financial_snapshot, ar_ap_report`. fs-side: same five WO actions. |
| **Nami** (mesh→HTTP bridge) | `/Users/alex/Desktop/Code/Kai Executive Assistant/scripts/nami-mesh-poller.js:394-399` ACTION_MAP | `review_reminder, sync_metrics, schedule_post, social_deliverable_ready, creative_brief`. Unknown → terminal `failed` with `UNSUPPORTED_ACTION` (loud — not silent). |
| **Nami** (HTTP intent layer) | `/Users/alex/Desktop/Code/Nami Social Media Coordinator/nami-platform/routers/bridge.py:48-56` SUPPORTED_ACTIONS | `notification.dispatch, intent.schedule_content, intent.review_reminder, intent.sync_metrics, intent.revision_complete, intent.creative_brief, outbound.queue` |
| **Offer Architect** | `/Users/alex/Desktop/Code/Kai Executive Assistant/scripts/oa-daemon.js:52-77,1146-1220` | Hard-typed: `research_audit, price_offer, go_no_go, stress_test_pricing`. **Permissive fallback**: any other action → Claude evaluation with default model (treats unknown action as natural-language work order). Default if action missing: `price_offer` (`oa-daemon.js:1266`). |
| **Conductor** | `/Users/alex/Desktop/Code/Kai Executive Assistant/scripts/conductor-agent.js:286-294,422-448` | `project_status, create_project, update_milestone, scope_check, morning_report, weekly_summary, team_workload`. Fuzzy keyword fallback; final fallback = ACK with `needs_manual_action: true` (not silent). |
| **Pitch Deck Engine** | `/Users/alex/Desktop/Code/Kameha Pitch Deck Engine/scripts/pde-daemon.js:683-700` | `build_addendum`. ANY OTHER ACTION → PATCH status=completed with no work done. **SILENT FAILURE.** |
| **Chronicle** | `/Users/alex/Desktop/Code/Chronicle/src/` | No mesh-action ingestion path. Only outbound heartbeat at `src/services/kai/heartbeat.ts`. |
| **Lead Engine** | `/Users/alex/Desktop/Code/Kameha Lead Engine/run_dashboard.py` + FastAPI app | No mesh-action ingestion path; FastAPI dashboard backend only. |
| **Code Architect** | `manifest.json:mesh.receives_from = []` | Receives nothing. Sends-only per spec. |

---

## 2. Sender → receiver action map (selected high-risk paths)

Action vocabulary collected from: ACD/Framer/Enso daemons (`mesh.send_message(...)`), Kai catalogs (`scripts/lib/intent-classifier.js:16-79`), and Kai's CFO/CFO/OA `/api/kpis` capability map at `cfo-agent.js:200-204`.

| Sender | Receiver | Action sent | In receiver whitelist? | Risk |
|---|---|---|---|---|
| ACD | kai | `create_project` | (kai has no static whitelist; bot side) | OK (kai mesh-poller forwards to UI) |
| ACD | framer | `generate_derivatives` | YES (`daemon.py:125`) | OK |
| ACD | framer | `creative_brief` (session-2 history) | YES now (`daemon.py:145`, commit 98bf045) | **FIXED** |
| Framer | (sender of original) | `error` | n/a — passthrough | OK |
| Kai (intent-classifier catalog) | acd | `daily_snapshot` | NO — ACD has `production_snapshot`, not `daily_snapshot` | **P0 silent — ACD's `else` branch on `daemon.py:182-183` just `logger.warning + mesh.acknowledge`; no error reply** |
| Kai (intent-classifier catalog) | offer-architect | `offer_analysis` | NO exact handler — falls into permissive Claude fallback at `oa-daemon.js:1185-1220` | **P2 — semantically OK (OA evaluates anything) but not contract-typed; can produce off-spec output silently** |
| Kai (intent-classifier catalog) | conductor | `stage_update` | NO — Conductor's `CAPABILITY_HANDLERS` does not include `stage_update` | **P1 — falls into Conductor's fuzzy fallback at `conductor-agent.js:422-448`, may resolve to wrong handler or returns `needs_manual_action`** |
| Kai (intent-classifier catalog) | cfo | `draft_invoice` | NO — neither mesh-side (`cfo-agent.js`) nor fs-side WORK_ORDER_ACTIONS knows `draft_invoice` | **P1 — CFO mesh path will not match, may fall through to keyword capability mapping; fs path returns explicit fail (loud)** |
| Kai (intent-classifier catalog) | lead-engine | `score_prospect`, `pipeline_status` | **NO RECEIVER AT ALL** — Lead Engine has no mesh-ingesting daemon | **P0 silent — sender thinks it delegated; receiver never reads. Messages will sit in `/inbox/lead-engine` until expired** |
| ACD/Enso/Framer | nami (via nami-mesh-poller) | unknown actions | Maps reject loudly (`UNSUPPORTED_ACTION`) | OK — loud failure |
| (any) | pitch-deck | anything ≠ `build_addendum` | NO | **P0 silent — PDE marks message `completed` with no work performed; sender sees success** |
| (any) | enso | unrecognized action | Enso routes to human-review queue (`enso-daemon.py:367-368`) | OK — loud (notifies Kai) |

Static-manifest vs runtime drift (separate from above):
- **Framer manifest `framer.json:capabilities` does NOT list `creative_brief`** even though Framer's daemon implements it (commit 98bf045). DRIFT — manifests are stale source-of-truth.
- ACD manifest lists `analyze_visual` and `production_briefing` capabilities, but daemon handlers dict only includes `production_briefing`; `analyze_visual` has no handler.

---

## 3. Mismatch findings (P0 / P1 / P2)

### P0 — Silent failures (sender believes it sent work; receiver does nothing or doesn't exist)

1. **PDE accepts only `build_addendum`; everything else is silently `completed`.** `/Users/alex/Desktop/Code/Kameha Pitch Deck Engine/scripts/pde-daemon.js:683-700`. There is no `else` branch — `if (msg.action === 'build_addendum' && msg.payload)` falls through to PATCH status=completed at line 697-699. **This is the next Framer/`creative_brief` case** — PDE's manifest declares two capabilities (`build_addendum, build_update`, line 233) but only one is implemented; `build_update` will succeed-by-default with zero work.
2. **Lead Engine has no mesh-receiving daemon at all.** Kai's `intent-classifier.js:60-62` advertises `score_prospect` and `pipeline_status` to peers as if Lead Engine were a mesh agent. Any message sent to `lead-engine` will sit in `/inbox/lead-engine` unclaimed until mesh-reconciler expires it. Sender's perspective: delegated and queued; reality: never processed.
3. **ACD `daily_snapshot` mismatch.** Kai's intent-classifier catalogs `daily_snapshot` for ACD (`intent-classifier.js:53`) but ACD daemon's `handlers` dict has `production_snapshot`. ACD's `else` branch at `daemon.py:181-183` logs warning + acknowledges without sending an `error` back. Framer's else branch (lines 171-177) sends `error` reply — ACD does not. **This is functionally identical to the original Framer creative_brief bug.**

### P1 — Loud failure but suboptimal

4. **Kai catalog `stage_update` → conductor**, no exact-match handler. Conductor's fuzzy keyword fallback at `conductor-agent.js:425-431` may resolve `stage_update` to `update_milestone` (substring "update") and process with wrong semantics. **Wrong-handler routing is more dangerous than no-handler routing.**
5. **Kai catalog `draft_invoice` → cfo**, no handler on either path. CFO mesh path's keyword-capability resolver may misroute (e.g., "invoice" keyword maps to `invoice_status`); CFO fs path fails loudly.
6. **ACD `analyze_visual` capability claimed but unimplemented** (manifest vs daemon drift). Any Kai → ACD `analyze_visual` will hit ACD's silent else branch (same risk profile as #3).

### P2 — Permissive accept (works but uncontracted)

7. **Offer Architect treats every unknown action as natural-language work order** (`oa-daemon.js:1185-1220` falls into Claude evaluation). Messages with malformed/wrong action strings still produce a Claude response. Not a silent failure but contract violation — payload schema isn't enforced.
8. **Conductor's final fallback ACKs with `needs_manual_action: true`** rather than explicit `error`. Sender's response handler may not distinguish "I did the work and flagged it" from "I have no handler for this." Less dangerous than PDE but still ambiguous.

### Next Framer/creative_brief case (single nominee)

**P0 #1 — PDE `build_update`**. PDE advertises the capability, has no implementation, and silently completes. This is the strict isomorph of the session-2 Framer bug; if/when any agent sends `build_update` to PDE, the sender will believe a pitch deck update happened. Recommend Framer/creative_brief-style fix: add `_handle_build_update` to PDE's dispatch and ensure the unknown-action branch sends an `error` reply (PDE does not currently do this either).

P0 #2 (Lead Engine has no daemon) is a different class — receiver doesn't exist at all — but is arguably worse because there's no process to fix locally; needs new daemon scaffold.

---

## 4. Recommended action-vocabulary registry sketch

What CA needs to catch these at send time before the bytes hit `/messages`:

**Single-file canonical registry** at `~/Desktop/Code/Kai Executive Assistant/knowledge/action-vocabulary.json` (or wherever mesh-api can read it):

```json
{
  "schema_version": 1,
  "generated_at": "2026-05-19T00:00:00Z",
  "agents": {
    "framer": {
      "daemon_path": "/Users/kai/Desktop/Code/Framer/scripts/daemon.py",
      "daemon_lines": "123-146",
      "actions": [
        {"name": "generate_derivatives", "payload_required": ["image_path", "client_slug", "project_id"], "payload_optional": ["target_platforms", "brand"], "implemented": true},
        {"name": "creative_brief", "payload_required": ["brief_id", "client", "subject"], "implemented": true, "added_at_commit": "98bf045"},
        {"name": "build_update", "implemented": false, "advertised_in_manifest": false}
      ],
      "unknown_action_behavior": "error_reply"
    },
    "pitch-deck": {
      "daemon_path": "/Users/kai/Desktop/Code/Kameha Pitch Deck Engine/scripts/pde-daemon.js",
      "daemon_lines": "683-700",
      "actions": [
        {"name": "build_addendum", "implemented": true},
        {"name": "build_update", "implemented": false, "advertised_in_manifest": true}
      ],
      "unknown_action_behavior": "silent_complete"
    },
    "lead-engine": {
      "daemon_path": null,
      "mesh_ingest": false,
      "actions": [],
      "advertised_by_kai_classifier": ["score_prospect", "pipeline_status"],
      "unknown_action_behavior": "no_receiver"
    }
  }
}
```

Three required fields per agent:

1. `daemon_path` + `daemon_lines` — auditable single source of truth (regenerated from AST/regex scan; CA already does manifest-validation).
2. `unknown_action_behavior` — enum `{error_reply, silent_complete, human_review, permissive_claude, no_receiver}`. This is the load-bearing field. `silent_complete` and `no_receiver` are blockers; mesh-api should refuse to deliver to those receivers without a recognized action.
3. `advertised_in_manifest` per action — exposes manifest/runtime drift (Framer `creative_brief` not in manifest; PDE `build_update` in manifest but not implemented).

**Mesh-api enforcement hook**: at POST `/messages`, look up `to_agent` in registry; if `action` not in `actions[].name`, return 409 with `unknown_action_behavior` so sender knows what would happen. Backward-compat mode: registry stays advisory until all agents pass; switch to enforce mode once silent-complete/no-receiver are zero.

**CA generation script** (Phase 2 candidate): `code-architect map --emit-action-vocabulary` walks each agent's daemon, extracts dispatch dict / switch tables / `if action ==` chains, and writes the registry. Per scope doc §0.1 DEFERRED-TO-IMPL #8 (payload-schema auto-derivation from poller AST), this is a Phase 2 task; v1 hand-extracted from this audit.

---

## Files referenced (absolute)

- `/Users/alex/Desktop/Code/ACD/scripts/daemon.py` — lines 113-183, 124-156
- `/Users/alex/Desktop/Code/Framer/scripts/daemon.py` — lines 115-177
- `/Users/alex/Desktop/Code/Enso-The-Editor/scripts/enso-daemon.py` — lines 51-57, 340-378
- `/Users/alex/Desktop/Code/Enso-The-Editor/scripts/lib/production_handlers.py` — lines 622-634
- `/Users/alex/Desktop/Code/Kai Executive Assistant/scripts/cfo-agent.js` — lines 200-204, 339-373, 475-533
- `/Users/alex/Desktop/Code/Kai Executive Assistant/scripts/oa-daemon.js` — lines 52-77, 1146-1220, 1255-1290
- `/Users/alex/Desktop/Code/Kai Executive Assistant/scripts/conductor-agent.js` — lines 286-294, 393-449
- `/Users/alex/Desktop/Code/Kai Executive Assistant/scripts/nami-mesh-poller.js` — lines 394-410
- `/Users/alex/Desktop/Code/Kai Executive Assistant/scripts/lib/intent-classifier.js` — lines 16-79
- `/Users/alex/Desktop/Code/Nami Social Media Coordinator/nami-platform/routers/bridge.py` — lines 40-56
- `/Users/alex/Desktop/Code/CFO/scripts/telegram_bridge.py` — lines 468-517
- `/Users/alex/Desktop/Code/Kameha Pitch Deck Engine/scripts/pde-daemon.js` — lines 233, 670-704
- `/Users/alex/Desktop/Code/Kai Executive Assistant/knowledge/manifests/framer.json` (no `creative_brief` — drift)
- `/Users/alex/Desktop/Code/Kai Executive Assistant/knowledge/manifests/acd.json` (lists `analyze_visual`, `daily_snapshot` not in daemon)
- `/Users/alex/Desktop/Code/Code Architect/manifest.json` — CA's own `mesh.sends_to` block

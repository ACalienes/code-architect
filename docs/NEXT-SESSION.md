# NEXT SESSION — pickup prompt

_Last updated: 2026-05-28 (end of session 10). Paste/skim this to resume._

## ► START HERE — the gating action
**Paste `drafts/board-consume/codex-code-review-prompt.md` into the VS Code Codex plugin.** Phase 2's deployment is gated on this code-level Codex pass — per Alex's standing "include codex in the build" rule.

When the verdict lands:
- **READY** → CA runs internal DA, deploys Phase 2 additively to the Mini (it's additive, can't break any existing flow because no agent consumes yet), then starts Phase 3.
- **REVISE** → CA folds every finding into `board-gateway.js` + `board-gateway.test.js`, re-runs the full 39 tests, pushes v2, prepares for re-review.

## State of play — the long-term architecture

The session-10 strategic decision: **Option C — Gateway-based consumption (HTTP-native).** Closes the supervisor-decisions → agent-actions loop by extending the same gateway agents already use to publish, so they read + ack through it too. Token-bound identity in both directions; no filesystem-inbox per-agent state machines; no mesh-bridge glue forever.

### Phase 1 — DONE (commit `c6f2b17`)
DA-a critical pre-consume fix: supervisor's `/action` endpoint had no auth — anyone on the tailnet could forge "Alex approved X" facts. Now uses an auto-generated 32-byte token in `~/.kameha/supervisor.token` (0600), embedded server-side in the rendered HTML as `window.__SUP_TOK`, browser sends `X-Supervisor-Action` header back. Verified end-to-end. Rotation = delete file + restart supervisor.

### Phase 2 — BUILT, TESTED, NOT YET DEPLOYED (commit `c522526`)
Gateway extensions per `docs/design-board-consume-gateway-2026-05-28.md` v2 (Codex round 1 REVISE → 8 findings folded → DA passed with 5 conditions). All 39 gateway tests green (24 originals + 15 new v2).
- **Schema (additive, idempotent migrations):** `gateway_tokens.scopes`, `deliveries.{claimed_at, claimed_by, lease_until, dead_reason, delivery_attempts}`, new tables `gateway_actions` (action ledger with `intent/completed/failed/ambiguous` enum + `ext_ref` for external receipt IDs) and `gateway_quarantine` (durable permanent-failure log).
- **New endpoints (all Bearer-auth + scope-checked + rate-limited):** `GET /inbox?limit=N` (read scope) · `POST /claim/<id>?lease=N` (read scope, 5min default, 30min cap, same-agent renewal) · `POST /ack/<id>` (ack scope, atomic first-writer-wins) · `POST /quarantine/<id>` (ack scope, distinct from acked).
- **`handlePublish` guards added:** `supervisor_decision` requires `alex` + `supervise` scope (Codex P0 #5 forgery fix); every publish requires `publish` scope (Codex P0 #1).
- **`shared-layer.js` drainer race fix:** `drain()` UPDATE guarded `WHERE status='pending' AND acked_at IS NULL` — drainer can no longer resurrect acked deliveries (Codex P0 #3).
- **`FACT_TYPES` adds `'supervisor_decision'`; `registry.js` contract:** required `decision` (enum `approve|reject|dismiss`), `subject_fact_id`, `supervisor_action_id`; optional `rationale`.

Code-review prompt at `drafts/board-consume/codex-code-review-prompt.md` covers: scope enforcement coverage, supervisor_decision forgery guard (esp. against `board-publish.js`'s lenient `--from` and mesh-bridge `decision` classifications), inbox SQL + client scoping, claim atomicity under contention, ack idempotency, quarantine race, drainer guard semantics, HTTP routing safety, ALTER TABLE migration safety, action-gate preservation, no-fact-type smuggling.

### Phase 3 — NEXT (after Phase 2 deploys)
- Build `board-consume-lib.js` (HTTP polling loop: claim → handler → ack; transient vs permanent classification; action-ledger check before external action).
- Build `board-consume-cfo.js` (CFO handlers: `supervisor_decision` on cfo-draft subjects → look up draft file → surface/send; `status_update` `status=comment` → annotate draft file).
- **Switch supervisor `/action` to publish `supervisor_decision`** (with a generated `supervisor_action_id` UUID per click) instead of plain `decision`.
- **Enroll `alex` token with `supervise` scope** (currently has `publish` only):  
  `node gateway-enroll.js alex --scopes=publish,supervise` *(need to add `--scopes` flag to gateway-enroll.js too — currently it doesn't accept scopes; small follow-up)*
- Codex on Phase 3 code → DA → deploy.

### Phase 4 — LATER
Per-agent rollout (Kai, OA, ACD, Framer, KMG, NAMI, Enso, Lead Engine). ~30-50 lines of handler code per agent. Retire the ca-mesh PATCH special case once Code Architect's consumer reads `supervisor_decision` like every other agent.

## Honest-disclosure (DA-c)
The ~10 `decision` facts Alex posted via the supervisor today are PLAIN `decision`, not `supervisor_decision` — they're audit-only under v2. After Phase 3 ships, if Alex wants any of those clicks to actually trigger downstream action (e.g., the TDB May invoice send), he re-approves via the updated supervisor. None of his work was lost; just the action wiring hasn't reached those facts yet.

## Live infra recap (Mini, pm2-saved)
**Write side (current):** `board-gateway` (publish only — Phase 2 endpoints not yet deployed), `board-drainer`, `board-ledger` (with v3 directed phrasing), `board-sync`, `board-emit-cfo`, `board-emit-artifacts`, `board-emit-outbox`, `board-emit-mesh`, `board-supervisor :3352` (v3.1 + DA-a auth).

**Mini-side cleanups verified healthy:**
- `kai-bot` stable post-fix (Step 1 of Kai's WO done: `mesh-poller-state.json` rotated to `.STUCK-2026-05-28.json` + restart; no new restarts since).
- `sync-repos.sh` hardened + re-armed (running hourly, ff-only, skip-diverged).

## Open items (parking lot)
1. **Step 2 of Kai's bot WO (KMG cron throttle)** — needs `~/kai` investigation; KMG only has *handlers* for `query_positioning`/`query_brand_bible`, the cron sender is elsewhere. Authority unlocked under `feedback_ca_can_edit_all_repos_with_discussion`.
2. **Lead Engine fix → main PR** — heartbeat fix `dc0df07` still on backup branch `mini-backup/leadengine-2026-05-27`; conflicts with `owners.json` `6f525ff` on `delegation.py` — needs review.
3. **Hannah Goldy invoice-trigger** — Framer-vs-CA builder decision still open.
4. **`gateway-enroll.js` needs a `--scopes` flag** — small follow-up before Phase 3 deploy.
5. **Email/iMessage client comms bridge** — TDB notes/feedback works; if Alex routinely talks with TDB outside the notes folder (email/iMessage), that channel needs its own bridge later.

## Standing context (don't re-derive)
- Branch `session-8-board-consumption` is unmerged to `main` (the right posture — Phase 2 isn't deployed yet; merge after Phase 3 ships).
- Spine: `[[project_agent_org_buildout]]`, `[[project_board_emit_hooks_priority]]`, `[[reference_laptop_mini_board_wall]]`, `[[reference_mini_sync_broken_2026-05-27]]`.
- Authority extension: `[[feedback_ca_can_edit_all_repos_with_discussion]]` — CA can edit any repo with discussion, overrides HB#2 owners-policy gate (HB#1 per-commit go-ahead still applies).
- "Include Codex in the build" — every phase gets a code-level Codex pass, not just the design.
- Big responses as HTML (standing) — for dense status updates, build an explainer; keep chat to a short pointer.

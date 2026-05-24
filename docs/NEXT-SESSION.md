# CA Next Session Pickup (session 5)

**Paste this entire file into a fresh Code Architect Claude Code session** to pick up from session 4 (wrapped 2026-05-24, spanned 5 days, 14 files uncommitted).

---

You are Code Architect, continuing from session 4 — the heaviest CA session to date. Full context is in your auto-memory at `memory/session-2026-05-24.md`. Standing rules indexed in `MEMORY.md`. Reference snapshot of Mini architecture in `memory/reference_mac_mini_architecture_ground_truth_2026-05-20.md` (and the source doc at CA repo `docs/architecture-current-state-2026-05-20.md`).

## First 3 moves (in order, before anything else)

1. **~~OAuth hotfix~~ — CLOSED 2026-05-24 20:08 UTC.** Mini's `~/.kai/credentials.json` + `~/.kai/tokens.json` updated with new 5-scope refresh_token. Laptop `~/.kai/gsuite-env` synced. All three smoke tests passed (calendar 4 events, Gmail 37,555 messages, syncToSheet 283 entries). `consecutiveFailures: 0`. Backups at `~/.kai/*.bak-2026-05-24`. Kai notified to `pm2 start kai-bot`.

2. **Prompt-cache patch — APPLIED + COMMITTED LOCALLY, NOT PUSHED.** Codex v2 PASSED (`docs/codex-review-2026-05-22-prompt-caching-v2-results.md`). Patch applied to Kai's laptop checkout, committed as **`5a3098e7`** (3 files, 125 insertions). Regression test re-verified in Kai's tree. **Push was halted** on discovery of Kai-repo git corruption (see #2a).
   - **Pickup:** main HEAD (`5a3098e7`) is verified clean — 5,177 objects walked, zero missing-object errors. Push is SAFE (corruption is off-main, doesn't travel). `cd "~/Desktop/Code/Kai Executive Assistant" && git push origin main`. Then SSH Mini `cd ~/kai && git pull`. Then Kai restarts `kai-bot` (also picks up OAuth fix in same restart — bot is currently STOPPED).
   - Verify cache_read at turn 3+ in subsequent multi-turn Telegram/dashboard sessions (not turn 1 — write-premium first).
   - Low-sev Codex nice-to-haves (not blockers): add consecutive-user assertion to README regression test; flag `scripts/lib/enrichment-pipeline.js` as separate tool-loop surface.

### 🩹 2a. Kai laptop repo — git corruption (off-main, low-stakes)

`git fsck` on `~/Desktop/Code/Kai Executive Assistant` found corruption CONFINED OFF-MAIN: dead branch `refs/heads/mesh-bus-tonight` (invalid sha1), corrupt `refs/stash`, many invalid HEAD reflog entries, 6 truncated/inaccessible promisor packs (partial-clone artifacts, dated May 10–22), 1 missing commit `43e03642` referenced only by off-main commit `95386b7d`. **Main branch verified clean** (full object walk, zero missing). This was the root cause of the recurring stale `index.lock` incidents 5/24.

Optional cleanup (state-changing on Kai — per-step go-ahead): `git branch -D mesh-bus-tonight`, `git stash clear`, `git reflog expire --expire=now --all`, `git repack -ad`, optionally `git fetch` to re-pull promisor objects. ~15 min. Not urgent — main is clean, push is safe without it. Pre-existing condition (~2 weeks old).

### 🌐 2b. CONSOLIDATED mesh-operability design — THE headline item (queued)

Three intakes converged this session (3a DAGDC, 3b CFO, + CA's own audit) on one root cause: **the mesh was built but never fully operated.** Queued for a dedicated session. Draft ONE consolidated decision brief folding all three + the action-vocab registry.

**The decision collapses to two things** (CFO's framing): (1) pick ONE canonical transport, (2) every agent runs a scheduled inbox drainer. #2 is operational discipline. #1 is the architectural fork.

**Three transports in play:** mesh-api `:3341` (rich — tier/audit/routes, but under-operated + buggy reply-path + status-demotion); filesystem `~/.kameha/delegations/` (dumb but durable, drainers exist-but-unscheduled); dashboard relay `:3000`/`:3336` (the accidental third path DAGDC found — eliminate, don't choose).

**CA's lean (to ratify with Kai):** filesystem inbox + scheduled drainers as canonical substrate, with mesh-api's tier/audit logic layered in as a drainer-side validation library (not a separate HTTP hop). Shortest path to "messages stop rotting," durable-by-default for a sleep/wake fleet, kills the dashboard-relay path. Domain boundary: Kai-led/shared-infra; CA designs/audits.

**Live test case for P2:** the CFO↔KMG brand-bible data request (it would've flowed automatically under a working mesh). **Open policy Q:** is TDB a real mesh node or a client repo? DAGDC + TDB both want addresses — possible wave of client repos wanting mesh participation = policy question bigger than agents.json rows.

**Note:** CFO's Phase 0 (schedule its own drainer, drain 10 stuck WOs, refresh its agents.json entry, fix heartbeat field) is CFO's OWN slice — self-executable, no CA action. CA starts at Phase 1 (the cross-agent spec).

3. **Check for filesystem-dropped work since session 4 wrap.** Standard intake check:
   ```bash
   cd "/Users/alex/Desktop/Code/Code Architect"
   git log --oneline -1
   git status --short
   find . -newer .git/refs/heads/main -type f \
     -not -path "./.git/*" -not -path "./node_modules/*" \
     -not -path "./.playwright-mcp/*" 2>/dev/null
   ```
   Per `project-intake-convention-docs-dated-files`: any incoming agent-authored report → save as `docs/intake-<topic>-<date>.md` BEFORE responding.

## Open decisions (priority order)

### 🚨 1. OAuth hotfix (see First 3 Moves #1)

Time-pressured. Has highest user-facing impact (Telegram alerts piling up; bot can't see Gmail/Calendar/Drive/Sheets).

### 🚨 2. Prompt-cache patch v2 application (see First 3 Moves #2)

Smallest measurable cost win. Quick once Codex v2 verdict is in.

### 📥 3a. NEW — DAGDC intake: mesh relay endpoint bypasses tier policy + audit

Filesystem-dropped 2026-05-24 ~16:30 by DAGDC. Doc at `docs/intake-mesh-relay-policy-bypass-2026-05-24.md` (~14 KB, mirrors CA A4/A6 audit format).

**Headline finding:** `/api/delegations/receive` (file `Kai Executive Assistant/scripts/routes/ecosystem.js:1299-1350`) is a 30-LOC file-writer that bypasses mesh-api tier policy, audit trail, and route_permissions table. Kai-originated WOs go through `delegation-manager.js:262-360` → mesh-api with full enforcement. Externally-relayed WOs (via `~/.kameha/shared/deliver-to-kai.js`) skip all of it.

5 findings + 3 remediation options sketched (A: promote to full mesh participant, B: rename + lock down as shim, C: hybrid) + 4 open questions for Alex + DA-gate analysis included. Severity: architectural/policy, not runtime (Enso gates intake itself; exposure is for non-Enso targets and system-of-record integrity).

**Status:** queued. Read in full and plan remediation when above items are closed. Real cross-cutting design call — not a hotfix.

### 📥 3b. NEW — CFO intake: mesh built but never operated (CONVERGES with 3a + arch audit)

Doc at `docs/intake-cfo-mesh-not-operated-2026-05-24.md`. Relayed inline by Alex 2026-05-24. CFO's three findings: (1) `process_inbox.py` drainer exists but was never scheduled in launchd — 10 WOs rotting since March; (2) `agents.json` registry missing KMG/TDB/ACD (last touched Mar 19); (3) dual transport (filesystem `~/.kameha/delegations/` + HTTP :3000/:3336), neither carrying live traffic.

**THE CONVERGENCE:** This is the 3rd independent signal this session of ONE root cause — *the mesh was built and never fully operated*. DAGDC (3a) hit the relay-bypass face of it; CFO hit the dormant-drainer + stale-registry face; CA's own audit (`architecture-current-state-2026-05-20.md`) hit the dual-transport + 22-silent-failures face. **Recommendation: consolidate CFO Phase 1 spec + DAGDC remediation + action-vocab registry into ONE mesh-operability design**, not three efforts. Kai-led / shared-infra per domain boundaries (communication is Kai's; CA designs/audits).

CFO Phase 0 (schedule its drainer, drain 10 WOs, refresh its registry entry, fix heartbeat field) is CFO's OWN slice — self-executable in CFO's repo, no CA action needed. CA's role starts at Phase 1.

**Open policy Q for Alex:** is TDB a real mesh node or a client-project repo? DAGDC + TDB both want addresses — may be a wave of client repos wanting mesh participation, which is a policy question bigger than adding agents.json rows.

### ⚙️ 3. Workflow_dispatch YAML edit (NEXT-after-OAuth)

Proposal at `docs/proposal-workflow-dispatch-deploy-yml-2026-05-19.md`. 1-line YAML add to Kai + KMG repos. **Tailscale `TAILSCALE_AUTHKEY` expired 5/22.** New keys are set on both repos but neither has `workflow_dispatch` trigger → can't manually validate deploy. Auto-deploy unverified until either a real push to main exercises the new key or `workflow_dispatch` lands. CA's draft is ready.

### 📋 4. Crew_manifest proposal — Q1-Q8 awaiting Alex's answers

Proposal at `docs/proposal-crew-manifest-2026-05-20.md`. Companion HTML at `explainers/proposal-crew-manifest-2026-05-20.html`. 8 decisions inline (Q1-Q8) + 5 strawmen for action-vocab open questions. Codex-reviewed (REVISE → corrections folded: dispatch-order prerequisite, action-scope acknowledgment, transaction guard on delete-insert, outbox fallback for mesh-send failure, Phase 1 auto-merge correction).

**Critical:** the proposal now has a hard dispatch-order prerequisite — conductor's `processMessage()` must check `CAPABILITY_HANDLERS[action]` exact-match BEFORE the generic `processActionableWorkOrder` call, OR `crew_manifest` will be silently bypassed.

### 💡 5. Universal brain — Layer 1 expansion (Architecture B chosen)

After session 4 cost analysis, **direction is committed**: extend conductor.db with new typed tables as the universal brain. crew_manifest is the pilot. Next typed tables to consider once crew_manifest ships: `decision_log` (append-only cross-agent decisions), `client_facts` (typed client constraints). Vector layer (Layer 3) is Phase 4+ per cost-design doc.

Cost economics are anchored (real numbers, not guesses): fleet API ~$30-100/mo, growing ~50%/mo. Universal brain adds $10-30/mo with smart 3-layer approach, $30-100/mo if done naively.

### 🚨 6. Mesh route reply-path silent failures (22 / 7 days)

Carry-forward from session 3. Live data confirmed in session 4 architecture audit: `nami → framer` (13 rejected/7d), `enso → nami` (5 failed), `acd → nami` (3 failed), `acd → conductor` (1 rejected — exactly the route crew_manifest needs). Design call between (a) add reverse routes, (b) auto-route correlation_id responses, (c) change agent reply mechanism.

### 🐞 7. mesh-api status field demotion bug (NEXT-SESSION #9 carry)

Live-confirmed: Chronicle appears in `stale_agents` AND has `status: "active"` in same JSON. Single-file fix in `~/kai/scripts/mesh/mesh-api.js`. Human-review on the file; CA drafts diff, Alex applies.

### 🚨 8. Lead Engine — no mesh-receive daemon (carry from session 3)

LE has only FastAPI dashboard. Mesh sends rot in `/inbox/lead-engine` until reconciler-expired. T3 plan-first item.

### 💡 9. Action-vocabulary registry Phase A (carry)

Design at `docs/design-action-vocabulary-registry-2026-05-19.md` (not authored this session — was from session 3). 5 open questions. crew_manifest answers some of them concretely. Worth a focused design session after crew_manifest ships.

### Carry-forward from earlier sessions (still pending)

- **Memorial Day manual-relay confirmation** — was intentional or accidental?
- **OA Malaga 4-file deletion triage** — restore vs commit-as-cleanup vs investigate.
- **CFO 8-commit plan execution** — plan at `docs/cfo-commit-plan-2026-05-18.md`.
- **CFO QuickBooks token expired** — re-auth needed.
- **Chronicle git lock since Mar 28** — A2 finding from overnight audit.

## Standing rules (in memory — auto-loaded each invocation)

- **Verify staging before commit** ([[feedback-verify-staging-before-commit]]).
- **Triangulate audit sources** ([[feedback-audit-triangulate-sources]]).
- **Re-verify agent-authored claims about other agents** ([[feedback-re-verify-agent-authored-claims]]).
- **Silent-failure is a class** ([[pattern-silent-failure-class-fleetwide]]).
- **Self-retraction discipline** ([[feedback-self-retraction-discipline]]).
- **`git reset --hard` destroys staged** ([[feedback-git-reset-hard-destroys-staged]]).
- **Filesystem-drop / intake convention** ([[project-filesystem-drop-interim-mailman]] + [[project-intake-convention-docs-dated-files]]).
- **Session-face HTML pattern** ([[project-session-face-html-pattern]]).
- **Codex prompts are for Codex** ([[feedback-codex-prompts-are-for-codex]]).
- **Verify scopes against code, not rotation cards** ([[feedback-verify-scopes-against-code]]) — NEW session 4.
- **Solicit Codex review on substantive work** ([[pattern-solicit-codex-review-on-substantive-work]]) — NEW session 4.

## Session 4 deliverables — uncommitted at shutdown

14 files / dirs. Substantial output. Worth getting onto GitHub early in session 5.

```
docs/architecture-current-state-2026-05-20.md
docs/codex-review-{2026-05-20,2026-05-21,2026-05-22}-*-results.md  (3 files)
docs/codex-review-prompt-{2026-05-20,2026-05-21,2026-05-22}-*.md   (3 files)
docs/design-cost-and-universal-brain-2026-05-20.md
docs/intake-kai-wo-oauth-client-deleted-2026-05-22.md
docs/patch-prompt-caching-2026-05-20/  (4 files: README, helper, 2 diffs)
docs/proposal-crew-manifest-2026-05-20.md
explainers/architecture-current-state-2026-05-20.html
explainers/kameha-agentic-system-overview.html
explainers/proposal-crew-manifest-2026-05-20.html
```

## Don't forget

- **HB#1:** never commit/push without explicit per-change go-ahead.
- **HB#2:** cross-repo writes governed by target repo's `.kameha/owners.json`. ACD `daemon.py`, all Kai `scripts/bot/**` + `scripts/mesh/**` + `scripts/routes/**` are `human_review_required` — CA drafts, Alex applies.
- **HB#3:** never `--no-verify`, `--no-gpg-sign`, `--force-with-lease`, `--force`.
- **HB#10:** invocation boundary — only run from CA's own repo dir.
- **Mac Mini probe protocol:** SSH is `kai@100.64.114.13`, available and working. Tailscale-internal mesh-api at `http://100.64.114.13:3341` (use `/stats?days=N` for traffic data, NOT `/by-route`).
- **API key arrangement:** still unknown whether per-agent keys vs shared. Worth surfacing if cost tracking becomes important.

## At session end (when Alex signals shutdown)

1. Refresh `explainers/session-latest.html` if material changes happened (session 4 deferred this — the architecture-current-state.html is more authoritative for "system state" than session-latest was)
2. Snapshot if material refresh happened
3. Write `session-YYYY-MM-DD.md` to auto-memory dir
4. Update `MEMORY.md` sessions index
5. Commit + push (HTML refresh + snapshot + session log + new NEXT-SESSION.md + any intake docs)
6. **Overwrite this `NEXT-SESSION.md` with next-session pickup**

---

Pick the priority and go. Recommended first move: **OAuth hotfix completion** (Alex's Playground step → CA SSH-write → smoke tests). Bot's been down 3 days.

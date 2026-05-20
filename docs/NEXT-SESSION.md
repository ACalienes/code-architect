# CA Next Session Pickup (session 4)

**Paste this entire file into a fresh Code Architect Claude Code session** to pick up from session 3 + day 1 follow-on (wrapped 2026-05-19 evening, 15 CA commits today + 7 PDE commits + 1 NAMI ship).

---

You are Code Architect, continuing from session 3 + a long day-1 follow-on. Full context is in your auto-memory at `memory/session-2026-05-19.md` (will be appended to with day-1 follow-on notes — read both halves). Standing rules indexed in `MEMORY.md`. This prompt is a drop-in to get oriented and pick up the queue.

## First 3 moves (do in order, before anything else)

1. **Open `explainers/session-latest.html` in your browser** (file:// works; or `python3 -m http.server 8771` and visit http://localhost:8771/explainers/session-latest.html). The top **5 yellow/orange rows** in "Decisions awaiting you" are day-1's actionable items. The very top of the file's "What today looks like" callout is your plain-English orientation.

2. **Read `docs/audit-overnight-2026-05-19.md`** for the full overnight P0/P1/P2 punch list — many items still pending. Then scan today's NEW intakes:
   - `docs/intake-nami-email-spam-2026-05-19.md` — diagnosis + Option B + shipped
   - `docs/intake-kai-workflow-dispatch-2026-05-19.md` + `docs/proposal-workflow-dispatch-deploy-yml-2026-05-19.md` — pending approval
   - `docs/intake-kai-crew-manifest-design-2026-05-19.md` — deferred to dedicated session
   - `docs/intake-pde-dental-boutique-recovery-2026-05-19.md` — data-loss incident + Option-1 recovery

3. **Check for filesystem-dropped work since session 3 day-1 wrap.** Run:
   ```bash
   git log --oneline -1     # confirm HEAD = the session-3 evening wrap commit
   git status --short        # see anything new
   find . -newer .git/refs/heads/main -type f \
     -not -path "./.git/*" -not -path "./node_modules/*" \
     -not -path "./.playwright-mcp/*"
   ```
   Per `project-filesystem-drop-interim-mailman` + `project-intake-convention-docs-dated-files`: any incoming agent-authored report → save as `docs/intake-<topic>-<date>.md` BEFORE responding.

## Open decisions (priority order)

### ⚙️ 1. Kai workflow_dispatch deploy.yml — drafted, awaiting your go-ahead

Proposal at `docs/proposal-workflow-dispatch-deploy-yml-2026-05-19.md`. 1-line YAML add to each of two repos (Kai + KMG). KMG side blocks on KMG owners.json bootstrap (also drafted as part of the same proposal). DA-passed. Not time-pressured (old Tailscale key valid through 2026-05-22), but cleanest validation path. 8-question approval matrix in the proposal.

### 🎬 2. Kai crew_manifest design — INTAKE QUEUED for a deep-work session

Triggered by Baptist 5/21 shoot 2nd-camera staffing gap (T-2 days catch by Alex). Kai asked CA to design a structured `crew_manifest` contract as the first concrete typed deliverable in the action-vocabulary registry. Intake at `docs/intake-kai-crew-manifest-design-2026-05-19.md` includes the 8-section ask. **This is a substantial design artifact** — needs a fresh dedicated session, not a tail-end of an already-long one. Kai is covering the gap via a feedback memory in the meantime.

### 🚨 3. Two mesh routes — refined diagnosis (reply-path, not request-path)

`nami → framer schedule_post_response` (5× rejected/24h) and `acd → conductor creative_brief` (1×) — these are message_type="response" replies that the routing system rejects because no reverse route is registered. Fix is a design call between (a) add reverse routes (b) auto-route correlation_id responses (c) change agent reply mechanism. Full analysis in audit doc P0-1 refinement.

### 🚨 4. PDE silent `build_update` — confirmed but ZERO traffic in 7 days

Demoted from P0-urgency to backlog. The bug is real (`scripts/pde-daemon.js:684` dispatch only matches `build_addendum`, falls through to PATCH status=completed). But no sender is exercising it. Fix when the action-vocabulary registry lands as part of the systemic answer; per-agent patches are YAGNI for now.

### 🚨 5. Lead Engine — no mesh-receive daemon at all

T3 plan-first item. LE has only a FastAPI dashboard. Mesh sends rot in `/inbox/lead-engine` until reconciler-expired. Needs design (FastAPI add-on vs separate process) + DA gate. Defer to a dedicated LE-design session.

### 💡 6. Action-vocabulary registry Phase A — 5 open questions

Design at `docs/design-action-vocabulary-registry-2026-05-19.md`. With the crew_manifest intake (#2 above) now queued, the 5 open questions get sharpened against a real cross-agent typed deliverable. Likely better to answer them as part of the crew_manifest session — they become concrete.

### 🔓 7. Owners.json gitignore-policy proposal

`docs/proposal-owners-policy-gitignore-2026-05-19.md`. 1-min y/n decision. Approving unblocks fleet-wide `.gitignore` hygiene under `auto_merge_after:ca_internal_da`.

### 🚨 8. Chronicle — git locked since Mar 28 + dead PM2 daemon

A2 found `refs/heads/main.lock` from 2026-03-28 (dead PID) blocking all git ops — that's why 27 /log entries are uncommitted. Fix is mechanical (Alex hands): `rm .git/refs/heads/main.lock` → `git fsck` → commit entries → `ssh kai@10.0.0.79 pm2 restart chronicle`. ~10 min total. Documented in `docs/morning-actions-2026-05-19.md`.

### 🐞 9. mesh-api `status` field never demotes on heartbeat staleness

A1 systemic find. Chronicle is simultaneously `status="active"` AND in the `stale_agents` array. Single-source-of-truth silently lies. Kai `scripts/mesh/mesh-api.js` patch — human_review_required.

### ⚙️ 10. Conductor fuzzy-fallback misroutes (A6 P1 promoted)

`Kai Executive Assistant/scripts/conductor-agent.js:425-431` substring-matches → wrong handler runs. Single-file fix in Kai (scripts/conductor-agent.js — not under scripts/mesh/, so check policy carve-out).

### Carry-forward from earlier sessions (still pending Alex)

- **Memorial Day manual-relay confirmation** — was the hand-relay intentional human-in-loop or accidental gap? Drives priority on retrospective tooling.
- **OA Malaga 4-file deletion triage** — restore vs commit-as-cleanup vs investigate.
- **CFO 8-commit plan execution** — plan at `docs/cfo-commit-plan-2026-05-18.md`.
- **CFO QuickBooks token expired** — re-auth needed; 10 pending WOs queued.

## Standing rules (in memory — auto-loaded each invocation)

- **Verify staging before commit** ([[feedback-verify-staging-before-commit]]). Surgical `git add <specific-file>` only. Unaccounted-for staged files = STOP.
- **Triangulate audit sources** ([[feedback-audit-triangulate-sources]]). Static manifests + runtime registry + mesh-api + actual code. All four before classifying.
- **Re-verify agent-authored claims about other agents** ([[feedback-re-verify-agent-authored-claims]]). Senders are unreliable narrators about receivers. Subagent findings also need re-verification (caught A6's wrong PDE path today).
- **Silent-failure is a class, not instances** ([[pattern-silent-failure-class-fleetwide]]). PDE, LE, ACD, mesh-route reply-path — all variations. Systemic fix is the action-vocab registry.
- **Self-retraction discipline** ([[feedback-self-retraction-discipline]]). When triangulation overturns a prior conclusion, name the retraction explicitly. Don't silently correct.
- **`git reset --hard` destroys staged-but-uncommitted files** ([[feedback-git-reset-hard-destroys-staged]]) — NEW today. NEVER use `--hard` when there's staged content not yet committed. Use `git stash` first, or `--mixed`/`--soft`. Cost dental-boutique-decision today.
- **Filesystem-drop / intake convention** ([[project-filesystem-drop-interim-mailman]] + [[project-intake-convention-docs-dated-files]]). Save incoming agent reports as `docs/intake-<topic>-<date>.md` BEFORE responding.
- **Session-face HTML pattern** ([[project-session-face-html-pattern]]). Refresh on material changes; commit + snapshot at session end.
- **Codex prompts are for Codex** ([[feedback-codex-prompts-are-for-codex]]). "# Codex prompt — ..." headers go to Kai memory, not execute against own state.

## CA authority coverage (day 1 wrap state)

9 of 12 repos bootstrap'd:

| Repo | SHA | Paths | owners.json |
|---|---|---|---|
| CFO | `8019706` | 21 | ✅ |
| Kai | `52dd126e` | 24 | ✅ |
| Nami | `055b551` | 21 | ✅ |
| ACD | `bcce5d5` | 30 | ✅ |
| Framer | `0a4d322` | 51 | ✅ on main; not in laptop's current feature-branch checkout |
| Enso | `9935ec5` | 63 | ✅ |
| Offer Architect | `5a32a99` | 24 | ✅ |
| Lead Engine | `6f525ff` | 45 | ✅ |
| Code Architect | `0964563` | 24 | ✅ |
| **Pitch Deck Engine** | **`de8abb2`** | **23** | ✅ **NEW today** |
| conductor | (inherited via Kai) | — | ✅ |
| Chronicle | — | — | ❌ MISSING |
| KMG | — | — | ❌ MISSING (W2 ship still pending; bootstrap drafted in workflow_dispatch proposal) |

**Action:** for next session, KMG bootstrap is the small unblocker for workflow_dispatch shipping. Chronicle is blocked on the git lock removal (Alex hands).

## Don't forget

- The session-face HTML IS Alex's nervous system. State changes → refresh. End of session → snapshot + commit + new NEXT-SESSION.md.
- Alex is a non-coder principal. Plain English in body text; commit messages aren't his interface. The HTML is.
- **HB#1:** never commit/push without explicit per-change go-ahead. Even with broad "execution" authority granted overnight, each commit traces to a stated authorization for its class. **Default: draft-only.**
- **HB#2:** cross-repo writes governed by target repo's `.kameha/owners.json`. 2 repos still missing — Chronicle + KMG.
- **HB#3:** never `--no-verify`, `--no-gpg-sign`, `--force-with-lease`, `--force`. Today proved why: the impeccable hook hang triggered a misuse of `--hard` that caused real data loss. The discipline isn't theoretical.
- **HB#7:** never edit methodology.md without re-distill.
- **HB#10:** invocation boundary — only run from CA's own repo dir.
- Playwright available (`mcp__playwright__browser_*`). Verify HTML changes before declaring done.
- Use `Agent` tool with `general-purpose` subagent_type + `run_in_background: true` for long-running independent investigations. 7+ in parallel works (proven session 3 overnight). **Today proved this works for emergency recovery too** — the dental-boutique-decision JSONL extraction agent reconstructed 9 files autonomously.

## At session end (when Alex signals shutdown)

1. Final HTML refresh (footer SHAs, decisions count, "session N wrapped")
2. Snapshot `session-latest.html` → `state-of-things-YYYY-MM-DD[-suffix].html`
3. Write `session-YYYY-MM-DD.md` to auto-memory dir (append if same date)
4. Update auto-memory `MEMORY.md` sessions index
5. Commit + push (HTML refresh + snapshot + session log + new NEXT-SESSION.md + any intake docs)
6. **Overwrite this `NEXT-SESSION.md` with next-session pickup for session N+1**

---

Pick the priority and go. Recommended first item: **#1 workflow_dispatch approval** (quick decision, time-aware due to 2026-05-22 old-key expiry) followed by **#2 crew_manifest design** (deep-work session, sharpens the action-vocab registry conversation).

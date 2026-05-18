# Uncommitted Work Triage — 2026-05-17

Read-only T1 audit across the 9 Kameha-fleet repos with substantial dirty state.
Goal: classify which uncommitted work is active in-flight (safe to leave),
which is generated noise (should be gitignored), which is accumulated risk
(needs a commit checkpoint).

## Summary by risk

| Risk | Repos | Action |
|------|-------|--------|
| **HIGH** — multi-week commit gap with real feature work accumulating | Chronicle (7w), CFO (4w) | Recommend dedicated commit-checkpoint session per repo |
| **MEDIUM** — feature branch nearing completion with large untracked count | Framer (96 files on `carousel/phase-2a-planner`) | Focused Framer session to clean up + land the branch |
| **MEDIUM** — noise artifacts that should be `.gitignore`d | Nami (20 PNG screenshots), Chronicle (`.next/trace` build outputs), Pitch-deck (`screenshots/`) | Add per-repo `.gitignore` rules |
| **LOW** — normal in-flight from active sessions | Kai (committing every ~20 min), Nami code | Leave alone, will resolve naturally |
| **LOW** — active work, recent commits, healthy pace | DAGDC, KMG, Enso, Pitch-deck | No action |

## Per-repo detail

### HIGH-RISK · Chronicle (16 modified + 11 untracked)
- **Last commit:** 7 weeks ago (`7f8cad3` — "feat: contextual photo upload + workout plan management on /log page")
- **What's dirty:** substantial /log page feature work — `dashboard/app/log/page.tsx`, `dashboard/components/input/QuickLogSheet.tsx`, `dashboard/components/log/UploadWorkoutPlan.tsx`, `dashboard/components/log/WorkoutLogger.tsx`, plus API route additions in `src/api/routes/sessions.ts`. Plus `.next/trace` and `.next/trace-build` build artifacts.
- **Classification:** Active feature work + build noise.
- **Risk:** 7 weeks is the largest commit gap in the fleet. If Mac Mini dies or the dir gets corrupted, that's 7 weeks of feature work to reconstruct from memory.
- **Recommended action:** Dedicated Chronicle session — commit the feature work as 1-2 logical commits, gitignore the `.next/` build outputs.

### HIGH-RISK · CFO (12 modified + 16 untracked)
- **Last commit:** 4 weeks ago (`2953446` — "feat(invoices): pass through AllowOnline* payment flags")
- **What's dirty:** Substantial new feature work — `scripts/alerts/financial_monitor.py` (new, +77), `scripts/alerts/send_alerts.py`, `scripts/calc/burn_rate.py` (+111), `scripts/calc/tax_threshold_monitor.py` (+90), `scripts/daily_snapshot.py` (+139), `scripts/dashboard/app.py` (+190 new). Plus a logs/cfo-activity.json churn of **7,350 lines** (daily log file — should probably be gitignored, not committed).
- **Classification:** Major in-flight build (alerts pipeline + dashboard) + log file noise.
- **Risk:** 4 weeks of substantial feature work. The activity log file churn (7350 lines) suggests it's been being committed historically — bad pattern; logs shouldn't be in git.
- **Recommended action:** Dedicated CFO session — commit the alerts + dashboard features as logical commits, add `logs/cfo-activity.json` to `.gitignore` and `git rm --cached` it.

### MEDIUM-RISK · Framer (96 untracked, 0 modified)
- **Branch:** `carousel/phase-2a-planner` (feature branch, not main)
- **Last commit:** 6 days ago (`2a60a1b` — "fix(mesh): align message_id...")
- **What's dirty:** 91 untracked files in `scripts/`, 2 in `knowledge/`, 1 each in `assets/`, `.playwright-mcp/`, `.claude/`
- **Classification:** Active feature work in flight on a feature branch — building the carousel phase 2a planner.
- **Risk:** Lower than CFO/Chronicle because it's a feature branch (not main), but 96 untracked files in 6 days suggests the branch is approaching completion and needs landing. Also: `.playwright-mcp/` should be gitignored per repo policy.
- **Recommended action:** Focused Framer session to commit logical groupings, decide on branch landing, add `.playwright-mcp/` to `.gitignore`.

### MEDIUM-RISK · Nami (20 untracked, 0 modified)
- **Last commit:** 24 hours ago (`af43891` — "fix(publish-page): render video media correctly + per-slide download button")
- **What's dirty:** 20 PNG screenshots — `review-portal-stairs-modal.png`, `feed-l4.png`, `feed-fixed.png`, `feed-blackspace.png`, etc.
- **Classification:** Visual artifacts from playwright/screenshot review sessions. Probably not intended for git.
- **Recommended action:** Add `*.png` (or specific pattern) to `.gitignore`. Move kept reference screenshots to a dedicated `screenshots/` dir.

### MEDIUM-RISK · Kameha Pitch Deck Engine (3 modified, 19 untracked)
- **Last commit:** 10 days ago
- **What's dirty:** Modified `CLAUDE.md` (+43), `builds/jmm-law/.gitignore`, `package.json`. Untracked includes `builds/` (9 — likely per-client deck builds), `screenshots/` (1), `.claude/` (2), etc.
- **Classification:** Build artifacts from per-client deck builds + small CLAUDE.md doc update.
- **Recommended action:** Commit the CLAUDE.md update separately. Consider gitignoring `builds/<client>/` artifacts (kept locally, not version-controlled — most pitch deck final assets shouldn't be in git anyway).

### LOW-RISK · Kai Executive Assistant (4 modified, 30 untracked)
- **Last commit:** 21 minutes ago (`29194ac1` — "chore(memory): commit Codex CA W3 review prompt history")
- **What's dirty:** 29 of 30 untracked in `memory/` — that's session logs and memory cards being produced by the live Kai session right now. 4 modified: `clients.md` (+12, TDB add), `kmg_migration_watchdog` (+62), `mesh-poller.js` (+60), `kmg_missing_content_inventory` (+4).
- **Classification:** Active in-flight work from the live concurrent Kai session.
- **Action:** Leave alone. The Kai session is committing every ~20 min; this is normal working state.

### LOW-RISK · DAGDC (16 modified, 11 untracked, 4 added)
- **Last commit:** 7 days ago
- **What's dirty:** 14 in `dashboard/` (Next.js page edits — Dan client dashboard), 8 in `client/` (action items + asks + dashboard quotes), 4 in `ops/`, 3 in `memory/`.
- **Classification:** Active client-engagement work for Dan/DAG Construction.
- **Action:** Normal in-flight; will commit on Alex's regular DAGDC session cycle.

### LOW-RISK · KMG (6 modified, 10 untracked)
- **Last commit:** 5 days ago (`6987655` — "feat(kmg): batch 1 bible-fill — 5 propose_bible_edit drafts...")
- **What's dirty:** `STRATEGIC-FOUNDATION.md` (+12), `knowledge/integration-website.md` (+56), `memory/decisions-log/2026-05.jsonl`, `references/strategy-docs/README.md`, `references/website-build/README.md` (+50), `scripts/lib/claude-client.js` (+4). Plus 10 untracked in `references/`.
- **Classification:** Active strategy + integration work continuing the bible-fill batch pattern.
- **Action:** Normal in-flight; commit on next KMG session.

### LOW-RISK · Enso-The-Editor (3 modified, 39 untracked)
- **Last commit:** 10 days ago (`0743f56` — "feat(mesh): cluster B step 2 — work-heartbeat sender for Enso (Python)")
- **What's dirty:** 3 modified: `enso-learning-log.json` (+106), `scripts/lib/mesh_client.py` (+35), `workflows/podcast/rules.md` (+188). 39 untracked spread across `projects/` (10), `workflows/` (6), `scripts/` (5), `enso-captions/` (4), `docs/` (4), etc.
- **Classification:** Mix of active work (workflows + learning log) and per-project artifacts. The 10 `projects/` entries are likely per-client project files that may or may not belong in git.
- **Action:** Worth an Enso session to commit the workflow/mesh improvements and decide policy on `projects/` artifacts.

## Common gitignore opportunities

Across multiple repos, similar artifacts should be gitignored:
- `.playwright-mcp/` (CA, Framer) — playwright screenshot/log artifacts
- `.next/trace*` (Chronicle) — Next.js build artifacts
- `*.png` in repo root (Nami, CA) — ad-hoc screenshots
- `logs/*.json` (CFO) — daily activity logs that churn 7000+ lines/day

A fleet-wide pattern would be a shared `.gitignore.kameha` template that each repo imports. Useful future CA task; out of scope here.

## Recommended next steps (by leverage)

1. **Address Chronicle and CFO commit gaps** — dedicated commit-checkpoint sessions for each. Risk is real if those repos lose state (Mac Mini failure, dir corruption). 7 weeks and 4 weeks of feature work shouldn't sit uncommitted.
2. **Land Framer's carousel branch** — 96 untracked files in 6 days means the branch is ripe for landing or for explicit "park-and-document" decision.
3. **Apply gitignore patterns** to reduce noise across Nami, Chronicle, CFO, Framer, CA.
4. **Leave the rest in current cycle** — Kai is healthy, DAGDC/KMG/Enso/Pitch-deck have active sessions handling their pace.

## Mystery file note (from this session)

The commit immediately preceding this triage (`e90018a`) bundled two unaccounted-for
files: `scripts/lib/run-ledger.js` (674 lines) + `test/run-ledger.test.js` (587 lines).
Real W4 implementation, tests pass, but I did not author them and Alex couldn't confirm
having spawned a session that did. Saved as `feedback-verify-staging-before-commit`
behavior memory so future CA verifies staging state before commit. Files retained
per Alex's call; origin remains unexplained.

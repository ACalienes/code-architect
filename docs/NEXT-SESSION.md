# CA Next Session Pickup

**Paste this entire file into a fresh Code Architect Claude Code session** to pick up from session 1 (wrapped 2026-05-17 ~00:05 ET, 9 commits, HEAD `13b648b`).

---

You are Code Architect, continuing from session 1. Full session 1 context is in your auto-memory at `memory/session-2026-05-17.md`. Standing rules are indexed in `MEMORY.md`. This prompt is a drop-in to get oriented and pick up the queue.

## First 3 moves (do in order, before anything else)

1. **Open `explainers/session-latest.html` in your browser** (file:// works; or spin up `python3 -m http.server 8771` and visit http://localhost:8771/explainers/session-latest.html). That's the CTO dashboard — the single source of truth for what's in CA's queue. Read it before responding to anything else.

2. **Check for filesystem-dropped work since session 1 wrap.** Run:
   ```bash
   git log --oneline -1     # confirm HEAD = 13b648b (session 1 wrap commit)
   git status --short        # see anything new in working tree
   find . -newer .git/refs/heads/main -type f \
     -not -path "./.git/*" -not -path "./node_modules/*" \
     -not -path "./.playwright-mcp/*"
   ```
   Per `project-filesystem-drop-interim-mailman` memory: Kai subagents and ACD have been dropping files directly into CA's repo because mesh-API has no enforced CA routes. **Any unauthored file = investigate provenance via the originating agent's activity log BEFORE committing.** Attribute origin in the commit message body.

3. **Read `memory/session-2026-05-17.md`** in your auto-memory dir for full session 1 narrative. The dashboard is the queue view; the session log is the story.

## Open decisions (priority order — pick based on Alex's energy + the situation)

1. **Chronicle + CFO commit-gap checkpoint** (HIGH-RISK · *Alex's action, not yours*)
   - Chronicle: 7 weeks of uncommitted `/log` feature work
   - CFO: 4 weeks of uncommitted alerts pipeline + dashboard, plus `logs/cfo-activity.json` churning 7,350 lines/day in git history (anti-pattern)
   - Recovery risk if Mac Mini dies. Triage at `docs/uncommitted-triage-2026-05-17.md`.
   - CA's role: remind, don't author.

2. **Authorize `.kameha/owners.json` bootstrap for Kai's repo** (HB#2 gate)
   - Without it, CA can't author any cross-repo write. Pre-approvable per HB#2 carveout.
   - Draft path: produce in CA's `test-fixtures/kai-owners.json` for Alex's review, Alex copies + commits in Kai's repo. ~30 min.
   - Unblocks every other audit-fix item.

3. **Continue W4 run-ledger build**
   - Kai-subagent dropped `scripts/lib/run-ledger.js` + `test/run-ledger.test.js` at session 1 (commit `e90018a`). 72/72 tests pass.
   - Per `design_ca_phase2_w4_2026-05-16.md` (in Kai's memory): next pieces are registry, manifest-validator, CLI wiring, pre-push hooks, drift cron, owners/contracts.
   - ~12 sessions estimated total. Session #2 scope: pick one piece, design + implement + test.

4. **Cross-fleet `.gitignore` cleanup** (~25 min)
   - `.playwright-mcp/` (CA + Framer), `.next/trace*` (Chronicle), `*.png` at root (Nami + CA), `logs/*.json` daily churn (CFO)
   - Future CA task could template a shared `.gitignore.kameha` import.

5. **ACD-Nami fix** (W5/W6 scope, NOT urgent)
   - Per `docs/acd-nami-action-contract-mismatch-2026-05-17.md`:
     - Build action-vocabulary registry so senders can verify recipient acceptance pre-send
     - Build silent-failure detection: `send_and_verify()` helper + per-heartbeat `recent_failed_sends` summary
   - Real engineering work; gate after W4 ships.

## Standing rules from session 1 (all in your memory)

- **Verify staging before commit.** `git status` + `git diff --cached --stat` BEFORE every `git add` AND before every commit. Unaccounted-for staged files = STOP. → `feedback-verify-staging-before-commit`
- **Triangulate audit sources.** Static manifests + runtime registry + mesh.db agents table + filesystem code presence. All four before classifying any agent missing/stale/unreal. → `feedback-audit-triangulate-sources`
- **Filesystem-drop pattern is active.** Check for unauthored files at session start. → `project-filesystem-drop-interim-mailman`
- **Session-face refresh on every material state change.** Local file update only, no per-refresh commit. End-of-session: snapshot + commit both. → `project-session-face-html-pattern`
- **Codex prompt headers ≠ work for me.** "# Codex prompt — ..." pastes go to Kai memory for the VS Code plugin, not execute against own state. → `feedback-codex-prompts-are-for-codex`

## Don't forget

- The session-face HTML IS Alex's nervous system. If you change state, refresh it. If you forget, you've hidden the change.
- Alex is a non-coder principal. Plain English in brief-me expanders; commit messages aren't his interface. The HTML is.
- **HB#1:** never commit/push without explicit per-change go-ahead.
- **HB#2:** cross-repo writes fail closed until `.kameha/owners.json` exists in target repos.
- **HB#10:** invocation boundary — only run from CA's own repo dir.
- Playwright is available (`mcp__playwright__browser_navigate`, `_take_screenshot`, `_resize`). Use it to verify HTML changes before declaring done. v1 shipped without playwright check and ate a rebuild.

## At session end (when Alex signals shutdown)

1. Final HTML refresh (footer hash, decisions count, "session N wrapped")
2. Snapshot `session-latest.html` → `state-of-things-YYYY-MM-DD.html`
3. Write `session-YYYY-MM-DD.md` to auto-memory dir
4. Update auto-memory `MEMORY.md` sessions index
5. Commit + push (HTML refresh + snapshot + session log if in repo)
6. **Overwrite this `NEXT-SESSION.md` with next-session pickup for session N+1**

---

Pick the priority and go.

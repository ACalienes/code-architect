# Intake — Audit A2: Repo Hygiene Snapshot

**Date:** 2026-05-19
**Author:** Code Architect (overnight audit, read-only)
**Scope:** 12 Kameha mesh repos under `/Users/alex/Desktop/Code/`
**Method:** Read-only `git log`, `git status --short`, `find .git -name '*.lock'`, `du -sh`. No file edits outside this doc.

---

## 1. Summary Table

| Repo | HEAD age (days) | Uncommitted entries | Stale `.git/*.lock` | `owners.json` (patterns) | Disk total | 7d commits |
|---|---:|---:|---:|---|---:|---:|
| ACD | 1 (2026-05-18) | 10 | 0 | yes (30) | 1.7M | 1 |
| CFO | 1 (2026-05-18) | 26 | 0 | yes (21) | 16M | 2 |
| Chronicle | **51 (2026-03-29)** | 27 | **1** (Mar 28) | **NONE** | 265M | 0 |
| Code Architect (self) | 1 (2026-05-18) | 6* | 0 | **NONE** | 13M | 13 |
| Enso-The-Editor | 1 (2026-05-18) | 42 | **3** (May 7) | yes (63) | **8.3G** | 1 |
| Framer | 1 (2026-05-18) | 116 | 0 | **NONE** | 554M | 1 |
| Kai Executive Assistant | 0 (2026-05-18) | 34 | 0 | yes (24) | 1.1G | **117** |
| Kameha Lead Engine | 1 (2026-05-18) | 5 | 0 | yes (45) | 582M | 1 |
| Kameha Media Group | 7 (2026-05-12) | 16 | 0 | **NONE** | 638M | 1 |
| Nami Social Media Coordinator | 0 (2026-05-18) | 20 | 0 | yes (21) | 107M | 14 |
| Offer Architect | 1 (2026-05-18) | 9 | 0 | yes (24) | 70M | 1 |
| Kameha Pitch Deck Engine | **12 (2026-05-07)** | 22 | 0 | **NONE** | **806M** | 1 |

*Code Architect status was `11` at initial scan; dropped to `6` after parallel audit-agent runs wrote their docs (A1/A3/A4/A5/A7 .md files now committed by sibling agents). Live count at write-time: 6 untracked intake docs (all today's audit output, expected).

`*` = author-confirmed special concern from intake prompt.

---

## 2. Findings (P0 → P2)

### P0 — High-risk / data-loss

**P0-1. Chronicle: 51-day stale HEAD with 27 uncommitted entries (CONFIRMED 7-week intake claim).**
- HEAD `7f8cad3 feat: contextual photo upload + workout plan management on /log page` dated **2026-03-29**.
- 16 modified files + 11 untracked, including: `dashboard/app/log/page.tsx`, `dashboard/components/log/UploadWorkoutPlan.tsx`, `dashboard/components/log/WorkoutLogger.tsx`, `src/services/ai/parser.ts`, `src/services/ai/prompts/prescription.ts`, `src/services/workoutSession.ts`, `src/telegram/handlers/photo.ts`. Plus a new `dashboard/app/log/[sessionId]/review/` directory and `ReviewWorkout.tsx`.
- Also includes likely garbage: `.next/trace`, `.next/trace-build` (modified — Next.js trace files should be gitignored), `"src/api/routes/analytics 2.ts"` (Finder duplicate via " 2" suffix), `test-router.mjs` / `test-routes.mjs` / `test-start.mjs` (loose root-level scripts).
- **No `.kameha/owners.json`** — CA cannot bypass-edit. Needs owners.json bootstrap before CA can touch any file.

**P0-2. Chronicle: stale ref lock from Mar 28, 2026 (~52 days old).**
- `/Users/alex/Desktop/Code/Chronicle/.git/refs/heads/main.lock` mtime `Mar 28 22:08`, size 41 bytes (probably contains a SHA from an aborted update).
- No live process. Stale per CA rule (>1h + no pid). Removing this lock is required before any commit/push lands on main.
- Hypothesis: aborted `git push` / `git update-ref` on Mar 28 left it behind. Has prevented all subsequent commits — explains the 51-day HEAD age. **Single root cause: clean this lock and Chronicle can resume.**

**P0-3. Offer Architect: 4 deleted-unstaged files in Malaga client dir (CONFIRMED intake claim).**
- `docs/clients/christian-rodriguez-malaga/EMAIL_TO_CHRISTIAN.md` (D)
- `docs/clients/christian-rodriguez-malaga/KAMEHA_SERVICES_AGREEMENT_v1.md` (D)
- `docs/clients/christian-rodriguez-malaga/MALAGA_SOW.md` (D)
- `docs/clients/christian-rodriguez-malaga/MALAGA_SOW_v2.md` (D)
- Deletion is not staged — files are gone from working tree but still tracked. Either: (a) intentional purge that needs `git rm` + commit, or (b) accidental `rm` that needs `git restore`. **Cannot tell intent from status alone — needs Alex go-ahead.** Suggest checking with Christian first to confirm Malaga engagement status.

### P1 — Blockers

**P1-1. Enso-The-Editor: 8.3GB repo, 7.7GB in `projects/` and 403MB in `outputs/`.**
- Largest repo on disk by 8x. Likely contains raw video media, render outputs, frame extracts.
- Owners.json exists (63 patterns) — first verify whether `projects/**` and `outputs/**` are owner-only or in .gitignore before suggesting a purge. If they ARE tracked, this is a long-term Git LFS / external-storage candidate.
- 3 stale stash locks (P2, separate).

**P1-2. Repos missing `.kameha/owners.json` (5 of 12) — CA cannot bypass-edit any of these.**
- Chronicle, Code Architect (self), Framer, Kameha Media Group, Kameha Pitch Deck Engine.
- Per CA Hard Boundary #2: fail-closed in any repo without owners.json except for an "explicit owners-bootstrap or migration task pre-approved by Alex." Bootstrapping the 5 missing files is itself a P1 prerequisite for ALL future cross-repo CA work. (Note: 7 drafts already exist in CA's recent commits per intake — confirm whether these are the targets.)

**P1-3. Framer: 116 untracked entries — overwhelmingly one-off ad-hoc build/render scripts.**
- ~85+ files matching `scripts/build_dag_*`, `scripts/build_l*`, `scripts/dag_memorial_day_*`, `scripts/ps_*.jsx`, `scripts/saenchai_*`, `scripts/send_dag_*_to_nami.py`, plus `scripts/l4_*`, `scripts/l46_*`, `scripts/l16_*`, `scripts/l43_*`.
- Pattern: each campaign produces a one-shot script that's never committed, never re-used, never deleted. Plus `.playwright-mcp/`, root-level JPEGs (`T1-native.jpeg`, `typography-review-native.jpeg`), and 6 carousel `assets/` dirs.
- Risk: not data-loss (these are derivatives), but is masking signal — any *real* uncommitted work is buried. **No `.kameha/owners.json`** means CA cannot mechanically sweep.

**P1-4. Kameha Pitch Deck Engine: 12-day HEAD age + 806MB + no owners.json.**
- HEAD `afe9554 feat(mesh): cluster B step 2 — work-heartbeat sender for pitch-deck` dated 2026-05-07.
- 22 untracked entries including 6 new client `builds/` dirs (dag-questionnaire, dag-social-strategy, dental-boutique-decision, malaga-townhomes, restoration-medics, smiles-and-sonrisas), new `packages/analytics/`, `packages/dashboard/`, `supabase/`, `screenshots/`. These are real new client work, not detritus.
- 702MB in `builds/`, 65MB in `screenshots/` — likely client deck outputs that should be either committed or gitignored explicitly.
- HEAD age + scope of uncommitted work + no owners.json = serious risk if drive fails.

### P2 — Cleanup

**P2-1. Enso-The-Editor: 3 stale stash locks.**
- `/Users/alex/Desktop/Code/Enso-The-Editor/.git/index.stash.{66066,66493,66789}.lock` — all 0 bytes, mtime May 7 23:16-23:22, ~12 days old. PIDs dead. Safe to delete.

**P2-2. Kai Executive Assistant: 117 commits in 7 days but 34 uncommitted entries.**
- Highest-velocity repo in the mesh; the uncommitted count is the steady-state working delta, not stale work. 18 of the 34 are `memory/*.md` (planning docs / session logs / WOs) — author-pending, not stale. Only 4 are `M` (modified): `knowledge/clients.md`, two project memory files, and `scripts/bot/crons/mesh-poller.js`. Last one (mesh-poller cron edit) is the only operational change worth attention; rest are documentation drift Alex will roll into the next session commit.

**P2-3. CFO: 26 uncommitted entries, mostly new alerting/QB scripts.**
- 10 modified Python scripts in `scripts/alerts/`, `scripts/calc/`, `scripts/dashboard/` — author is mid-feature. New `scripts/nudges/`, `scripts/tests/`, `logs/closes/`, `logs/drafts/`, `logs/nudges-history.jsonl`. The `logs/` entries suggest gitignore is missing entries for runtime log output. Not stale (HEAD is 1 day old), just untidy.

**P2-4. CFO: `docs/shared/outbox-cfo.json` modified.**
- This is a mesh outbox file — likely transient routing state that should not be tracked at all. Re-evaluate whether to gitignore.

**P2-5. Nami Social Media Coordinator: 18 stray PNGs at repo root.**
- `admin-*.png`, `client-*.png`, `feed-*.png`, `review-portal-*.png` — appear to be Playwright screenshots from review-portal QA. Plus `.playwright-mcp/` dir. Owners.json present (21 patterns). Suggest adding root-level `*.png` and `.playwright-mcp/` to gitignore.

**P2-6. Kameha Media Group: 638MB total, 546MB in `references/`.**
- 1 commit in last 7 days; HEAD 2026-05-12 (7 days). Status shows 16 entries including new `references/brand-guidelines/`, `references/brand-thinking/`, `references/voice-language/`. These are reference-doc dumps — verify they belong in-repo vs in Drive before committing.
- **No `.kameha/owners.json`** — see P1-2.

**P2-7. Code Architect (self): 6 untracked intake docs at write-time.**
- All today's audit output (A1, A2 [this doc], A3, A4, A5, A7) + a design doc (`design-action-vocabulary-registry-2026-05-19.md`). Expected — written by tonight's overnight audit agents. Will be committed as the audit batch.
- Prior session's PNGs (`session-face-*.png`, `session2-*.png`) and `.playwright-mcp/` exist on disk but are **already gitignored** per `/Users/alex/Desktop/Code/Code Architect/.gitignore` — no cleanup needed.
- **No `.kameha/owners.json`** — see P1-2. (CA repo is itself missing its own owners.json. Bootstrap is in the 7 drafts referenced in recent commits.)

---

## 3. Quick-win list (CA can fix mechanically tonight, under owners.json policy)

CA's hard rule: only act on repos where owners.json grants `bypass_eligible: true` for the affected pattern AND only on mechanical-refactor class changes (gitignore, lock cleanup, mass file delete of derivatives) AND only with explicit Alex go-ahead per change.

The following are **candidate** quick-wins. Each still needs Alex go-ahead before commit:

1. **Chronicle: rm `.git/refs/heads/main.lock`** (PID dead, file 52 days stale). This unblocks all subsequent Chronicle work but cannot be CA-mechanized — Chronicle has no owners.json. **Manual operator action.**
2. **Enso-The-Editor: rm 3 stale `.git/index.stash.*.lock` files** (PIDs dead, May 7). Pattern `.git/**` is not user-tracked; safe. Owners.json exists; check policy for `.git/**` (typically out-of-scope of owners.json since it's git internals). **Manual operator action — fastest path.**
3. **Nami: add `*.png` and `.playwright-mcp/` to `.gitignore` and `git rm --cached` the 18 stray PNGs.** Owners.json exists (21 patterns); check whether `.gitignore` pattern grants bypass. Likely a P2 sweep but needs policy verification.
4. **CFO: gitignore `logs/nudges-history.jsonl`, `logs/closes/**`, `logs/drafts/**`** if those are runtime outputs (verify with Alex). Owners.json exists.
5. **Kameha Pitch Deck Engine: gitignore `.playwright-mcp/`** at minimum. No owners.json — needs bootstrap first.

**Not quick-wins (need design decisions, not mechanical fixes):**
- Chronicle's 51-day uncommitted /log feature — needs review of whether to commit-as-is, rebase, or salvage piecemeal. Alex decision.
- Framer's 85+ one-off scripts — strategy question (purge? archive? convert to skill? sweep into `experiments/`?). Alex decision.
- Enso's 7.7GB `projects/` — storage strategy. Alex decision.
- OA Malaga deletions — needs Alex/Christian confirmation before `git rm` or `git restore`.
- Pitch Deck Engine's 6 new client `builds/` dirs — these are real new client work; committing is correct, but they need owners.json + a per-build commit per client. Alex sequencing decision.
- **5 repos missing `.kameha/owners.json`** (Chronicle, CA-self, Framer, KMG, Pitch Deck Engine) — bootstrap is a T2 design step, not a mechanical sweep. Use the 7 drafts referenced in CA's session-2-wrap commit.

---

## 4. Cross-cutting observations

- **Stale-lock detection rule works.** 4 of 4 stale `.lock` files surfaced by the `mmin +60` filter had dead PIDs and were safe candidates. Detection-only (no removal) per read-only rule. Worth promoting to a `code-architect doctor` subcommand later.
- **Owners.json coverage is 7/12 = 58%.** Below the "fail-closed everywhere" threshold the methodology assumes. CA is currently blocked from mechanical cleanup on 5 repos including its own. Bootstrap sequence is the gating item for tonight's audit translating into mechanical follow-up.
- **`.next/trace` modifications in Chronicle** suggest `.gitignore` was set up before Next.js trace files were a concern. Cross-check whether other Next.js repos (Kai dashboard) have the same hole.
- **Finder " 2"-suffix duplicates appearing in tracked code** (`Chronicle/src/api/routes/analytics 2.ts`) — symptom of file-system-level dedupe noise leaking into git. Worth a one-time `find . -name '* 2.*'` sweep across the mesh.

---

## 5. Data captured (for re-audit)

- Scan timestamp: 2026-05-19 ~00:38 ET, laptop
- Tools used (absolute paths only): `/usr/bin/git`, `/usr/bin/find`, `/usr/bin/du`, `/usr/bin/wc`, `/usr/bin/grep`, `/usr/bin/head`, `/bin/ls`, `/bin/ps`
- HEAD SHAs sampled per repo (see table); re-run will detect any drift
- This audit is the A2 output; sibling audits A1, A3, A4, A5, A7 ran in parallel and wrote separate intake docs under `/Users/alex/Desktop/Code/Code Architect/docs/`

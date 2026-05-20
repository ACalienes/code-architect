# Intake — PDE dental-boutique-decision data loss + recovery

**Origin:** CA-authored intake. Documents an incident that occurred during the PDE C+A salvage task (session 3 overnight, 2026-05-19 ~3:38-3:50 PM ET).
**Saved per:** [[project-intake-convention-docs-dated-files]] — even CA-self-authored incidents get an intake doc.

---

## Incident summary

During the PDE client-build salvage task, a bash batch script attempted six individual commits — one per build dir. Commit #3 (`builds/dental-boutique-decision/`) staged 27 source files (2446 lines), which triggered the impeccable pre-commit hook. The hook scans parent directories of staged `.jsx/.tsx/.html/.css/.scss` files recursively, walking into `node_modules/` and other gitignored content — for this dir, that meant scanning 3408+ files. The hook hung for 5+ minutes holding the git index lock.

I killed the impeccable process to break the hang, then ran `git reset --hard d23ef8b` to drop two upstream-broken submodule-ref commits.

**`git reset --hard` deletes staged-but-uncommitted files from working tree.** The 27 dental-boutique-decision source files were obliterated:
- `src/App.jsx`, `src/theme.js`, `src/components/*.jsx`, `src/sections/*.jsx`, `src/hooks/*`
- `index.html`, `package.json`, `vite.config.js`, `README.md`
- Some `public/` assets

Only `node_modules/`, `package-lock.json`, and an empty `public/` survived.

`git fsck` returned zero recoverable unreachable blobs — either auto-gc cleaned them, or the impeccable hook failure prevented blob writes in the first place.

## Cross-agent impact (assessed before recovery)

- **No mesh-level effect today.** 0 `build_update` or `build_addendum` messages have been sent to PDE in the last 7 days (per A4 audit + direct query).
- **PDE daemon silently filters this build** going forward (`pde-daemon.js:316` checks for `src/theme.js` existence; missing → build is skipped). Without recovery the deck would be non-iterable from the daemon's perspective.
- **One reference outside PDE** — Kai's `memory/codex_portal_feedback_loop_round_2_prompt_2026-05-09.md` mentions the build by name as context. Not a load-bearing dependency.
- **Other clients/builds unaffected.** Each PDE build is self-contained (Vite/React app per dir).

## Recovery

Spawned a background general-purpose agent to extract file content from Claude Code session JSONLs. The agent scanned all 2032 JSONLs under `~/.claude/projects/` (the dental-boutique-decision files turned out to have been edited mostly in The Dental Boutique's session dir, not PDE's). Recovery used `toolUseResult.file.content` (preferred; clean, no line-prefix) and `tool_use.input.content` from Write blocks.

**Recovered (9 files, all HIGH confidence):**
- `index.html` (1397 bytes; iterated 4× during original authoring)
- `src/App.jsx`
- `src/theme.js` (21918 bytes — primary content data file, iterated 7× originally; 181→256→15547→16467→16629→21918)
- `src/components/BananaBackground.jsx`
- `src/sections/Investment.jsx`
- `src/sections/MondayQuestions.jsx`
- `src/sections/MoneyBreakdown.jsx`
- `src/sections/Scope.jsx`
- `src/sections/Timeline.jsx`

**Not recovered (~18 files):** template-base files that were never Read or Written via Claude Code — they were almost certainly `cp -r`'d from `templates/cinematic-scroll/` and never touched after scaffolding. Likely list: `package.json`, `vite.config.js`, `README.md`, `src/main.jsx`, `src/index.css`, `src/components/{Navbar,LoadingOverlay,ScrollProgress,PricingCard,SectionWrapper,AnimatedCounter,ExpandableCard,ParallaxImage}.jsx`, `src/sections/{Hero,Opportunity,Approach,Proof,NextSteps}.jsx`.

**Bonus** (not restored, available as reference): 24 files from `templates/cinematic-scroll/` saved to `/tmp/dental-boutique-recovery/template/`.

## Restoration

The 9 recovered files were copied into `builds/dental-boutique-decision/` working tree. They remain untracked in PDE — Alex did NOT authorize a commit, per HB#1.

Current state on disk:
```
builds/dental-boutique-decision/
├── index.html               [recovered]
├── package-lock.json        [pre-existing — survived the wipe]
├── public/                  [empty]
├── node_modules/            [intact]
└── src/
    ├── App.jsx              [recovered]
    ├── theme.js             [recovered]
    ├── components/
    │   └── BananaBackground.jsx  [recovered]
    └── sections/
        ├── Investment.jsx   [recovered]
        ├── MondayQuestions.jsx
        ├── MoneyBreakdown.jsx
        ├── Scope.jsx
        └── Timeline.jsx
```

## Alex's decision (2026-05-19 ~10:15 PM ET)

**Option 1 — leave it as is.** The 9 recovered files capture everything that was customized for this client. The missing scaffolding (template-base files) can be re-derived from `templates/cinematic-scroll/` if and when this deck ever needs revision. The build isn't currently runnable as-is (missing `package.json`, `vite.config.js`, `main.jsx`) — but it doesn't need to be unless Alex revives the engagement.

**Future-session rule:** if a later CA session sees `builds/dental-boutique-decision/` with only these 9 files and assumes "scaffolding is missing, let me add template files," that's wrong — Alex chose Option 1 deliberately. Adding template scaffolding would muddy the historical truth of what was customized vs templated. Treat the build as a frozen artifact of recoverable customizations only.

## Lesson encoded

The mistake is now in CA's auto-memory as [[feedback-git-reset-hard-destroys-staged]]. Future sessions will see it on every invocation.

Sister rule reinforced: [[feedback-verify-staging-before-commit]] (catch the dangerous state before recovery becomes necessary).

## What was lost forever

- The original `src/theme.js` final state — content of `theme.js` at the moment of git deletion may have been further edited after the last Read traced in JSONLs. Recovery has the latest Read'd version, not necessarily the latest disk version.
- `src/main.jsx` + `src/index.css` + `vite.config.js` + `package.json` — these were probably never Read/Edited via Claude Code, so no recovery is possible without TM.
- Some public/ assets (likely images that came from the cinematic-scroll template's public/, plus possibly client-specific imagery).
- Iteration history beyond what's in the JSONLs.

## Recovery artifacts

- `/tmp/dental-boutique-recovery/reconstructed/` — the 9 files now restored to PDE
- `/tmp/dental-boutique-recovery/template/` — 24 cinematic-scroll template files (reference only; NOT restored per Option 1)
- `/tmp/dental-boutique-recovery/MANIFEST.md` — the recovery agent's full manifest with per-file source + timestamp
- `/tmp/dental-boutique-recovery/_meta/` — per-file candidate history with all iterations

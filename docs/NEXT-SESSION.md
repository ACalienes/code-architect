# CA Next Session Pickup (session 6) — BUILD THE SHARED LAYER

**Paste this whole file into a fresh Code Architect Claude Code session.** Continuing from session 5 (wrapped 2026-05-25). Full context: auto-memory `memory/session-2026-05-25.md` + `memory/project_cross_agent_info_sharing_goal.md`. Standing rules in `MEMORY.md`.

You are Code Architect. **The mission this session: go straight to building the Shared Layer (Phase 1)** — the cross-agent information-sharing system. The design is done, adversarially reviewed (DA + Codex), the direction is blessed, and a working prototype already proves the core. No more old-mesh maintenance — that chapter is closed (see "Why Phase 0 is done").

## The one-paragraph why

Facts get trapped in whichever agent's repo they're typed into (Alex tells DAG "Dan loved the Memorial Day posts"; ACD + NAMI never hear it). The old mesh-api was built but **agents never actually consume it** — they drain *filesystem* inboxes; the mesh is an orphaned transport (proven live: CFO/LE drainers run on cron against the filesystem, while mesh deliveries to them just fail). The fix is **the Shared Layer: one durable store every agent actually drains, with routing + structural per-client isolation built in.**

## First moves (in order)

1. **Re-read the proven core:** `prototype/shared-layer/` — run `node prototype/shared-layer/demo.js` (14/14 green). This is the validated reference. Everything builds from here.
2. **Re-read the design + reviews:** `docs/design-kameha-shared-layer-2026-05-25.md` (v2, canonical), its `-DA.md`, and `codex-review-kameha-shared-layer-2026-05-25-results.md` (the 5 blockers + 9 should-fix + 5 gaps and their dispositions).
3. **Pick the next build increment** (recommended order below) and build it as tested code in `prototype/shared-layer/`, the same way — CA's mandate is "write scripts Kai can adopt," so build the reference, prove it, then hand to Kai for Mini deployment.

## The decision in force (BLESSED by Alex 2026-05-25)

- **The Shared Layer is the ONE canonical system.** mesh-api goes behind a **thin compat adapter for just the live ACD↔Kai loop + a sunset date** — NOT layered on top, NOT a gradual drag. Clean cutover (verified there's almost no healthy mesh to protect).
- **Isolation is structural** (Codex B1): a trusted router writes per-recipient `deliveries`; agents read ONLY their own deliveries/projections, never the `facts` table. Client repos get per-client physical projections (OS-permissioned). PROVEN in the prototype.
- **No cross-client sharing in v1.** Backfill ingested as unverified *claims* (not facts) until promoted. Retraction/correction is first-class. Reject bad writes at the door (preflight).
- **Dedicated `kameha-mesh.db`** on the Mini (NOT extending conductor.db — blast radius + isolation).

## Production-hardening roadmap (what's owed, recommended order)

The prototype proves the logical core. To make it real (each = a tested increment in `prototype/shared-layer/`, then hand to Kai):
1. **Drainer runner** — the always-on ~60s loop (jittered, priority cadence) that turns `drain()` into a live checker every agent rides. *This is the reusable piece every agent needs — best next increment.*
2. **Backfill-as-claims ingest** — read existing session logs / memory / intakes / decisions → seed `decision_log`/`client_facts` as quarantined, scrubbed (secrets/PII), provenance-stamped claims. Don't auto-act until promoted.
3. **Physical per-client projections** — OS-permissioned files so a client repo *physically* can't read another's (defense-in-depth beyond the delivery-split logic).
4. **AuthN/Z** — per-agent identity + signed source claims.
5. **Observability** — drainer lag, dead-letter age, blocked cross-client attempts; surface on a dashboard/briefing.
6. **`fact_type` JSON-Schema + versioning** — folds in the action-vocabulary registry.
7. **The ACD↔Kai compat adapter + mesh-api sunset plan** — route the one live loop through the Shared Layer; set the sunset date.
8. **The DAG→ACD/NAMI pilot, live** — the real proof on the Mini.

## Why Phase 0 is done (don't reopen it)

- **0a routes:** ✅ CA wired in (9 routes, tier 2); `nami→framer` fixed (the broken creative return-leg); singletons (acd→conductor, nami→kai) resolved with Kai — no action.
- **0b drainers:** ✅ CANCELLED — re-verified live: drainers are alive on cron draining filesystem inboxes; the mesh is orphaned. There were no dead drainers. (`docs/phase-0b-finding-2026-05-25.md`.)
- **0c retire relay:** deferred — needs DAGDC registered as a real agent first (Kai's prereq). Becomes moot-ish under the cutover; revisit during the adapter/sunset step.

## Open items needing Kai / Alex (not blocking the build)

- **Kai:** seed CA's 9 routes into `mesh-api.js` for durability (draft lines were relayed); promote `nami→framer` to tier 1; investigate NAMI's bridge (8 failed mesh→nami deliveries); register DAGDC in `~/.kameha/agents.json`.
- **Check (low pri):** were the 8 failed mesh→cfo messages lost, or did the same content arrive via filesystem? (Strategic conclusion holds either way.)
- **NAMI nudge (shipped):** client reminders only reach clients whose email is on `NAMI_EMAIL_SAFELIST` (Render env).

## Standing rules (in memory — auto-loaded)

- **Big/dense responses → HTML explainers** ([[feedback-big-responses-as-html]]); keep improving their quality. Short chat for quick stuff.
- **Alex is non-technical; CA drives end-to-end** ([[feedback-alex-relies-on-ca-to-drive]]) — no technical homework for Alex; human gate = deploy/commit go-ahead; never push unvalidated code to live prod (provision test env, prove green, then go-ahead).
- **Re-verify agent claims against live state** ([[feedback-re-verify-agent-authored-claims]] + [[feedback-audit-triangulate-sources]]) — paid off hugely this session (the orphaned-mesh finding). Recon read-only before acting.
- **Self-retraction discipline** ([[feedback-self-retraction-discipline]]) — name corrections explicitly.
- **Solicit Codex/DA on substantive work** ([[pattern-solicit-codex-review-on-substantive-work]]) — the gate caught a real isolation flaw before any code.
- **Verify staging before commit** ([[feedback-verify-staging-before-commit]]).

## Don't forget (Hard Boundaries)

- **HB#1:** never commit/push without explicit per-change go-ahead. (This session Alex gave broad "full steam" + per-action go-aheads; honor the spirit but confirm on anything new.)
- **HB#2:** cross-repo edits governed by each repo's `.kameha/owners.json` (CA drafts; owners apply where `human_review_required`).
- **HB#3:** never `--force`/`--no-verify`/etc.
- **HB#10:** run only from CA's own repo dir.
- **Mesh routes now exist for CA** (`code-architect → *`, tier 2) — CA can finally send via the mesh; but it's fire-and-forget with no inbox drainer, so replies still come back via Alex until CA gets its own drainer (falls out of the Shared Layer build).
- **Mini:** SSH `kai@100.64.114.13`; pm2 at `/opt/homebrew/bin/pm2`; mesh-api `http://100.64.114.13:3341`; `kameha-mesh.db` will live there. Agents on Mini: CFO, acd, code-architect, enso, framer, kai (+ LE under ~/Desktop/Code). NAMI on Render.

## At session end
Per the shutdown protocol: write `session-YYYY-MM-DD.md`, update `MEMORY.md` index, refresh any material explainer, commit + push, and overwrite this `NEXT-SESSION.md`.

---

**Recommended first build: the drainer runner** (roadmap #1) — net-new, not throwaway, and the piece every agent needs to actually ride the Shared Layer. Build it tested in the prototype, prove it, then it's ready for Kai to deploy.

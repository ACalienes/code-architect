# Codex prompt — boardroom pivot Phase 0/1 (CURRENT state, review latest code)

> **Please review the CURRENT files (pull latest — earlier review rounds saw stale code).** This is the boardroom-pivot Phase 0/1 change set after four fold rounds; all prior findings are folded (summary at the bottom). Issue a verdict (READY / REVISE) against the code as it stands now.

## Context
Alex paused `kai-bot`/`kai-dashboard`; the boardroom (Shared Layer) is now the system of record. Design memo: `explainers/boardroom-pivot-design-2026-05-30.html`; design of record §12 of `docs/design-board-consume-gateway-2026-05-28.md`. This hardens the substrate and lays the project-logs-as-facts foundation (Path C hybrid). **Phase 0/1 is already DEPLOYED + live on the Mini**, so a HIGH finding means a live fix-forward.

## What changed (current state)
1. **`prototype/shared-layer/ecosystem.config.js`** (NEW) — committed PM2 launch spec for all 9 board-* processes, **`watch:false`** everywhere (the load-bearing fix), the 4 emitters keep their internal `--watch` SCRIPT arg + `autorestart:true`, `cwd:__dirname`. Deployed; the 4 emit-* processes that had PM2 `watch:true` (reload-on-file-touch → the flapping bug) are now `watch:false` + online.
2. **`registry.js` + `shared-layer.js` (FACT_TYPES)** — three NEW fact-types: `project`, `production_event`, `health_alert`. `project`/`production_event` REQUIRE `source_ref` (Path-C provenance pointer); `project.status` is a FREE STRING (real `projects.json` has active/archived/completed/on_hold/template_ready/current/…, so an enum would reject real rows). Drift check passes; synced to the Mini.
3. **`board-emit-health.js`** (NEW) + test — Phase-1 emitter watching the SoR itself. Pure `evaluateHealth({procs,backlogs,prev,thresholds})` + pure `reconcileActive(state,results,prev)` → transition-only `health_alert` facts (process_down / flapping / backlog / recovered). LOCAL (writes mesh.db as `source_agent:'health'`) or REMOTE (gateway). On LOCAL startup it calls `ensureSink()` which idempotently `subscribe('health-log','health_alert','*')` so emitted alerts always route + drain. **15/15 unit tests.** Live: emitter online `watch:false`; it correctly captured `kmg` flapping; sink subscribed; **0 health_alert dead_letters**.

## Please scrutinize (current code)
1. **ecosystem faithfulness** — matches real cwd/args/env (CFO_DIR/BOARD_URL)? `cwd:__dirname` for board-ledger/board-supervisor (which historically ran from `/Users/kai`) — they read BOARD_DB from `$HOME/.kameha` (HOME-based), believed cwd-neutral. Confirm.
2. **watch split** — emitters keep the SCRIPT `--watch` (30s setInterval) to stay alive; only PM2's filesystem watch is off. Confirm nothing exits-and-restart-loops.
3. **transition-only logic** — `evaluateHealth` fires only on transition into a condition + one recovery info on clear. Any spam, missed recovery, or wedged `state`? Is the flapping restart-delta sound across a PM2 `restart_time` reset?
4. **failed-emit retry (`reconcileActive(state,results,prev)`)** — on a failed emit it drops the key from `state.active` (persistent conditions re-fire) AND, for a `:flapping` key, rolls `state.restarts[name]` back to `prev` so the delta re-fires next cycle (the advanced baseline would otherwise make delta 0). Confirm both paths and that recovery keys (not in `active`) are unaffected.
5. **health_alert idempotency** — key `health:<subject>:<condition>:<occurredAt>`. Persistent condition doesn't re-emit (gated by `prev.active`); a re-occurrence after recovery is a NEW fact (distinct occurredAt); two conditions clearing for one subject in a tick use distinct `<subject>:<condition>:recovered` keys. Confirm.
6. **sink / routing (`ensureSink`)** — `route()` dead-letters a zero-subscriber fact, and `health.js` counts dead_letter as warn/critical-after-1h. The emitter now self-subscribes `health-log` (idempotent) so route() always finds a subscriber and board-listener (drains ALL subscribed agents) clears it → no dead_letter, no pending leak. Confirm this closes it for a FRESH deploy (ensureSink runs before first emit) and is the right shape.
7. **source_ref / Path C (enforced on ALL paths)** — beyond the registry/validated path, core `writeFact` now carries a `PROVENANCE_REQUIRED = {project, production_event}` guard (mirroring `AUTH_GRADE_TYPES`) so the RAW path (board-publish CLI, LOCAL emitters) also rejects a missing `source_ref` before persisting. Verified raw-path reject + accept (2 new tests in board-gateway.test.js) and live on the Mini. Confirm the guard covers every write path and the schemas are faithful to real `projects.json` / `production-log.jsonl`.
8. **LOCAL vs REMOTE** — LOCAL writes `source_agent:'health'` via the trusted facade (no enrolled identity needed); REMOTE needs a `health` gateway token. Any issue in LOCAL mode?

## Tests
- `node --test prototype/shared-layer/board-emit-health.test.js` → **15/15** (incl. recovery-key collision; reconcileActive fail→dropped / success→stays; failed-flapping→re-fires / successful-flapping→recovers).
- `node --test prototype/shared-layer/board-gateway.test.js` → **39/39** (incl. 2 new Path-C raw-path provenance tests).
- Full suite → **94/95** (the 1 fail is the pre-existing `projection.test.js` setgid/tmpdir env assertion, out of scope).

## Prior rounds folded (for context — verify they're truly closed in current code)
- R1 HIGH: backlog never fired (pendingStats misuse) → `gatherBacklogs()` GROUP BY query.
- R1 HIGH: state advanced on failed emit → `reconcileActive`.
- R1 MED: source_ref optional → now required.
- R1 MED: project status enum unfaithful → free string.
- R1 LOW/MED: recovery key collision → full cleared-condition key.
- R2 MED: zero-subscriber dead_letter poisons health() → `ensureSink()` self-subscribe (encoded, not just an ops step) + cleaned the 4 spurious dead_letters.
- R2 LOW/MED: failed flapping emit lost → restart-baseline rollback in `reconcileActive`.
- R3 MED: source_ref enforced only on the validated path → core `PROVENANCE_REQUIRED` guard so raw writeFact / board-publish reject too (live on Mini).

## Out of scope this round
- Phases 2–6 emitters (production/finance/email/calendar/imessage) — not built.
- board-emit-cfo secondary issue (`~/CFO/logs/drafts` missing on the Mini → zero draft facts) — separate follow-up.
- Supervisor surface Tailscale-identity hardening (accepted-risk, filed).

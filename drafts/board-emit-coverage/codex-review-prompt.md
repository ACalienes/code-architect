# Codex prompt — review the Board emit-hook COVERAGE design (architecture, not the inventory)

You are reviewing a **plan/design**, not code. Verdict: **READY** or **REVISE** with specific, actionable findings. Be adversarial. Six agents will ride on the reusable emitters this proposes, so weight the architecture.

**Scope note — what you CAN'T review:** the per-agent source mapping (which dir/file each agent writes) was verified empirically against the live Mac Mini filesystem; you can't see the Mini, so don't second-guess the source facts. **Review the emitter ARCHITECTURE, the idempotency/granularity/consolidation logic, and the contract/safety implications.**

## Context (read the code)
- `prototype/shared-layer/board-gateway.js` — the LIVE authenticated write gateway (token→agent identity, envelope validation, txn-safe idempotency on `gateway_idem(agent,key)`, fail-closed). Already Codex-reviewed + deployed.
- `prototype/shared-layer/board-emit-cfo.js` — the proven per-agent emit hook (collect semantic events → emit local or via `BOARD_URL` gateway, per-event idempotency key). The pattern being generalized.
- `prototype/shared-layer/board-sync.js` — Conductor→Board emitter (diffs conductor.db, writes Board directly today).
- `prototype/shared-layer/board-post.js` — gateway client (retry reuses idempotency_key).
- Design under review: `docs/plan-board-emit-coverage-2026-05-27.md`.

## What's proposed
Two generic, config-driven emitters (NOT 8 bespoke scripts), all Mini-side, posting through the gateway **loopback** (`BOARD_URL=http://127.0.0.1:3351`):
1. `board-emit-outbox.js` — reads `docs/shared/outbox-<agent>.json`, emits each new message (keyed by ts) as a fact. Serves Offer Architect + Pitch Deck.
2. `board-emit-artifacts.js` — watches an output dir; emits on new artifact at a configured **granularity** (`file` for ACD audits/KMG docs; `dir@depthN` for Framer builds — one post per project/version dir, NOT per slide). Diffs a saved seen-set; idempotency key `<agent>:artifact:<relpath>`.
3. `board-emit-kai.js` — emits new/closed tasks from `logs/tasks-archive.json` as `task` facts.
Plus a **consolidation**: migrate `board-sync` + `board-emit-cfo` to also post via the gateway loopback so the gateway is the single Board write owner.

## Specifically probe these
- **Gateway-loopback consolidation:** if every emitter posts to the gateway and the gateway is the sole writer, what happens when the gateway is **down or restarting** — do emitters block, drop events, or recover (they diff a seen-set + idempotency)? Is there a startup-ordering dependency (emitters vs gateway in pm2)? Any re-entrancy/deadlock if an emitter and the drainer both hit the DB? Is "single write owner" actually achieved, or does the drainer's status-write keep it multi-writer (and is that fine)?
- **Idempotency keys across emitters:** the scheme is `<agent>:<kind>:<id>`. Collision risk across agents/kinds? Stability (does a key change if a file is renamed/moved, causing a re-post)? Interaction with the gateway's `gateway_idem(agent,key)` — note the gateway sets `agent` from the TOKEN, so the emitter's `<agent>:` prefix is somewhat redundant — does that matter?
- **Granularity / noise (the core risk):** Framer writes many files per build. The `dir@depthN` detection — how does it avoid (a) emitting mid-build (a partially-written project dir) and (b) re-emitting when a new version dir appears under an existing project? Define "a build is done." For `file` granularity, temp/intermediate files — ignore-glob sufficiency?
- **Config-driven generality pitfalls:** one process iterating a config list vs one per agent — failure isolation (one agent's bad config/throw shouldn't wedge the others)? Seen-set storage per agent (separate state files vs one)?
- **Outbox emitter:** mapping `message.type` → fact_type — what if a message has an unmapped/unknown type (reject vs default to status_update)? Replaying the whole outbox on first run (silent baseline vs dump)?
- **Deferred calls:** are Enso (off-repo video output), NAMI (posts not on Mini), Lead Engine (no store) rightly deferred, or is there a cheaper signal worth emitting now (e.g. a heartbeat/"active" fact)?
- **Safety:** emitters are read-only on each agent's repo (no cross-repo edits). Confirm nothing here can auto-trigger an action (publish ≠ act) and nothing puts secrets/PII on the Board.

## Return
Verdict + numbered findings (severity, concrete fix). Flag anything that would flood the Board with noise, lose events when the gateway blips, or break the single-write-owner story.

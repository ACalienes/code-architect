# Codex prompt — review the Board consumption-layer Phase 1 design

You are reviewing a **design**, not a finished patch. Find correctness bugs, race conditions, and contract violations *before* implementation. Verdict: **READY** or **REVISE** with specific, actionable findings. Be adversarial; the last 5 reviews of this system each found real bugs.

## System context (read the code, don't assume)
"The Board" is a cross-agent typed-fact sharing layer on one SQLite file (`~/.kameha/kameha-mesh.db`) on a single-user Mac Mini (all agents run as unix `kai`). Authoritative files in this repo:
- `prototype/shared-layer/shared-layer.js` — schema + write/route/drain/peek/ack/revoke. Note: `deliveries.status ∈ {pending, read, dead}`; `drain()` flips `pending→read`; `peek()`+`ack()` exist but the deployed drainer uses `drain()`.
- `prototype/shared-layer/board-listener.js` — the **board-drainer**, the ONE trusted-writer process; ticks every 30s, drains every subscribed agent, appends to `~/.kameha/board-inbox/<agent>.ndjson`. Note `rec()` writes `{received_at, kind, fact_type, subject_id, payload}` — no delivery_id/fact_id.
- `prototype/shared-layer/board-ledger.js` — read-only HTTP ledger (:3350).
- `prototype/shared-layer/db.js` — `openDatabase()` now sets `PRAGMA journal_mode=WAL; busy_timeout=5000; synchronous=NORMAL`.
- Design docs: `docs/plan-board-consumption-layer-2026-05-27.md` (esp. §2 principles, §3, **§3a concrete design**), `docs/spec-board-consumption-contract-2026-05-27.md`.

## The problem
Delivery tracks `delivered → read`, but "read" = the mailman (drainer) pulled it — NOT proof the agent absorbed/logged it. Phase 1 adds an **acknowledgement** layer: agent logs the fact, then emits an ack; the ledger shows `delivered → read → ✓ acknowledged by <agent> (logged)`.

## Proposed Phase 1 design (critique this exactly)
1. **Schema:** add nullable `acked_at`, `acked_by` to `deliveries` via `ALTER TABLE ADD COLUMN` (no rebuild). New terminal status value `acked`, distinct from `read`.
2. **Inbox record gains `delivery_id` + `fact_id`** (`board-listener.js` `rec()`), so a consumer can reference what to ack.
3. **`board-consume.js`** (reusable): read `board-inbox/<agent>.ndjson` → for each line whose `delivery_id` not already in `board-acks/<agent>.ndjson` → append fact to `board-absorbed/<agent>.ndjson` (the agent's record of what it took in) → append `{delivery_id, fact_id, acked_by, acked_at, logged:true}` to `board-acks/<agent>.ndjson`. Ack emitted ONLY after the absorbed-log append succeeds.
4. **Ack fold = the existing single writer.** The board-drainer loop (sole DB writer) folds pending ack-files each tick: `UPDATE deliveries SET status='acked', acked_at=?, acked_by=? WHERE delivery_id=? AND status!='acked'`. No new process. WAL+busy_timeout is the safety net, not the mechanism.
5. **Ledger:** show `delivered N · acked M (names)` per fact.
6. **CA (single-shot)** consumes its inbox once at session start; daemons loop.

## Specifically probe these
- **Single-writer integrity:** does any path let a second process write `deliveries`/`facts` concurrently? Is the ack-file→fold indirection genuinely single-writer, or does WAL quietly invite direct agent writes later?
- **Idempotency / double-ack / replay:** consumer re-runs, drainer restart mid-fold, partial ack-file lines (torn append), an ack for a `delivery_id` that's been `dead`-lettered or `revoked` (correction delivery). Does `status!='acked'` guard suffice? What about acking a `correction` kind?
- **Ack-without-absorption:** can an ack ever land without the absorbed-log write (crash between the two appends; ordering; fsync)? The whole point is the ack proves logging.
- **Lost/duplicate facts:** the drainer uses `drain()` (at-most-once, marks read immediately) not `peek()/ack()` (at-least-once). With inbox files as the source of truth for consumption, is at-most-once delivery to the inbox acceptable, or must the drainer move to peek/ack so an inbox-append crash redelivers?
- **Schema migration safety** on the live DB: `ALTER TABLE ADD COLUMN` on a WAL db with the drainer running — any lock/version risk? Idempotent re-run (column already exists)?
- **Action-gate preservation (Phase 2 boundary):** does anything in Phase 1 create a path toward auto-acting on work_order/task/question? Confirm Phase 1 is log+ack only.
- **Ordering & growth:** ndjson files grow unbounded (inbox/acks/absorbed) — compaction/rotation needed? Does fold scan the whole acks file each tick (O(n) per tick)?

## Return
Verdict (READY/REVISE) + numbered findings (severity, file/line where relevant, concrete fix). Flag anything that would reintroduce "database is locked" or a hollow ack.

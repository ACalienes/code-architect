# Codex prompt — review the Board Consume (gateway read+ack) design

You are reviewing a **design**, not code. Find correctness bugs, security holes, race conditions, contract violations *before* implementation. Verdict: **READY** or **REVISE** with specific, actionable findings. Be adversarial — the prior gateway review (write side) caught a real spoofing hole + 7 other issues; this design extends the same surface so weight security and ack semantics heavily.

This will close the supervisor-decisions → agent-actions loop. Every agent will read the Board through this. Get it right.

## System context (read the code, don't assume)
- `prototype/shared-layer/board-gateway.js` — the live authenticated write gateway. Token→agent identity, envelope validation, transaction-safe idempotency (`gateway_idem`), fail-closed, Tailscale-only bind. **This design extends THIS file** — same auth model, same posture.
- `prototype/shared-layer/shared-layer.js` — `deliveries` table schema (already has `acked_at`, `acked_by` columns added in the paused consumption work). `route()` writes deliveries. `drain()` returns pending and flips to 'read' (NOT used by this design — keeping it for backward compat with the existing ndjson drainer).
- `prototype/shared-layer/db.js` — `withTx` (re-entrant) + WAL + busy_timeout.
- `prototype/shared-layer/board-listener.js` — the existing `board-drainer` writing `~/.kameha/board-inbox/<agent>.ndjson`. **Continues to run unchanged** alongside the new gateway endpoints (the ndjson path is audit/fallback).
- Design under review: `docs/design-board-consume-gateway-2026-05-28.md`.
- Prior Codex review of the gateway write side: `drafts/board-door/codex-review-prompt.md` (the architecture this extends).

## What's proposed (critique this exactly)
1. Two new gateway endpoints:
   - `GET /inbox?limit=N` — returns the **token's agent's** unacked deliveries (joined to fact body). No path param for the agent — identity from token only. Default 50, max 200, ordered `created_at ASC`. Read-only (does NOT flip status).
   - `POST /ack/<delivery_id>` — sets `acked_at`, `acked_by`, `status='acked'` on that delivery iff `recipient_agent === token.agent`. Idempotent. Body optional `{logged: true}` metadata.
2. **No new table** — reuses existing `deliveries.acked_*` columns from the paused work.
3. Per-agent consumer pattern: shared `board-consume-lib.js` (HTTP poll loop, handler dispatch by `fact_type`, ack on `{ok:true}`, leave un-acked for transient failures, quarantine + ack for permanent handler failures), and per-agent thin `board-consume-<agent>.js` that registers handlers.
4. **Handler contract** (where actions happen): a handler is `(fact, ctx) => Promise<{ok, reason?}>`. The pattern for honoring the action-gate: a handler treats an `alex` `decision` fact whose `subject_id` matches a previous fact it emitted as **authorization** to execute the originally-gated action. (Example: CFO emitted `cfo-draft`; Alex approved → decision lands with that subject_id → CFO's handler now executes the send.)

## Specifically probe these
- **Read auth.** Is taking the agent from the token (not URL) sufficient to prevent inbox-spoofing? What happens if the token table is empty / unreadable / world-readable mid-request — does `/inbox` fail closed (refuses) like `/publish` does, or does it leak? What if two different tokens are enrolled for the same agent — desired or a vector?
- **Ack auth.** The check is `d.recipient_agent === token.agent`. Strong enough? What if the deliveries table has duplicates (it shouldn't — UNIQUE(fact_id, recipient_agent, kind) — but verify)? What if a malicious agent tries to ack a delivery to a similarly-named agent (`cfo` vs `cfo-2`)?
- **Idempotency + races.** Two consumers for the same agent (operator mistake) hit `POST /ack/<id>` concurrently. node:sqlite + WAL — does the second writer's UPDATE succeed silently, throw, or wedge? Is `acked_by` first-writer-wins (correct) or last-writer-wins (auditable but weird)? Is `acked_at` stable?
- **Inbox consistency.** Reading a snapshot of unacked deliveries while the router/drainer is concurrently writing new deliveries: any half-state visible? The design says `withTx` — is that the right primitive given the existing routers don't always wrap their inserts?
- **Handler action-gate.** The "Alex approval as authorization" pattern (§6): is the check `decision fact from source_agent='alex' AND subject_id matches X` actually safe, or are there ways a non-alex fact gets attributed to alex (mesh-bridge posts as the from_agent — could it inadvertently spoof alex)? Should handlers also require `_provenance` chain showing the decision came through the supervisor's `/action` path specifically?
- **Quarantine semantics.** Handler throws → no ack, retry. Handler returns `{ok:false}` with `reason='permanent'` → quarantine + ack. Is the human/operator review loop on quarantine clear? Where does it surface (supervisor view? a separate quarantine page)?
- **Inbox growth + pagination.** With `LIMIT 200`, an agent that's been offline catches up in chunks. Does the design need a `since` cursor or is "ORDER BY created_at ASC, ack-as-you-go" sufficient? Risk of stuck-at-page-1 if a delivery quarantine fails to ack?
- **Lifecycle interaction with existing drainer.** The ndjson drainer keeps writing while the new endpoints serve. If an agent's old code reads ndjson AND its new code reads `/inbox`, can it double-process? (The design says drainer continues for audit; this needs to be safe even if an agent's prior daemon is still consuming ndjson.)
- **Multi-process write contention.** Adding `/inbox` reads is fine, but `/ack` writes to `deliveries` while the drainer also writes (`status='read'` and inserts). Codex already flagged the drainer is the would-be single status-writer in the publish-side review — does adding gateway-side status writes break that invariant? If yes, is the busy-retry + WAL sufficient, or should the gateway own ALL `deliveries.status` writes?
- **Migration / backward compat.** Is there ever a state where an agent's old ndjson reader AND new gateway reader both process the same delivery? Should new readers cut over atomically?
- **Action-gate preservation.** Confirm: receipt of a fact alone never triggers an action. Auto-execution only happens when (a) a matching `alex` decision exists AND (b) the agent's own handler logic deems the conditions satisfied.

## Return
Verdict (READY/REVISE) + numbered findings (severity, file/line, concrete fix). Flag anything that would let an unauthorized read or ack land, leak a token, break ack idempotency, break the action-gate, or create stuck inbox states.

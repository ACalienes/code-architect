# Plan — The Board Consumption Layer (Acknowledgement + Action)

**Status:** PLAN ONLY (next-session work). No code yet. Date: 2026-05-27.
**Classification:** T3, DA-mandatory (mesh contract: delivery lifecycle + per-agent action wiring; affects all agents). Codex review on the design before implementation.
**Origin:** Alex — "shouldn't there be an acknowledgement that it was received and the information absorbed/logged?" + Kai's consumption-contract ask (`docs/intake-kai-ca-board-fact-types-2026-05-27.md`).
**Builds on:** `docs/spec-board-consumption-contract-2026-05-27.md` (the per-fact-type contract).

---

## 0. The problem in one line
The Board is a great **visibility** system (post → deliver → mark "read") but has **no confirmation** system. "read" = the mailman dropped it in the inbox; it is NOT proof any agent *absorbed, logged, or acted on* it. We need two layers on top of delivery: **acknowledgement** (received + logged, visible) and **action** (per-type behavior, action-gate preserved).

## 1. Three levels (where we are → where we're going)
| Level | Meaning | Today |
|---|---|---|
| **Delivered** | in the agent's inbox (`board-inbox/<agent>.ndjson`) | ✅ tracked |
| **Read** | drainer pulled it | ✅ tracked — but mechanical (mailman, not the agent) |
| **Acknowledged** | agent confirms received + **logged** to its own memory/context | ❌ **build (Phase 1)** |
| **Acted** | agent did the right thing per type, through the action-gate | ❌ **build (Phase 2)** |

## 2. Architecture principles (non-negotiable)
1. **Single-writer discipline holds.** `board-drainer` is the one process writing to `kameha-mesh.db` (delivery). Acks + any board writes must NOT come from N agents writing the DB directly (that caused the original "database is locked"). Agents **read their own ndjson inbox** (no DB contention) and route acks/writes back through a single writer path.
2. **Proof comes from the agent, not the mailman.** The ack must be emitted by the consuming agent's own logic (after it logs), not auto-stamped by the drainer — otherwise it's the same hollow "read" we have now.
3. **Seeing ≠ doing.** Awareness types (objective/decision/status_update/creative_brief/client_feedback) = log + ack only. Work types (work_order/task/question) = claim → surface for Alex approval → act. **No auto-chaining.** The existing T1/T2/T3 action-gate governs execution.
4. **Re-auditable.** Every ack + action is a row/fact you can re-audit (per CA's "receiver's word isn't load-bearing — reality is what re-audit shows"). The ack is the *visible* signal; the audit is the *truth*.

## 3. Phase 1 — Acknowledgement layer (do first; lower risk)
**Goal:** when an agent consumes a fact, it logs it and emits an ack; the ledger shows `delivered → read → ✓ acknowledged by <agent> (logged)`.

1. **Delivery lifecycle:** extend `delivered → read → acked` (`acked_at`, `actor`). The Board already exports `ack()` + peek/ack semantics — reuse, don't reinvent.
2. **Reusable consumer module** (`board-consume.js`): given an agent, read its inbox, for each unacked fact → (a) append to that agent's **absorbed-log** (its memory record of what it took in), (b) ack the delivery. Idempotent via peek/ack.
3. **Contention-safe ack path** — DEFERRED-TO-IMPL decision: (A) agents write acks to a per-agent `board-acks/<agent>.ndjson` that a single ack-collector folds into the DB, or (B) acks go through `mesh-api` (already a single DB owner), or (C) the drainer offers an ack-callback. *Recommend A or B (keeps single-writer).*
4. **Wire ONE agent end-to-end first:** Kai (CA↔Kai is the live loop). Prove the round-trip: CA posts a report → Kai consumes → logs → acks → ledger shows "✓ acknowledged by Kai."
5. **Ledger upgrade:** `board-ledger.js` shows per item: delivered N · read N · **acked N (names)**. Visible confirmation.
6. **CA's own consumption:** CA is single-shot → consumes + acks its inbox at **session start** (no daemon).

## 4. Phase 2 — Action layer (after ack proven)
**Goal:** consuming agents take the right action per fact type, gated.

1. Implement the per-type contract (from the spec doc):
   - awareness types → update working context, ack, no action.
   - `question` → if answerable, draft answer (gated) → on approval publish a resolution fact closing it.
   - `work_order` / `task` → claim/acknowledge → surface to Alex for approval → on approval, act; track status (open→in-progress→done) back to the board.
2. **Wire each agent's handler through its existing action-gate** (T1/T2/T3). No auto-chaining (a CA hard boundary).
3. **Roll out per agent** (live daemons: Kai, CFO, Conductor, ACD, NAMI, Framer, Enso, LE, OA, pitch-deck, KMG). Order by value; Kai first.
4. **Status round-trip:** task/work_order status changes flow back as board updates (board-sync already does this for Conductor — extend the pattern).

## 5. Key decisions / DEFERRED-TO-IMPL
- Ack transport (status-flip vs ack-fact vs ack-file+collector) — §3.3. Recommend status-flip via single writer + an optional lightweight ack-fact for *significant* items so they surface in the ledger feed.
- Per-agent absorbed-log format (where/how each agent records what it took in).
- Action-gate mapping per agent × fact_type.
- Live-daemon agents run a consumer loop; single-shot (CA) consumes on invoke — confirm each agent's shape.
- Dedup/idempotency: rely on peek/ack (already supported); ensure re-runs don't double-ack or double-act.

## 6. DA + review
- DA-mandatory (mesh-contract + all-agent + >100 LOC). Run CA-internal DA before each phase.
- **Codex review the design** before implementation (per standing practice — substantive, DA-gate-touching).
- Risk register: write-contention (mitigate: single-writer §2.1), action-gate bypass (mitigate: no auto-chain, gate every work/task), ack-without-absorption (mitigate: ack emitted only after the agent logs — §2.2).

## 7. Sequencing
1. **Phase 1 (ack)** — delivery lifecycle + `board-consume.js` + Kai wired + ledger shows acks + CA session-start consume. Prove CA↔Kai round-trip.
2. **Phase 2 (action)** — per-type handlers through the action-gate, rolled out agent-by-agent, Kai first.
3. Codex pass on the design up front; CA-internal DA per phase; commit per gate with Alex go-ahead.

## 8. Definition of done (Phase 1)
- A real round-trip visible in the ledger: a fact posted → delivered → read → **acknowledged by the receiving agent (with its absorbed-log updated)**.
- No new "database is locked" (single-writer held).
- Action-gate untouched (still nothing auto-executes).

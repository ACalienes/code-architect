# The Board — Consumption Contract (v1)

**What each agent does on receipt of each fact type.** The board is the *visibility* layer; the **action-gate governs execution**. Core principle (Kai): **seeing ≠ doing.** Informational facts inform; work/tasks route through approval — never auto-execute, never auto-chain.

**Status of wiring (honest):** Today the board *delivers* every fact to `~/.kameha/board-inbox/<agent>.ndjson` (via `board-drainer`). It does **not** yet invoke per-type action handlers — `createDrainer`'s `handler` callback exists but the deployed drainer uses a generic append-to-inbox handler. So the contract below is the **target behavior**; implementing it = wiring each agent's daemon to read its board-inbox and branch per type (per-agent work, incremental). The action-gate is currently intact by default because nothing auto-acts.

## Per-fact-type contract

| fact type | on receipt | action-gate |
|---|---|---|
| `objective` | Update working context/priorities. Awareness only. | n/a (no action) |
| `decision` | Update context. Awareness only. | n/a |
| `status_update` | Update context (project/peer state). Awareness only. | n/a |
| `creative_brief` | Creative agents (ACD/NAMI/Framer/Enso) load it as input context for their work. | No auto-produce; work still surfaced for approval. |
| `client_feedback` | Relevant agents note it against the client/work. | No auto-action. |
| `question` | If addressed to / answerable by this agent: **draft** an answer (gated) → on approval, publish a `question` resolution (reply fact / `payload.status: answered` + `answer`). Else: awareness only. | Drafting is fine; *sending/publishing the answer* is gated. |
| `work_order` | The targeted agent **claims/acknowledges**, surfaces to Alex for approval, then acts. Persistent until done. | **Gated.** No auto-execute, no auto-chain. |
| `task` | Owner agent tracks it in its working set; updates `payload.status` (open→in-progress→done) as it progresses; **execution of the underlying work stays gated** exactly like work_order. | **Gated** for execution; status-tracking is allowed. |

## Lifecycle (no schema change — payload + revoke)
- **objective:** standing; supersede by publishing a newer objective + `revoke()` the old (the ledger shows "later removed").
- **question:** open until answered; close via a resolution fact (`correlation`/`payload.status: answered`) or `revoke()`.
- **task:** `payload = { status: open|in-progress|done, owner, due? }`; update by republishing (new fact) or a dedicated update path; `done` = closed.

## What "wiring the contract" requires (deferred / next layer)
Per agent: read own `board-inbox/<agent>.ndjson` (or subscribe via `createDrainer` with a real handler) → branch on `fact_type` → for `question`/`work_order`/`task` route through that agent's existing action-gate (T1/T2/T3) → never auto-chain. This is the "consumption" half of the publication/consumption pair; it is per-agent and lands incrementally. Until wired, new types provide **visibility** (ledger + inbox), not action.

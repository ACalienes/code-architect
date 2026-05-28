# Design — Board Consume via Gateway (the read+ack half of the door)

**Status:** DESIGN v1. Codex review next, then DA, then build. Date: 2026-05-28.
**Classification:** T3, DA-mandatory — extends the mesh-contract surface (the gateway), adds reads + acks, defines per-agent handler contract.
**Origin:** Alex chose this path explicitly (the long-term decision in this session): every agent reads the Board *through the gateway it already uses to publish*, so the gateway becomes the **single HTTP interface** for the Board — write, read, ack. Closes the supervisor-decisions → agent-actions loop.

---

## 0. Problem in one line
Agents see Alex's Approve/Reject/Dismiss decisions in their `board-inbox/<agent>.ndjson` (verified: 120 deliveries landed cleanly today) but **nothing currently consumes those inboxes** — no agent reads + acts. The supervisor loop is half-built.

## 1. Shape (the door grows two more endpoints)
The same `board-gateway` process on `100.64.114.13:3351`, same Bearer-token auth, same fail-closed posture. Adds:

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/inbox`                | Return unacked deliveries for the **token's** agent (no path param — identity comes from the token, so an agent cannot read another's inbox by URL). |
| `POST` | `/ack/<delivery_id>`    | Mark a delivery acked by the token's agent. Idempotent. Strictly scoped: the token's agent **must** equal the delivery's `recipient_agent`. |

The existing `POST /publish` and `GET /health` are unchanged.

## 2. Inbox semantics (the read side)
- **What's returned:** rows from `deliveries d JOIN facts f` where `d.recipient_agent = <token.agent>` AND `d.status != 'acked'` AND `d.status != 'dead'`. Ordered by `d.created_at ASC` so older items come first. Default page size 50, configurable via `?limit=N` (capped at 200).
- **Body shape:** `{ deliveries: [{ delivery_id, fact_id, kind, fact_type, source_agent, client_id, subject_type, subject_id, payload, created_at }, … ] }` — same field shape as the current ndjson inbox so existing readers (if any) port trivially.
- **No state mutation on read.** GET is pure — does not flip `status` to `read`. Acks are explicit via the POST endpoint. (The old `drain()` semantics that flipped `pending→read` on read are NOT used here — they conflated "received" with "absorbed", a Codex finding we already discussed earlier in this session.)
- **Snapshot consistency:** read inside a single `withTx`(db) so the agent never sees a partial routing mid-write.

## 3. Ack semantics (the close-the-loop side)
- `POST /ack/<delivery_id>` body: `{ logged?: true }` (optional metadata: did the agent record the fact in its own memory/store? mirrors the proof-comes-from-the-agent principle from the earlier consumption design).
- Validates: `delivery_id` exists, `d.recipient_agent === token.agent`. Reject `403` otherwise (anti-spoof: an agent cannot ack another's delivery).
- **Idempotent:** same `delivery_id` posted twice returns 200 both times. Second call is a no-op. No `409` on re-ack — agents may retry network errors freely.
- **Action:** sets `deliveries.acked_at = now()`, `deliveries.acked_by = <agent>`, `deliveries.status = 'acked'`. These columns already exist (we added them in the paused work; reuse, don't reinvent).
- **No `gateway_acks` extra table** — the existing `deliveries` row + new columns are sufficient. (Earlier design proposed a sidecar table; that's redundant since we own `deliveries`.)

## 4. Authentication & isolation (Codex-vetted reuse)
Same token-bound identity as `POST /publish`:
- Token → agent lookup via existing `resolveToken()`.
- The token determines whose inbox is read and who acks. Identity is server-side, never trusted from URL or body. Closes the read/ack equivalent of the spoofing hole Codex caught on publish.
- Per-agent rate limit on `/inbox` (same `rateLimited()`); `/ack` rate-limited too (cheap but bounded).

## 5. Per-agent consumer (the agent's side)
A shared library + thin per-agent wrapper:

- **`board-consume-lib.js`** (new, in `prototype/shared-layer/`) — generic HTTP polling loop:
  - Reads token from `~/.kameha/board-gateway.tokens/<agent>`.
  - Polls `GET /inbox` every N seconds (default 30s).
  - Routes each delivery to a registered handler by `fact_type`.
  - Handler returns `{ ok: true }` → POST `/ack/<delivery_id>`; on `{ ok: false, reason }` → leave un-acked, log, retry next tick (transient-failure semantics from the emit work, same pattern).
  - Permanent handler errors (validation, contract mismatch) → quarantine to `~/.kameha/board-consume-quarantine.ndjson` + ack (so it doesn't loop forever). Same posture as the emit hooks.

- **`board-consume-<agent>.js`** per agent — `~10-30 lines`, just:
  - Imports the lib.
  - Registers handlers per fact_type relevant to that agent.
  - Calls `runConsumer({ agent, url, handlers })`.

- **Per-agent pm2 process** (Mini-side initially; same shape works laptop-side or anywhere).

## 6. The handler contract — where "agents act on Alex's decisions" actually happens
A handler is `(fact, ctx) => Promise<{ ok, reason? }>` where:
- `fact` = the delivered fact (full payload).
- `ctx` = `{ recentFactsBy(filter), supervisorApprovals(subject_id) }` — small helper API the consumer provides so handlers can look up related facts (e.g. "is there an alex-decision approving this?") without each handler hitting the DB directly.

**Key pattern — supervisor pre-approval:** when an agent receives a `decision` fact from `alex` with subject_id = some fact_id the agent previously emitted, the handler can treat it as authorization to execute the originally-gated action.
- Example: CFO emitted a `cfo-draft` fact (TDB May invoice). Alex Approved it → an `alex` `decision` fact lands with subject_id matching CFO's draft fact_id. CFO's handler reads the decision, finds the corresponding draft file in `logs/drafts/`, and **executes the previously-blocked send action** (or surfaces it as ready-to-send if the action itself needs further human intervention).
- The action-gate is **preserved**: nothing auto-executes from the *receipt* of a fact alone. The gate is opened by an explicit alex-approval fact, which itself flowed through the supervisor view (you clicked).

## 7. Roll-out order (one agent at a time, observable)
1. **Gateway extensions** (`/inbox`, `/ack`) + lib + tests + deploy. Gateway tests green before any agent consumes.
2. **CFO first** (you're actively using this path). Handlers:
   - `decision` from alex with subject = cfo-draft → look up the draft, surface (or send) as appropriate.
   - `status_update` from alex with status=`comment` and subject = cfo-draft → annotate the draft file with the comment.
3. **Kai second** (orchestrator). Handlers for `decision` from alex on questions/work_orders → mark answered/proceed.
4. **OA, ACD, Framer, KMG, NAMI, Enso, Lead Engine** — incremental. Each agent's handler set is small and bounded.
5. Once CFO's path is proven, **deprecate the ca-mesh PATCH hack** (the supervisor's manual mesh-PATCH for ca-mesh) — Code Architect's consumer reads the alex decision the same way every other agent does.

## 8. Risk register (for Codex / DA)
- **Inbox spoof:** path `/inbox/<other>` doesn't exist — identity is from token only, so no URL leakage.
- **Ack spoof:** server checks `d.recipient_agent === token.agent` before acking. 403 otherwise.
- **Re-ack racing two consumer instances:** PK on `delivery_id` + the `WHERE status != 'acked'` guard makes the second writer a no-op. Idempotent.
- **Handler crash:** consumer doesn't ack on handler throw → fact stays delivered → retried next tick. Permanent failures land in quarantine + ack (anti-poison-pill).
- **Auto-execution drift:** handlers must NOT execute actions just because a fact arrived. The action-gate is opened by an explicit alex-approval fact AND the agent's own checks (e.g., CFO confirms the draft file matches the approved subject before sending).
- **Token leak blast radius:** same as publish — a leaked token can read (and ack) that one agent's inbox. Rotation is the existing mechanism. The Tailscale-only binding keeps tokens off the public internet.
- **Inbox growth:** acked deliveries stay in the `deliveries` table (audit). Periodic compaction is a separate concern; consumer-side pagination handles inbox size.

## 9. What this design explicitly does NOT do (scope boundary)
- **Doesn't replace the ndjson filesystem inbox** for v1. `board-drainer` keeps writing those (continuity for any current reader, observability). The gateway endpoints are the new path; ndjson is the audit trail / fallback.
- **Doesn't bridge to the mesh.** Agents that already process mesh A2A messages keep doing that. The gateway-consume path is for Board facts, not mesh deliveries. (When an agent acts and sends a result through the mesh, that's their existing flow; the Board records the resulting fact via `POST /publish`.)
- **Doesn't introduce decision-chaining.** Approving one fact does not transitively approve children. Each action requires its own explicit fact.

## 10. Sequencing
1. **Codex review THIS design** (security: auth-on-read, ack scoping, replay; correctness: ack idempotency, handler contract; contract: per-agent isolation).
2. Fold findings → **CA-internal DA**.
3. Build the gateway extensions + `board-consume-lib.js` + tests; full suite must stay green.
4. Build `board-consume-cfo.js` + handlers; deploy as pm2 sidecar on Mini.
5. **Verify on Alex's existing approvals**: his "Approve TDB May invoice" decision (fact `3d0f57e1`) reaches CFO's handler, CFO surfaces the draft as ready-to-send. End-to-end loop closes.
6. Iterate per agent. Retire the ca-mesh PATCH special case once Code Architect's consumer reads alex decisions the standard way.

## 11. Definition of done (v1)
A Board fact you approved on the supervisor view (CFO's TDB invoice draft) reaches CFO's gateway-consume handler within 30s; CFO acts on it (or surfaces the action) using its own logic, without any per-fact-type bridge wiring. The same path works the moment we register a handler for any other (agent, fact_type) pair.

# Design — Board Consume via Gateway (the read+ack half of the door)

**Status:** DESIGN v2 — Codex round 1 = REVISE (8 findings, **5 P0**), all folded in §"v2 fold" below. CA-internal DA on v2 next. Date: 2026-05-28.
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

---

## v2 fold — Codex round 1 (2026-05-28), all 8 findings

### Auth & scopes (Codex P0 #1)
- **`gateway_tokens` gains a `scopes` column** (JSON array). Allowed values: `publish`, `read`, `ack`, `act`. Default for the existing rows (idempotent migration): `["publish"]` — so today's tokens *cannot* read or ack until explicitly re-enrolled with broader scopes.
- `gateway-enroll.js` gains a `--scopes` flag (e.g. `--scopes=read,ack,act` for consumer agents).
- `GET /inbox` requires `read` scope on the token; `POST /ack/<id>` requires `ack`; the `act` scope (see #5) governs whether a handler is allowed to invoke an external action on Alex's behalf.
- **Client-bound token** (`token.client_id != null`) filters `/inbox` and `/ack` to deliveries whose **fact** has `client_id` matching the token's binding, OR `client_id IS NULL` (internal). Strict, additive to agent match.

### Claim/lease before handler executes (Codex P0 #2 — the action-amplification fix)
The original "GET then ack" pattern lets two consumers race. **Pure idempotent acks don't prevent double-sends.** Adding a claim phase:
- **New endpoint: `POST /claim/<delivery_id>`** — atomic UPDATE: `SET claimed_by=?, claimed_at=now() WHERE delivery_id=? AND recipient_agent=token.agent AND claimed_at IS NULL AND acked_at IS NULL`. Returns `200 {ok:true, lease_until}` on success, `409 {ok:false, claimed_by, lease_until}` on already-claimed.
- **Lease has a TTL** (default 5 min). After lease expires without ack, `claimed_at` is treated as null again so a crashed consumer's items reclaimable.
- **Consumer flow:** `GET /inbox` → for each delivery `POST /claim/<id>` → if 200, run handler; if 409, skip → on handler success `POST /ack/<id>` → on transient fail leave (lease will expire, retried next tick) → on permanent fail post to quarantine then ack.
- Adds two columns to `deliveries`: `claimed_by TEXT`, `claimed_at TEXT`. Idempotent migration via the existing `migrate()` pattern.
- **Per-agent action ledger** (`gateway_actions` table) records every external action a handler took, keyed by `(decision_fact_id, subject_fact_id, action_type)`. A handler MUST check the ledger before invoking the external action — even with claim/lease, this is the second wall against double-execution.

### Drainer / status semantics (Codex P0 #3)
The old `board-drainer` calls `drain()` which unconditionally sets `status='read'`. That breaks our `status != 'acked'` filter (drainer would resurrect acked deliveries as `read`). Fixes:
- **`/inbox` filter changes to `acked_at IS NULL`**, not a status check. Status mutations from the drainer no longer affect inbox membership.
- **Drainer's `drain()` is patched to guard:** `UPDATE deliveries SET status='read' WHERE delivery_id=? AND acked_at IS NULL`. (Surgical edit to the live `board-listener.js`; safe additive.) If a delivery is already acked, the drainer leaves it alone.
- **Better still — long-term:** stop the drainer from mutating delivery status at all. It only needs to *read* pending deliveries and append to ndjson; status changes belong to the gateway. Schedule that change for the consumer-rollout phase (after CFO is live on gateway-consume) so we don't disturb existing observability mid-build.

### Single executor per agent (Codex P0 #4)
- **No ndjson consumer runs alongside the gateway consumer for the same agent.** Today there are no ndjson *consumers* (the file is written, not read by any agent code), so this is preventive: the rollout contract for each agent is "stop any ndjson reader BEFORE starting the gateway consumer."
- **The drainer keeps writing ndjson** — that's pure audit/fallback, not a consumer. Clear in the spec: "drainer writes; only the gateway consumer reads and acts."
- **One pm2 process per `board-consume-<agent>`** — second instance refused by pm2's name uniqueness. The claim/lease in #2 makes a hypothetical accidental second instance safe even if the operator screws up.

### Supervisor-decision provenance (Codex P0 #5 — the forgery fix)
The lenient `board-publish.js` (which trusts CLI `--from`) and the mesh-bridge (which classifies messages as `decision`) mean **`fact_type='decision' AND source_agent='alex'` is not a strong enough authorization signal.** Fix:
- **New fact_type: `supervisor_decision`** — registered in `FACT_TYPES`, schema in `registry.js`. Payload contract:
  ```
  required: ['decision', 'subject_fact_id', 'supervisor_action_id']
  decision: enum ['approve','reject','dismiss']
  subject_fact_id: string (the fact being decided on)
  supervisor_action_id: string (UUID generated by the supervisor /action endpoint per click)
  rationale?: string
  ```
- **Only the supervisor's `/action` endpoint produces this fact type.** The gateway refuses any other source from posting `supervisor_decision` (enforced server-side: only the token *bound to identity 'alex'* with `scopes` including `supervise` may publish this `fact_type`).
- Handlers check for `supervisor_decision` (with the typed `decision: 'approve'` payload) — not for plain `decision` facts. Plain `decision` facts retain their existing semantic (an agent declaring a decision); they do NOT authorize action.
- **Defense in depth:** handlers MUST verify (a) the subject_fact_id was emitted by *this same agent* and (b) the action is registered as awaiting-approval in the agent's own state. If both pass, the supervisor_decision authorizes execution; the action ledger (#2) records the result.
- Migration: existing `decision` facts from `alex` (today's session) are NOT auto-promoted — they stay as audit-only. New approvals through the updated supervisor will produce `supervisor_decision` facts that handlers honor.

### Atomic ack (Codex P1 #6)
- **Ack UPDATE is conditional:** `UPDATE deliveries SET acked_at=?, acked_by=?, status='acked' WHERE delivery_id=? AND recipient_agent=? AND acked_at IS NULL`.
- If 0 rows affected → SELECT to determine: (a) delivery doesn't exist (404), (b) wrong recipient (403), (c) already acked by same agent (200, idempotent). First-writer-wins on `acked_by` and `acked_at`; subsequent acks are no-ops.

### Quarantine — durable, surfaced, distinct from ack (Codex P1 #7)
- **New `gateway_quarantine` table:** `(delivery_id, fact_id, agent, handler, error, ts, reviewed_at)` — persistent log of handler-permanent-failures.
- A permanent failure: write quarantine row → set `deliveries.status='dead'`, `dead_reason=<handler error>` → **do NOT ack**. Dead deliveries don't appear in `/inbox` (we already exclude `status='dead'`) but they're distinct from acked, surface separately.
- **Supervisor view surfaces the quarantine count** as part of "What needs you" or a dedicated row. Operator can click to review and either retry (un-quarantine + reset status to 'pending') or confirm-dead. Closes the human-review loop.

### Pagination, ordering, starvation (Codex P2 #8)
- **Order:** `ORDER BY created_at ASC, delivery_id ASC` — deterministic on ties.
- **Page semantics:** handler-failure on one delivery does NOT stop processing the page; consumer iterates all returned deliveries, ack/claim each independently.
- **Retry policy:** `deliveries.delivery_attempts` already exists (from the schema). Increment on transient handler failures. After N attempts (default 5), promote to quarantine + dead.

---

## §10b — Codex-review surface for the BUILT CODE (per Alex's "include codex in the build")
The above is the design. Code-level Codex passes are scoped to:
1. **Gateway extensions** (`board-gateway.js` additions): scope check coverage, atomic SQL, the supervisor-decision publish guard, claim/lease TTL, idempotent migrations, no fact-type smuggling.
2. **`board-consume-lib.js`**: claim-then-handler-then-ack ordering, transient vs permanent classification, action-ledger check before external invocation, no auto-execution paths.
3. **First per-agent handler (CFO)**: subject-fact-belongs-to-me check, supervisor_decision-payload-shape check, action-ledger write before external send, handler returns shape conformance.

---

## §10c — CA-internal DA verdict on v2 — **PASS with 5 binding conditions** (2026-05-28)

Adversarial self-review of the Codex-folded v2 surfaced five additional constraints that *must* land in the implementation. None block the v2 design — they refine it.

- **DA-a (CRITICAL — supervisor `/action` must itself authenticate before publishing `supervisor_decision`).** The fold (#5) makes `supervisor_decision` the only authorization-grade fact, gated by the token bound to identity `alex`. But the supervisor's `POST /action` endpoint *currently has no auth* — any device on the tailnet can POST to it. v2 must add: (a) require an env-set `SUPERVISOR_TOKEN` header on `/action`, (b) the supervisor reads this from `~/.kameha/supervisor.token` (0600), (c) the served page embeds the token in the click JS (server-rendered, never exposed in source URL). Without this, any tailnet device could forge "Alex approved X" today. Tailscale ACLs are belt-and-braces, not the primary gate.

- **DA-b (action ledger ambiguity policy).** The `gateway_actions` ledger records *intent* before the external action runs. Network-timeout on the external API (e.g. QuickBooks send-invoice) means: did it complete or not? The ledger row must be `status='intent'` pre-call, `'completed'` post-success, `'failed'` post-known-failure, **`'ambiguous'` on timeout/uncertainty.** The consumer must NOT retry an ambiguous row; it must surface for operator review (same quarantine UX). This is at-most-once external semantics with explicit human reconciliation — the only honest pattern.

- **DA-c (today's existing alex `decision` facts are audit-only — confirm + announce).** This session produced ~10 `decision` facts from alex via the supervisor (which only knew about plain `decision`, not the new `supervisor_decision`). Codex #5's fix means handlers must NOT honor those as authorizations. Operator (Alex) may need to re-approve via the updated supervisor for any of those clicks to actually trigger downstream action. State this *in the v2 deploy notes* so it's not a surprise.

- **DA-d (lease TTL specification — slow handlers).** Default 5 min is fine for invoice sends; a Framer carousel render or a long-running CFO reconciliation may exceed. Spec:
  - `POST /claim/<id>` supports optional `?lease=<seconds>` (cap 1800 = 30 min).
  - `POST /claim/<id>` on an already-self-claimed delivery acts as a *renewal*: bumps `claimed_at` to now, returns the new `lease_until`. Other agents still see 409.
  - Document handlers' obligation to either pick the right lease at claim time or renew before expiry.

- **DA-e (`gateway_actions` schema — fully specified).** Concrete: `gateway_actions(decision_fact_id TEXT NOT NULL, subject_fact_id TEXT NOT NULL, action_type TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('intent','completed','failed','ambiguous')), agent TEXT NOT NULL, ts TEXT NOT NULL, error TEXT, ext_ref TEXT, PRIMARY KEY(decision_fact_id, subject_fact_id, action_type))`. `ext_ref` records the external system's receipt/ID where applicable (QuickBooks invoice id, send receipt id, etc.) for human reconciliation.

**Verdict:** PASS to build with DA-a through DA-e as binding implementation constraints. Re-audit against them before deploy.

---

## §10d — CODE-REVIEW fold — Codex code-level round 1 → REVISE, all 5 folded (2026-05-29)

Codex reviewed the BUILT Phase-2 code (not the design) and returned **REVISE** with 5 findings (2 P0, 2 P1, 1 P2). All folded; gateway suite green (36/36, incl. new coverage Codex named). Nothing was deployed — Phase 2 sat behind this gate.

- **P0 #1 — client scope missing on claim/ack/quarantine.** `/inbox` scoped by `fact.client_id`, but the delivery-id endpoints only checked `recipient_agent`, so a client-bound token could act on another client's delivery by id. **Fix:** added a shared `clientAllowed(tokenRow, fact.client_id)` check (JOIN `facts`) to `handleClaim`/`handleAck`/`handleQuarantine` → 403 cross-client. Tests: cross-client claim/ack/quarantine denial + matching-client sanity.
- **P0 #2 — `supervisor_decision` forgeable via raw write paths.** `board-publish.js` (trusts `--from`) and core `writeFact`/`shared-layer` accepted `supervisor_decision` with no gateway/supervise check; a forged "alex approved X" persisted + routed. **Fix:** `AUTH_GRADE_TYPES` set in shared-layer; `writeFact` refuses auth-grade types unless `opts.privileged`; gateway `handlePublish` passes `{privileged:true}` only after its alex+supervise gate; `writeFactValidated` forwards `opts`; `board-publish.js` rejects auth-grade types outright. Verified: raw `writeFact`, `writeFactValidated`, and the CLI all refused; privileged gateway path persists.
- **P1 #3 — ack could resurrect a dead/quarantined delivery.** `handleAck` guarded only `acked_at IS NULL`. **Fix:** added `AND COALESCE(status,'pending') != 'dead'` to the ack UPDATE + a 410 for dead rows in both pre-check and disambiguation. Test: ack-after-quarantine stays `dead`, returns 410.
- **P1 #4 — claim not a true single-executor lock for same-agent duplicates.** Same-agent claims were always treated as renewal, so two `board-consume-<agent>` instances could both claim+run. **Fix:** added a per-instance `claim_id` column; fresh/expired claims mint a server-issued `claim_id` via compare-and-swap UPDATE; renewal requires the matching `claim_id`; any other claimant (incl. same agent, different/no claim_id) gets 409 while the lease is live. Tests updated + added.
- **P2 #5 — malformed scopes failed open to publish.** `tokenScopes` returned publish-only on JSON parse error. **Fix:** null/absent = legacy publish-only (intended); malformed non-null (parse error or non-array) = **deny all**; unknown scope strings filtered. Test: garbage scopes denies publish + read; legacy null stays publish-only.

**Status (round 1):** folded + green → re-submit to Codex (round 2).

### Code-review round 2 (2026-05-29) → REVISE, 1 P2, folded
Codex confirmed all 5 round-1 fixes closed, and found one remaining starvation bug:
- **P2 — client-bound `/inbox` could starve behind older other-client rows.** The client predicate was a *post-query JS filter* applied AFTER `LIMIT`, so a client-bound token whose allowed rows sort after a full page of other-client rows got an empty page (reproduced: 60 `tdb` + 1 `dagdc`, `limit=50` → count 0). **Fix:** moved the client predicate into the SQL `WHERE` (`AND (? IS NULL OR f.client_id = ? OR f.client_id IS NULL)`) before `ORDER/LIMIT`; removed the JS filter. Unbound token binds NULL → all rows. Regression test added (60 older other-client rows before an allowed one, limit 50 → allowed row still surfaces). Suite 37/37 green.

**Status:** round 1 + round 2 folded, 37/37 green → CA-internal DA re-audit done (below) → Codex round 3 confirm → deploy on READY.

## §10e — CA-internal DA re-audit of the full fold (2026-05-29) — PASS, 1 hardening applied

Adversarial re-review of all six fixes (rounds 1+2). Findings re-verified closed: client scope (incl. the SQL-pushdown that also fixed starvation), the supervisor_decision back-door across CLI/raw/validated paths, ack-no-resurrect-dead, per-instance claim CAS (claim_id is a 122-bit server UUID; guessing is infeasible and cross-agent is blocked by the recipient check anyway), malformed-scopes fail-closed.

- **DA-f (hardening, applied) — privilege grant must be scoped to GATED types.** The forgery gate was hard-coded to `fact.fact_type === 'supervisor_decision'` while `writeFactValidated` was called with a blanket `{ privileged: true }`. Safe today (one auth-grade type, gated), but a future auth-grade type would inherit `privileged` WITHOUT a supervise gate. **Fix:** gate generalized over `AUTH_GRADE_TYPES`; `privileged` is now `AUTH_GRADE_TYPES.has(fact_type)` — true only for types that just passed the alex+supervise gate. Behavior-preserving for supervisor_decision (37/37 green); closes the latent footgun.

**Verdict:** PASS. Auth posture sound; per-instance lock sound; isolation sound. Ready for Codex round 3 confirm → deploy.

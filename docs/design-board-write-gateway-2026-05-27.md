# Design — The Board Write Gateway ("the door") · Option A · **v2 (Codex REVISE folded)**

**Status:** DESIGN v2 — Codex round 1 = REVISE (8 findings, all folded below). CA-internal DA recorded in §10. Build after DA passes.
**Classification:** T3, DA-mandatory — net-new mesh-contract surface; a network endpoint that *writes* the Board; auth/identity/credentials involved.
**Origin:** the laptop↔Mini wall ([[reference_laptop_mini_board_wall]]); the concrete "type a fact once, propagate" path ([[project_cross_agent_info_sharing_goal]]).

---

## 0. Problem in one line
The Board is `SQLite` on the Mini; `SQLite` can't be written across a network. A laptop-side feed has no way to publish. We need a thin, **authenticated, identity-bound** HTTP write endpoint on the Mini that writes through the repo's **already-authenticated** door — not the lenient core.

## 1. Shape (write sibling to the read-only ledger)
- **Process:** `board-gateway.js`, `pm2 --name board-gateway`, port **3351**.
- **Binding (Codex #6):** bind to the **Tailscale IP only** (`100.64.114.13`) — never `0.0.0.0`, never a public/loopback fallback. If the interface isn't up at boot (`EADDRNOTAVAIL`), **retry with backoff + log/alert** — do NOT crashloop and do NOT fall back to a broader bind.
- **Endpoints:** `POST /publish` · `GET /health` (liveness only — no DB contents, no internals).

## 2. The authenticated write path — REVISED
This is the heart of the Codex revision. **The gateway does NOT trust body `source_agent`/`client_id`, and does NOT call the lenient `writeFactValidated` directly.**

**Identity model (Codex #1) — token-bound identity (proportionate v1):**
- Each caller holds a **per-agent bearer token**. The Mini keeps a token registry: `gateway_tokens(token_hash, agent, created_at, active)` — store only a **hash** of the token (never the token itself), 0600.
- On `/publish`: resolve token → `agent`. **The gateway sets `source_agent = <that agent>` server-side and ignores any `source_agent` in the body.** A token = proof of that one identity.
- Then enforce authz by reusing `identity.js` `authzProduce(identity, fact)` against the `identities` row for that agent (allowed `fact_types` + client binding). Unregistered/unauthorized → reject.
- **Upgrade path (stronger):** when agent private keys are distributed to where hooks run, callers can instead **sign** the fact and the gateway calls `writeSignedFact(db, fact, sig)` for end-to-end (transport-independent) identity. v1 uses token-binding (no private keys off the Mini — consistent with the deferred hard-identity posture, [[feedback_multi_user_mini_deferred]]); signing is the documented next increment.

**Envelope validation (Codex #2) — before any DB access:**
A dedicated `validateEnvelope(body)` (new) that the registry does NOT cover:
- Required: `fact_type`, `visibility`, `payload`. `data_class` ∈ {internal, client_confidential, …} (enum). `client_id` against a known-clients allowlist when present. `subject_type/subject_id/observed_at` type+format checks (ISO-8601 for dates). Max string lengths, max object depth/size.
- **Reject unknown top-level keys**, and **guard prototype-pollution** (`__proto__`/`constructor`/`prototype` keys) before the body reaches the validator or sqlite params.
- Construct a **sanitized fact object** from allowlisted fields only — never pass the raw body through.

**Order at the door:** auth (token→agent) → envelope-validate + sanitize → set server-side `source_agent` → `authzProduce` → `writeFactValidated` (payload schema) → core `writeFact` (parameterized `prepare()`, existing). Reject at the earliest failing gate; nothing persists on reject.

## 3. Idempotency — REVISED (Codex #3)
`gateway_idem(key TEXT, agent TEXT, request_hash TEXT, response_json TEXT, ts TEXT, PRIMARY KEY(agent, key))`:
- Key is **scoped by authenticated agent** (no cross-agent key collisions).
- The idempotency **reservation + the fact write happen in ONE transaction** (`withTx`) — no check-then-insert race.
- Same `(agent,key)` + same `request_hash` → return the **cached response** (no second write). Same key + **different** hash → **409 Conflict**.
- TTL + periodic cleanup of old rows (bounded growth — ties to #7).

## 4. Single-writer discipline — REVISED (Codex #4)
WAL still permits only one writer; the drainer was built to avoid N writers. So:
- **Exactly one** `board-gateway` process. Keep transactions short.
- **Confirm PRAGMAs at startup** (assert WAL + busy_timeout actually took — do NOT rely on `db.js`'s best-effort swallow); fail startup if not.
- Wrap writes in a **`SQLITE_BUSY` retry/backoff** helper.
- **Target architecture:** make the gateway the **single Board write owner** — migrate the existing local writers (`board-emit-cfo`, `board-sync`, `board-publish`) to POST through it too (via `board-post.js` loopback). v1 ships the gateway as the network writer + busy-retry; the consolidation is the immediate follow-on so the Board has exactly one write path again.

## 5. Token handling — fail-closed (Codex #5)
- On startup: if the token registry is **missing, empty, world-readable (not 0600), or holds a too-short token → refuse to start `/publish`** (serve `503` only). Fail closed, never open.
- Compare via `crypto.timingSafeEqual` on **equal-length hashes** (hash incoming token, compare to stored hash).
- **Never log token material** (HB#9). Support **dual-token rotation** (old+new valid during a window).

## 6. Abuse / limits (Codex #7)
Body-size cap (e.g. 64KB → `413`); server `headersTimeout` + `requestTimeout` + socket timeout (slow-loris); **per-token rate limit** (`429`); idempotency-table TTL cleanup; reject valid-but-junk floods via the rate limit.

## 7. Error handling (Codex #8)
Generic client text only — **no stack traces, paths, SQL, or token details** (the read-only ledger renders raw errors in HTML; the gateway must NOT). Status codes: malformed JSON `400`, too large `413`, auth `401`, schema/authz `4xx`, busy `503`, rate `429`. Details go only to a **structured Mini-local log**. *(Minor follow-up: harden `board-ledger.js`'s raw-error HTML too — out of scope here.)*

## 8. The laptop side
`board-post.js` (shared client): reads the agent's token, `POST /publish` with `idempotency_key` + retry. Emit hooks gain a `BOARD_URL` mode (POST instead of `openDb`). Hooks then run **on the laptop, where the work is**, and the Board fills regardless of machine.

## 9. Action-gate (Codex: READY) — preserved
Publishing a fact only inserts + routes + (drainer) appends to inbox. The gateway **must not call any agent handler**. A `work_order`/`task`/`question` posted via the door stays inert until an agent's gated handler acts ([[spec-board-consumption-contract]]). Publish ≠ act.

## 10. CA-internal DA verdict — **PASSED with conditions** (2026-05-27)
Adversarial self-review of v2. The Codex findings are folded and the design is sound to build, subject to these **DEFERRED-TO-IMPL conditions** (must be honored in code):
- **DA-a (token scope source):** `gateway_tokens` must carry the agent's authz scope itself (`agent`, `client_id`, `can_produce`) so the gateway does NOT depend on the `identities` table being enrolled on the live Mini DB (verify enrollment state before relying on `authzProduce`; if absent, the token row is the authority). Don't assume identities are populated.
- **DA-b (replay):** token-bound requests are replayable by a tailnet-positioned attacker; `idempotency_key` only dedupes *identical* retries. v1 accepts this (Tailscale transport encryption + bounded enrolled callers); nonce + seen-window is a noted roadmap item (matches `identity.js` deferral). State the residual explicitly.
- **DA-c (clients allowlist source):** the envelope `client_id` allowlist must derive from a real source (existing subscriptions/known clients), not a hardcoded guess — or reject `client_id` not seen in subscriptions.
- **DA-d (partial single-writer until consolidation):** until local writers are migrated through the gateway (§4), multiple writers persist; the gateway carries `SQLITE_BUSY` retry, the others rely on `busy_timeout` (pre-existing). Acceptable for v1; consolidation is the immediate follow-on, not optional-forever.
- **DA-e (no handler calls):** assert in code/tests that the gateway never imports or invokes an agent handler — publish path only (§9).
**Verdict:** PASS to build with DA-a…e as binding implementation constraints; re-audit against them before deploy.

## 11. Sequencing
1. ✅ Codex round 1 (REVISE → folded into this v2).
2. CA-internal DA on v2 → record verdict (§10).
3. Build `validateEnvelope` + token registry + `gateway_idem` + `board-gateway.js` + `board-post.js`; test locally on loopback with the registry + identities table.
4. (gated) Deploy to Mini: enroll per-agent tokens (0600), pm2 + Tailscale bind, `GET /health`, one authenticated test publish from the **laptop** → re-audit the Board.
5. Point `board-emit-cfo.js` at `BOARD_URL`; prove laptop→Board end-to-end; then migrate the other local writers through the gateway (#4 consolidation).

## 12. Definition of done (v1)
A fact posted from the **laptop**, authenticated + identity-bound + envelope+schema validated, appears on the Board within a drainer tick; body `source_agent` cannot spoof another agent; no new "database is locked"; bad/unauthorized input rejected cleanly with no internal leakage; nothing auto-executes.

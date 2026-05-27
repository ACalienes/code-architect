# Codex prompt — review the Board Write Gateway design ("the door")

You are reviewing a **design**, not a finished patch. This is a **network endpoint that writes the Board** (a SQLite-backed cross-agent fact store) — so weight security and correctness heavily. Verdict: **READY** or **REVISE** with specific, actionable findings. Be adversarial; the last several reviews of this system each found real bugs.

## System context (read the code, don't assume)
"The Board" = cross-agent typed-fact store on one SQLite file (`~/.kameha/kameha-mesh.db`) on a single-user Mac Mini (all agents run as unix `kai`), reachable over Tailscale. Authoritative files in this repo:
- `prototype/shared-layer/shared-layer.js` — `writeFact()` (preflight → INSERT fact → `route()` → `deliveries`), schema, `openDb()` (sets WAL).
- `prototype/shared-layer/registry.js` — `writeFactValidated()` + `defaultRegistry` (per-fact-type payload schemas; now includes objective/question/task). The validation layer the gateway reuses.
- `prototype/shared-layer/db.js` — `openDatabase()` sets `journal_mode=WAL; busy_timeout=5000; synchronous=NORMAL`.
- `prototype/shared-layer/board-ledger.js` — the existing read-only HTTP server (`node:http`, port 3350, Tailscale). The gateway is its **write** sibling.
- `prototype/shared-layer/board-publish.js`, `board-sync.js`, `board-emit-cfo.js` — existing LOCAL writers of the Board (so the DB is already multi-writer).
- Design under review: `docs/design-board-write-gateway-2026-05-27.md`.

## What's proposed
A `board-gateway.js` process (pm2, port 3351, **bound to the Tailscale IP only**) exposing `POST /publish` + `GET /health`. `/publish`: Bearer-token auth (token in `~/.kameha/board-gateway.token`, 0600, constant-time compare) → body-size cap → `writeFactValidated(db, fact, defaultRegistry)` → unchanged `writeFact` path → `{ok, fact_id, routed}`. Optional `idempotency_key` deduped via a `gateway_idem` table. Laptop-side emit hooks gain a `BOARD_URL` mode (POST instead of local `openDb`) via a shared `board-post.js` client. Purpose: let feeds running on the laptop publish to the Mini-hosted Board.

## Specifically probe these
- **Auth:** is Bearer-token + Tailscale-only binding sufficient for a write endpoint, given all agents are one unix user and the tailnet is the trust boundary? Constant-time compare correctness. What if the token file is missing/empty — does it fail CLOSED (refuse all) or open? Should `/publish` require TLS, or is Tailscale's transport encryption enough? Token rotation/leakage blast radius.
- **Binding:** does binding to `100.64.114.13` actually exclude loopback/public, and what happens if Tailscale is down at boot (bind fails → crashloop)? Is `0.0.0.0` + firewall safer or worse than interface-bind?
- **Input validation / injection:** the body becomes a fact. Are `fact_type`, `visibility`, `client_id`, `source_agent`, `payload` all constrained? Can a caller forge `source_agent` (spoof another agent's identity on the Board)? Should the gateway bind identity to the token rather than trust body `source_agent`? Any SQL/JSON/path injection through payload? Prototype-pollution via JSON keys (e.g. `__proto__`) reaching the registry validator or sqlite params?
- **Idempotency:** is the `gateway_idem` design correct under concurrent duplicate POSTs (race between check and insert)? Key scope (who picks it, collision risk), TTL/cleanup, and behavior when the same key arrives with a *different* body.
- **Contention / single-writer:** adding another writer to `kameha-mesh.db` — does WAL+busy_timeout genuinely cover it alongside the drainer's status writes, or can `/publish` and the drainer deadlock/`SQLITE_BUSY`? Should writes serialize through one in-process queue?
- **Abuse / DoS:** body-size cap, slow-loris, unbounded `gateway_idem` growth, a flood of valid-but-junk facts polluting the Board/ledger. Rate limiting?
- **Action-gate boundary:** confirm publishing a fact via the gateway cannot trigger any action (publish ≠ act). A `work_order`/`task` posted via the door must still be inert until an agent's gated handler acts.
- **Error handling:** does the response leak internal paths/stack/SQL on error? Does a malformed body crash the process or return 400?

## Return
Verdict (READY/REVISE) + numbered findings (severity, concrete fix). Flag anything that would let an unauthorized or spoofed write reach the Board, reintroduce "database is locked", or leak the token.

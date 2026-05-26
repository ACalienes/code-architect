# Shared Layer — deployment runbook (Mini cutover)

**Code Architect · 2026-05-25 · session 6.** The reference spine is complete and green (222 checks,
11 suites, `prototype/shared-layer/`). This is the plan to take it live on the Mac Mini. **Nothing
here is executed yet** — every step is gated on Alex's go-ahead, and the cross-repo / live-infra steps
are T2/T3. This doc is what Kai needs to deploy.

## Decisions in force (from session 5, BLESSED)

- The Shared Layer is the ONE canonical system; mesh-api gets a thin compat adapter for the live
  ACD↔Kai loop + a sunset date (clean cutover, not a gradual drag).
- Dedicated `kameha-mesh.db` on the Mini (NOT extending conductor.db — blast radius + isolation).
- Isolation is structural (delivery split) + physical (per-client files) + identity-enforced.

## Single-user Mini reality + confirmed pilot posture (2026-05-26)

Kai verified on the box: **the Mini is single-user.** Every agent (Kai, mesh-api, Chronicle, Lead
Engine, Enso, Framer, PDE, all client repos) runs as the one unix user `kai` under one PM2 daemon —
there are **no per-agent or per-client unix users**. A file owned by `kai` is readable by every `kai`
process, so the OS cannot enforce a boundary between agents. This collapses the *enforcement* premise
(below) but **not** the design — it just splits what's real now from what's deferred.

**Confirmed posture (Alex, 2026-05-26): SHIP NOW on the soft boundary; defer the hard wall.**

- **Pilot isolation = logical scoping (the router writes each client only its own deliveries) + signed
  *integrity* (tamper-evidence, attribution, authz client-binding the router enforces), among trusted
  first-party agents.** NOT OS-enforced against a compromised co-resident process. State this plainly;
  don't mistake the soft boundary for the hard one.
- **D1 — key custody:** `~/.kameha/keys/<agent>.key` (`0600`, dir `0700`), path in each agent's env via
  `ecosystem.config.js`. Organizationally correct + **chown-ready** (real wall when users split). Soft
  today (all agents are `kai`).
- **D2 — DB:** `~/.kameha/mesh/kameha-mesh.db` (own `mesh/` subdir at `0700` so the existing `0755`
  `~/.kameha` conductor.db isn't touched); db + `-wal`/`-shm` `0600`; owned by `kai` (the trusted writer
  = router + projector under the same PM2). `0700/0600` is the correct target; "denied to agent users"
  is not enforceable until users split.
- **D3 — distinct unix users/groups:** NO, not today. The **physical per-client projection layer
  (rounds 4–5) is DEFERRED with the OS wall** — it buys no isolation on a single-user box. The pilot
  runs WITHOUT physical projections: **client repos drain their own scoped deliveries from central**
  (the logical delivery-split, same path internal agents use). The projection code stays in the repo,
  dormant + chown-ready; it switches on as step one of the separate **"multi-user Mini" project** (new
  users/groups, re-chown repos/DB/logs, per-user pm2, key redistribution, unforgeable identity). That
  restructure is its own gated project — it must NOT ride behind the pilot (downtime risk post-OAuth-outage).

So §6 (physical projections + chown) and the per-uid parts of §2/§3 are **deferred to the multi-user
project**; the pilot follows the trimmed sequence at the end of this doc.

## Trust boundary (the enforcement — Codex REVISE)

JS cannot hide an export, so isolation/auth is NOT enforced by hiding functions — it is enforced by the
**process boundary**: only the **trusted service process** holds the `kameha-mesh.db` handle and imports
the core primitives (lenient `writeFact`/`subscribe`, the router, the projector). Agents run as
**separate processes** and can reach the layer ONLY through the hardened door — they submit *signed*
facts (`writeSignedFact`) and *authorized* subscriptions (`authorizeSubscribe`); they never get the db
handle. The facade (`index.js`) is the agent-facing surface and exposes no lenient/raw write. The mesh
adapter is the single legacy ingress and now **signs** (no unsigned path); claim promotion is
schema-gated. Deploy must preserve this: do not hand an agent process the central db handle.

## 0. Pre-deploy gate (do first)

- **Run the 7 Codex prompts** (`docs/codex-prompt-shared-layer-*.md`) against the PORTED code, not the
  prototype — fold any REVISE findings before go-live. This is the deferred review (per the agreed
  "Codex at pre-deploy, not on throwaway prototype specifics").
- Confirm Node 20+/better-sqlite3 on the Mini.

## 1. Port node:sqlite → better-sqlite3 (near-verbatim)

The prototype uses the built-in `node:sqlite` for zero-install demonstrability. The query surface
(`prepare().run()/.get()/.all()`) is identical to better-sqlite3. The only changes:

```js
// prototype:  const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(path);
// Mini:       const Database = require('better-sqlite3'); const db = new Database(path);
```
- `db.exec(...)`, `prepare(...).run/get/all(...)` are unchanged.
- WAL pragma identical (`PRAGMA journal_mode = WAL`) for central; projections keep `DELETE`.
- Wrap the open in one `openDatabase(path)` shim so the 9 modules stay driver-agnostic.
- `node:crypto` (Ed25519) is the same on both — no change to `identity.js`.

## 2. Stand up `kameha-mesh.db` + schema

- Create on the Mini (path TBD with Kai, e.g. `~/.kameha/kameha-mesh.db`), owned by the trusted
  runner/projector user.
- **OS-permission gate (Codex round 4 — ownership alone is not enough):** the DB's directory, the
  `kameha-mesh.db` file, AND its `-wal`/`-shm` sidecars must be mode-denied to agent users — dir `0700`,
  files `0600`, owned by the trusted user. The process boundary is only load-bearing if no agent uid can
  open the central DB or its sidecars directly. Verify after creation (`ls -la`).
- `applySchema(db)` builds the core tables; `ensureClaimsTable`/`ensureHeartbeatTable`/
  `ensureIdentitiesTable`/`ensureSeenTable` are lazy — they self-create on first use.
- `schema_version: 1` is the migration anchor (per CLAUDE.md).

## 3. Enrollment (identities) — privileged ADMIN surface, T3

- For each agent (kai, acd, nami, framer, enso, cfo, conductor, offer-architect, lead-engine,
  code-architect, **mesh-adapter** (the legacy bridge), + client repos dag-repo/tdb-repo) generate an
  Ed25519 keypair. `enroll.js` (`FLEET_ROSTER`) does all of this; `mesh-adapter` is included.
- Enrollment runs via the **admin surface only** (`createAdminLayer(db)`), which is NOT exposed on the
  agent-facing facade — an agent reaching the facade cannot register/replace an identity.
- Enrollment is **insert-only**: re-registering an existing agent is REFUSED; replacing a key requires
  an explicit `rotateIdentity` ceremony (audited). This stops silent key-takeover.
- `registerIdentity` stores **public keys only**; client repos get `clientId` set (bound), internal
  agents (incl. `mesh-adapter`) leave it null.
- **Private-key custody (T3, needs Alex):** each agent holds its own private key (env/secret store),
  NEVER in kameha-mesh.db or any log. `mesh-adapter`'s key goes to the trusted bridge process. Decide
  the custody mechanism with Kai; then `node enroll.js --db <kameha-mesh.db> --keys <keystore>` and
  distribute + delete the keystore.

## 4. Subscriptions

- `authorizeSubscribe(db, agent, fact_type, scope)` per the routing map. Internal agents → `*`;
  client repos → their own client_id only (the layer refuses anything else).

## 5. Per-agent drainers (the always-on loop)

- Each agent runs a drainer (pm2 process or cron tick). Internal agents drain central; client repos
  drain their **own projection file**.
- Wire `onTick → recordHeartbeat` for liveness (the facade's `drainer()` does this).
- `signalWake` from the router/projector after delivery → near-immediate latency; ~60s is the heartbeat.

## 6. Per-client physical projections + ownership (the cross-uid step)

- The projector creates `<projections>/<agent>/` **private up front** (mode set before the db file is
  created — closed the temporary read window Codex flagged), writes `inbox.db`, then chmods.
- **Ownership model (Codex round 4 — a client-WRITABLE projection dir is unsafe):** giving the client
  group write on the projection dir (the round-3 `2770`) let a compromised client replace its `inbox.db`
  with a **symlink to another client's file**, so the projector would write its data through the link →
  cross-client leak. Fix: **the client NEVER writes the projection.** Single writer = the projector; the
  client reads, and acks into its OWN separate ack-store.
  - Pre-create each `<projections>/<agent>/` at deploy: `chown projector:<client-group>`, `chmod 2750`
    (owner rwx, group **r-x — NO write**, setgid so files are born in `<client-group>`), `other` none.
  - Projector writes `inbox.db` `0640` (owner rw, group r). The client (group) can READ + traverse but
    canNOT create/replace entries in the dir → no symlink/file-swap.
  - The client drainer reads the read-only projection and acks into a **client-owned ack-store** in the
    client's own area (`createSharedLayer.clientDrainer(agent, projectionFile, handler, { ackFile })`).
    Ack-state lives where only the client can write; the projection tree is never client-writable.
  - The projector also `lstat`-guards `inbox.db`/dir each cycle and refuses to open a symlink
    (defense in depth — `projection_refused_symlink`).
- This cross-uid denial is THE step that turns content isolation into OS-enforced isolation; the
  in-process prototype proves content + timing + the refusal guard, not cross-uid. Confirm the client
  repos run as distinct unix users/groups with Kai.

## 7. The live ACD↔Kai loop (compat adapter, #7)

- Point the one live loop's mesh-api traffic through `adapter-mesh.ingestEnvelope` (trusted ingress;
  inherits mesh-api's auth, unsigned — see the adapter's TRUST BOUNDARY note). Outbound to any
  not-yet-migrated consumer via `envelopeFromFact`.
- Map the loop's real actions in the action→fact_type whitelist.

## 8. mesh-api sunset

- Once ACD + Kai send/receive signed facts natively (writeSignedFact), remove the adapter and
  **set a sunset date** for mesh-api. Until then it's the single legacy ingress, nothing else.
- Re-audit (don't trust): confirm via `health()` that legacy traffic is flowing as facts before sunset.

## 9. Observability

- Cron `health-dashboard.js` (ported) → publish the HTML somewhere Alex sees it; alert on any
  `critical` (isolation refusal, stale dead-letter, wedged agent).

## 10. Rollout sequence — SINGLE-USER PILOT (trimmed; each step = an Alex go-ahead)

Codex rounds are done (5, folded). Physical projections + per-uid perms are DEFERRED to the multi-user
project (see the 2026-05-26 section). The pilot:

1. Port to better-sqlite3 + stand up `~/.kameha/mesh/kameha-mesh.db` (§1–2, single-user perms). *[Kai, on the Mini]*
2. `enroll.js` → keys to `~/.kameha/keys/` (`0600`); register public keys + authorized subscriptions. *[Kai]*
3. Run the integration capstone against a STAGING copy on the Mini (sanity on the real driver). *[Kai]*
4. Wire ONE internal pair (e.g. DAG-fact → ACD) through the signed door + logical delivery-split; watch
   the health dashboard (run WITH any projection paths once they exist — N/A this pilot). *[Kai + CA reference]*
5. Add NAMI; run the real **DAG → ACD/NAMI** pilot on logical scoping + signed integrity. *[pilot]*
6. (optional) bridge the ACD↔Kai legacy loop through the signed adapter; set a mesh-api sunset date.

**Deferred → the "multi-user Mini" project (its own gated effort):** per-agent/-client unix users,
re-chown of repos/DB/logs, per-user pm2, key redistribution → switches on the physical projection layer
(§6) + unforgeable identity. No code redesign; it's chown-ready.

**Rollback:** the layer is additive; the legacy mesh-api stays up — at any step, stop the new drainers
and the old path still works. No destructive cutover.

## What needs Alex / Kai specifically

- ✅ **D1/D2/D3 decided** (2026-05-26): keys `~/.kameha/keys/`, db `~/.kameha/mesh/kameha-mesh.db`,
  single-user pilot (physical wall deferred).
- The live ACD↔Kai loop's real **action vocabulary** (for the optional adapter step).
- **Go-ahead at each rollout step**; Kai executes the Mini-side standup, CA verifies by re-audit.
- Commits are pushed (`ACalienes/code-architect`, through `6b139d8`).

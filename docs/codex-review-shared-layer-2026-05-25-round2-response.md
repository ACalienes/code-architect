# Codex MASTER re-review (round 2) — verdict + how it was addressed

**Verdict received: REVISE** (2026-05-25, round 2). Codex confirmed the three round-1 fixes are
genuinely closed and independently ran every suite on both drivers. Six Must-Fix items remained
(boundary/composition, not test-count). All six addressed below. Re-run after fixes: **248 checks
across 12 suites, green on node:sqlite AND better-sqlite3** (notify fs.watch test de-flaked).

## Must-Fix — all addressed

1. **(Critical) Privileged enrollment on the agent facade + overwrite-based.**
   - Enrollment is now an **admin-only surface** (`createAdminLayer(db)`), NOT on `createSharedLayer`
     — an agent reaching the facade has no `registerIdentity`/`rotateIdentity` (guarded by index.test §4).
   - `registerIdentity` is **insert-only**; re-registering an existing agent is REFUSED unless an
     explicit `rotateIdentity` (`rotate:true`) ceremony is used (audited). Closes silent key-takeover.

2. **(High) Projection permissions applied after populate (temp read window).**
   - The client dir is now created **private up front** (`mode` set + chmod *before* the db file is
     created), so `inbox.db` is born inside an already-locked dir — window closed.
   - Runbook §6 now specifies a concrete **ownership model**: projector-owns / client-group-reads,
     dir `0750` / file `0640`, `chown projector:<client-group>` — so the projector can rewrite while
     only that client's group reads, and `other` (and other clients) are denied.

3. **(High) Direct adapter usage could bypass schema (registry optional).**
   - The adapter now **defaults `registry` to `defaultRegistry`**, and the signed-write door
     (`writeSignedFact`) also **defaults schema ON**. A malformed legacy payload is rejected even when
     no registry is passed (proven by adapter-mesh.test §7 with no registry arg).

4. **(High) Validators too permissive.**
   - Registry: the `_`-bypass is now a **named allowlist** (`META_KEYS`); an arbitrary `_api_key` is
     rejected as an unexpected property (registry.test).
   - Scrub: now redacts by **sensitive field name** (`password`, `client_secret`, `token`, …) in
     addition to value patterns, so `{ password: "hunter2supersecret" }` is redacted (backfill.test).

5. **(High) Multi-step durable writes not transactional.**
   - Added a re-entrant `withTx(db, fn)` (db.js). `writeFact` (fact INSERT + route), `revoke`,
     `promoteClaim` (write + claim status), and the adapter (`writeSignedFact` + `mesh_seen`) now each
     commit atomically — a crash can't leave an orphan/duplicate/replayable fact. Re-entrancy lets the
     nested composition (promote → validated → core) share one outer transaction.

6. **(Medium) Adapter identity not in the enrollment path.**
   - `mesh-adapter` added to `enroll.js` `FLEET_ROSTER` and called out in runbook §3.

## Residual (acknowledged for round 3 / gated deploy steps)

- **Replay protection** for native signed facts (nonce + seen-window) — Codex agreed it can stay
  roadmap for the local/access-controlled Mini with idempotent handlers; needed before broader exposure.
- **Enrollment rotation history** (append + supersede vs overwrite) — after the now-landed admin-boundary
  + insert-only/explicit-rotate fix.
- **Validators**: swap the registry subset to ajv (or formally pin the subset); scrub stays best-effort
  behind quarantine + human review.
- **Health expected-runner roster** + central heartbeat for client drainers (the ack-back gap).
- **Audit retention / migration table** (schema_version anchor exists; no migration mechanics yet).

These are the items for the next pass / the gated cutover — not blockers for the six fixes above.

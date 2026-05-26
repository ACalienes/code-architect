# Codex RE-REVIEW — Shared Layer, WHOLE SYSTEM (after REVISE, pre-deploy gate)

Paste into the Codex VS Code plugin with the `prototype/shared-layer/` directory open (all modules)
plus `docs/shared-layer-deployment-plan-2026-05-25.md` and
`docs/codex-review-shared-layer-MASTER-2026-05-25-response.md` (what changed since your REVISE).

---

This is a **RE-REVIEW (round 5).** Rounds 1–4 (3 + 6 + 5 + 5 findings) are all claimed closed — see the
four response digests `docs/codex-review-shared-layer-*response.md`. **Your first job: verify the
round-4 Must-Fix are actually closed (read the code).** **Your second job: rule on the residual**
(replay protection, enrollment rotation history, ajv-vs-pinned-subset, audit retention/migration) —
must-fix-before-the-Mini-cutover vs. roadmap — and find anything new.

You are reviewing a cross-agent information-sharing system for ~16 autonomous agents on one Mac Mini,
where **per-client data isolation is the highest-stakes invariant**, green on BOTH node:sqlite and
better-sqlite3. Review it as a SYSTEM, adversarially.

Round-4 Must-Fix to verify in code:
- **(was CRITICAL) Projection is now single-writer + read-only to the client.** No client dir-write →
  no symlink/file-swap. The client drainer rides the read-only projection and acks into its OWN
  ack-store (`runner` `ackStore` option; `clientDrainer({ackFile})`). `projectClient` lstat-refuses a
  symlinked dir/file (`projection_refused_symlink`). Runbook §6 reworked (dir `2750` no group-write,
  file `0640`). Verify the client genuinely cannot write the projection and acks land elsewhere.
- Canonicalization now rejects non-plain objects (Date/RegExp/class) — not just undefined/NaN — so a
  Date can't canonicalize to `{}` while persisting a different string. See identity.test §12.
- `health-dashboard.js` now calls `health(db, {projections, open})`; runbook says health MUST be run
  with projections wired (the wedged-client detector is now reachable in deployment).
- `createSharedLayer` REFUSES a null/absent registry (no silent schema-off on the agent write path).
- Runbook §2 adds the central-DB OS-permission gate (dir/db/-wal/-shm mode-denied to agent uids).

Earlier rounds (also verify): promoteClaim atomic; admin-only/insert-only enrollment + rotate;
schema-on-by-default door + adapter; named `_`-allowlist + field-name scrub; `withTx` on
writeFact/revoke/promote/adapter; signed adapter provenance; sealed facade / process boundary; port.

Modules: `shared-layer.js` (core), `db.js` (driver shim), `runner.js` (drainer + wake + onTick),
`notify.js` (fs wake), `backfill.js` (claims → schema-gated promote), `projection.js` (per-client
files), `registry.js` (fact_type schema + versioning), `identity.js` (Ed25519 + authZ), `health.js`
(re-audit + alerts), `adapter-mesh.js` (SIGNED legacy bridge), `enroll.js` (identity bootstrap),
`index.js` (sealed facade), `integration.test.js` (full-system capstone).

Focus your review, in priority order:

1. **Isolation — can ANY client ever see another client's data?** Trace every path: the delivery split
   (route/drain), the physical projection (raw bytes + the refusal guard), the identity layer
   (produce/subscribe client binding), backfill claims, the mesh adapter, health rendering. Construct
   any sequence that leaks across clients or any single point whose failure breaks isolation. This is
   the invariant that must not break.

2. **The crypto/auth (identity.js).** Hand-rolled canonicalization + Ed25519. Signature collisions,
   canonicalization ambiguity, a false-ACCEPT on malformed input, `INSERT OR REPLACE` enrollment
   takeover, replay (no nonce), unsigned legacy ingress via the adapter. Is the auth boundary sound?

3. **The two hand-rolled validators** — the registry JSON-Schema subset and the secret scrubber. Where
   do they diverge from real JSON-Schema / miss a secret shape? Is rolling our own justified vs. ajv?
   For scrub: the `_`-prefix bypass, split-field secrets, free-text PII.

4. **Composition correctness.** The production door is verify-identity → authZ → schema → core write.
   Do the opt-in layers actually compose without gaps (a producer that skips the validated/signed
   path)? Does the facade wire them faithfully? Does the integration capstone test the RIGHT things,
   and what composed failure does it miss?

5. **Operational soundness.** At-least-once + idempotency (handlers must be safe to run twice — is that
   honored anywhere it matters?); the runner wake/in-tick race; health that could report false-OK (a
   wedged client consumer, a dead runner); the projector↔runner two-database consistency on crash;
   audit_log unbounded growth.

6. **The deployment plan.** Read the runbook. Is the rollout sequence safe and truly rollback-able? Are
   the gates (chown for cross-uid denial, key custody, sunset) in the right order? What's missing that
   would bite in production (migration, backpressure under real load, clock skew, disk-full)?

Deliver a single verdict (READY / REVISE / REJECT) for go-to-deploy, with file:line findings ranked by
severity, clearly separating **"must fix before the Mini cutover"** from **"documented roadmap
follow-up."** Deployment-time concerns (per-uid chown, key custody) are acknowledged as gated steps —
assess the design's readiness for them, not their absence from the prototype.

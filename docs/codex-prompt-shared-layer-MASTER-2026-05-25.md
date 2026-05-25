# Codex RE-REVIEW — Shared Layer, WHOLE SYSTEM (after REVISE, pre-deploy gate)

Paste into the Codex VS Code plugin with the `prototype/shared-layer/` directory open (all modules)
plus `docs/shared-layer-deployment-plan-2026-05-25.md` and
`docs/codex-review-shared-layer-MASTER-2026-05-25-response.md` (what changed since your REVISE).

---

This is a **RE-REVIEW (round 3).** Round 1 (3 findings) and round 2 (6 Must-Fix) are both claimed
closed — see `docs/codex-review-shared-layer-MASTER-2026-05-25-response.md` and
`docs/codex-review-shared-layer-2026-05-25-round2-response.md`. **Your first job: verify the round-2
Must-Fix are actually closed (read the code, not the digests).** **Your second job: rule on the residual**
(replay protection, enrollment rotation history, ajv-vs-subset, health expected-roster, audit
retention/migration) — must-fix-before-the-Mini-cutover vs. roadmap — and find anything new.

You are reviewing a cross-agent information-sharing system for ~16 autonomous agents on one Mac Mini,
where **per-client data isolation is the highest-stakes invariant**. Now **248 tests across 12 suites,
green on BOTH node:sqlite and better-sqlite3.** Review it as a SYSTEM, adversarially.

Round-2 Must-Fix to verify in code:
- Enrollment is now ADMIN-ONLY (`createAdminLayer`, not on `createSharedLayer`) and INSERT-ONLY
  (`registerIdentity` refuses overwrite; `rotateIdentity` is the explicit ceremony). Confirm an agent
  reaching the facade cannot register/replace a key.
- Projection dir is locked **before** the db file is created (no temp read window); runbook §6 has a
  concrete ownership model (projector-owns / client-group-reads, `0750`/`0640`, chown). Assess it.
- Schema is ON BY DEFAULT in `writeSignedFact` and the adapter (no registry arg needed); a malformed
  payload is refused via the bridge with no registry passed.
- Validators tightened: registry `_`-keys are a NAMED allowlist (`_api_key` rejected); scrub redacts by
  sensitive field NAME (`{password: "..."}`) in addition to value patterns.
- Multi-step writes are atomic via a re-entrant `withTx` (db.js): `writeFact` (insert+route), `revoke`,
  `promoteClaim`, and the adapter (`writeSignedFact`+`mesh_seen`). Probe crash-atomicity + the nesting.
- `mesh-adapter` is in the enrollment roster.

Earlier rounds (also verify): signed adapter (`_via_mesh_from` provenance), schema-gated promotion,
sealed facade / process-boundary enforcement, the better-sqlite3 port (`db.js`).

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

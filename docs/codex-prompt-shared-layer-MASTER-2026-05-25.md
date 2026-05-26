# Codex RE-REVIEW — Shared Layer, WHOLE SYSTEM (after REVISE, pre-deploy gate)

Paste into the Codex VS Code plugin with the `prototype/shared-layer/` directory open (all modules)
plus `docs/shared-layer-deployment-plan-2026-05-25.md` and
`docs/codex-review-shared-layer-MASTER-2026-05-25-response.md` (what changed since your REVISE).

---

This is a **RE-REVIEW (round 4).** Rounds 1–3 (3 + 6 + 5 findings) are all claimed closed — see the
three response digests `docs/codex-review-shared-layer-*response.md`. **Your first job: verify the
round-3 Must-Fix are actually closed (read the code).** **Your second job: rule on the residual**
(replay protection, enrollment rotation history, ajv-vs-pinned-subset, audit retention/migration) —
must-fix-before-the-Mini-cutover vs. roadmap — and find anything new.

You are reviewing a cross-agent information-sharing system for ~16 autonomous agents on one Mac Mini,
where **per-client data isolation is the highest-stakes invariant**, green on BOTH node:sqlite and
better-sqlite3. Review it as a SYSTEM, adversarially.

Round-3 Must-Fix to verify in code:
- `promoteClaim` is now atomic — `withTx` wraps the validated write AND the claim status flip (a crash
  rolls both back; no orphan/duplicate). See backfill.test crash-sim.
- Canonicalization (`stableStringify` in identity.js) now REJECTS non-JSON values (undefined/function/
  symbol/NaN/Infinity), so `[]` and `[undefined]` can't collide on a signature. See identity.test.
- `health()` folds client projection `consumption` into status + alerts — a wedged client projection
  (central says `projected`) now raises CRITICAL `client_consumer_wedged`. See health.test.
- `enrollFleet` checks the insert-only result and SKIPS writing a key for an already-enrolled agent
  (no mismatched key on re-run). See enroll.test.
- Projection ownership model (runbook §6) reworked so the client can ACK (write): projector-owns,
  `2770` setgid dir + `0660` file, `chown projector:<client-group>`. Assess soundness.

Earlier rounds (also verify): admin-only/insert-only enrollment + explicit rotate; schema-on-by-default
door + adapter; named `_`-allowlist + field-name scrub; `withTx` on writeFact/revoke/adapter; signed
adapter provenance; schema-gated promotion; sealed facade / process-boundary; better-sqlite3 port.

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

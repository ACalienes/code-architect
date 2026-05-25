# Codex review prompt — Shared Layer agent identity + signed source claims (hardening increment #4)

Paste into the Codex VS Code plugin with these files open:
`prototype/shared-layer/identity.js`, `prototype/shared-layer/identity.test.js`,
`prototype/shared-layer/registry.js`, `prototype/shared-layer/shared-layer.js`,
`prototype/shared-layer/README.md`. This touches AUTH — review it as security-critical.

---

You are reviewing **agent identity + signed source claims** for a cross-agent fact-sharing system
where per-client isolation is the top invariant. The lenient core trusts `source_agent` (a string)
and lets anyone subscribe anything. This increment: Ed25519 identities (layer stores only public
keys), `writeSignedFact()` verifies the signature against the registered key + enforces authZ (an
identity may only produce permitted fact_types; a client-bound identity may only produce its own
client's facts), and `authorizeSubscribe()` refuses cross-client subscriptions. Additive + opt-in;
composes with the schema registry (verify → authZ → schema → core write). v1 explicitly defers
replay protection, stored-signature non-repudiation, and rotation history.

Review **objectively and adversarially** — assume crypto/authz flaws and find them. Probe:

1. **Signing coverage / canonicalization.** `canonicalFact` sorts keys recursively and signs a fixed
   field set. Can two DIFFERENT facts canonicalize to the same bytes (collision → a signature valid
   for one accepted for another)? Are all security-relevant fields covered (note `fact_id` is
   writer-assigned and NOT signed — does that matter)? Does `JSON.stringify` of strings with quotes/
   unicode/`NUL` create any canonicalization ambiguity? Is sorting-by-`Object.keys().sort()`
   locale/whitespace safe?

2. **Verification soundness.** `verify(null, …, createPublicKey(pem), Buffer.from(sig,'base64'))` in a
   try/catch returning false on throw — can a malformed sig/pem cause a false ACCEPT rather than a
   safe reject? Is base64 decoding of attacker-controlled input safe? Any way an empty/zero signature
   verifies?

3. **AuthZ completeness.** `authzProduce` checks fact_type allowlist + client binding. Gaps: can an
   internal identity (`client_id=null`) produce a `client_confidential` fact for a client it shouldn't?
   Should `data_class`/`visibility` be authz'd too? `authorizeSubscribe` only gates the client scope —
   should it also gate which fact_types an agent may CONSUME (a `can_consume` allowlist), not just
   produce? Can an internal identity subscribe to a specific client and thereby narrow/cause issues?

4. **Trust root & enrollment.** `registerIdentity` is `INSERT OR REPLACE` — anyone who can call it can
   overwrite an agent's key and impersonate it. In the deployed system, what exactly guards enrollment,
   and does REPLACE-based rotation silently enable takeover? Should rotation be append + explicit
   supersede rather than overwrite?

5. **Replay.** A captured `(fact, signature)` can be re-submitted (creating a duplicate fact). Is
   deferring replay protection acceptable for v1 given the rest of the system (idempotency? the random
   fact_id?), or does it undermine a guarantee elsewhere (e.g., a revoked fact re-injected)?

6. **HB#9 / leakage.** Confirm no path logs or stores a private key or signature in a way that leaks.
   `writeSignedFact` doesn't persist the signature at all — is that the right call, or does losing it
   forfeit non-repudiation that should be kept?

7. **Opt-in posture & test gaps.** Same opt-in concern as the registry (core stays unauthenticated).
   What's untested: signature malleability, a reordered-but-equal payload verifying, an internal agent
   producing for a client, REPLACE-based key takeover, base64-garbage signature, a fact with extra
   unsigned fields.

Verdict (READY / REVISE / REJECT), file:line findings ranked by severity, separating "must fix before
this is trusted as an auth boundary" from "documented roadmap follow-up." Treat deployment-time
enrollment/key-custody as out of scope for the in-process prototype — assess the design's readiness.

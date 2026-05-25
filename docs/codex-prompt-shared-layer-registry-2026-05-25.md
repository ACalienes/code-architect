# Codex review prompt — Shared Layer fact_type schema + versioning (hardening increment #6)

Paste into the Codex VS Code plugin with these files open:
`prototype/shared-layer/registry.js`, `prototype/shared-layer/registry.test.js`,
`prototype/shared-layer/shared-layer.js`, `prototype/shared-layer/README.md`.

---

You are reviewing the **action-vocabulary registry** for a cross-agent fact-sharing system — each
`fact_type` gets a typed payload contract + version, validated at the door so a malformed/mis-tagged
payload can't persist. It is deliberately ADDITIVE: the proven core `writeFact()` stays lenient;
`writeFactValidated()` validates against the registry (a small JSON-Schema *subset* validator, no
dependency), stamps `payload._schema_ver`, then calls `writeFact()`. Versioning: a fact_type maps to
`{ current, versions:{ver:schema} }`; facts are stamped with the version they validated against so a
later schema bump doesn't strand old facts.

Review **objectively and adversarially**. Probe specifically:

1. **Validator soundness.** Find inputs the hand-rolled `validate()` gets WRONG vs. real JSON-Schema:
   `null` vs object, arrays where object expected, `NaN`/`Infinity` as number, nested arrays of
   objects, missing `type` (should it skip all checks?), `required` on a non-object, enum on objects,
   deeply nested errors. Is rolling our own validator the right call, or is the correctness risk high
   enough that ajv (behind the same `validatePayload` surface) is worth the dependency?

2. **The `_`-prefix escape hatch.** Keys starting with `_` bypass `additionalProperties:false` (for
   `_schema_ver`/`_provenance`). Can a sender abuse this to smuggle arbitrary unvalidated data into a
   fact's payload (which then routes to subscribers)? Should `_` keys be an explicit allowlist instead
   of any-`_`? Does this interact badly with the backfill `_provenance`/`_promoted_from_claim` keys?

3. **Opt-in is a real guarantee?** Because `writeFact()` stays lenient, the contract only protects when
   callers use `writeFactValidated`. Is "production routes through writeFactValidated" a strong enough
   posture, or should the registry be enforced at the core (and the prior tests updated)? What's the
   failure mode if one producer forgets?

4. **Versioning completeness.** Stamping a version but never transforming payloads — a receiver coded
   to v2 receiving a v1-stamped fact must branch itself. Is stamp-only versioning sufficient for v1, and
   what's the right shape for migration/upcasting later? Can `current` advancing silently change
   validation for in-flight producers still sending the old shape?

5. **Drift & coupling.** `registryMatchesCore()` guards type-name drift vs the core `FACT_TYPES` set —
   but they're two separate declarations. Should the core derive its set FROM the registry (single
   source of truth)? Any import cycle risk (registry requires shared-layer)?

6. **Test gaps.** What's untested that matters: null/array payloads, a deeply nested schema, a v2 that
   REMOVES a field, `_`-smuggling, a payload that's valid JSON but wrong root type, additionalProperties
   default (true) behavior.

Verdict (READY / REVISE / REJECT), file:line findings ranked by severity, separating "must fix before
enforced" from "documented roadmap follow-up."

# Codex review prompt — Shared Layer backfill-as-claims (hardening increment #2)

Paste into the Codex VS Code plugin with these files open:
`prototype/shared-layer/backfill.js`, `prototype/shared-layer/backfill.test.js`,
`prototype/shared-layer/shared-layer.js`, `prototype/shared-layer/README.md`.
Code review of the second hardening increment on the blessed, already-reviewed v2 design.

---

You are reviewing the **backfill-as-claims ingest** for a cross-agent fact-sharing system serving
~16 agents, where per-client data isolation is the highest-stakes invariant. Accumulated context
(session logs, memory, intakes, decisions) must be seeded into the shared store — but only as
**unverified, quarantined, scrubbed, provenance-stamped CLAIMS**, never directly as routable facts.

Design: `ingestClaim()` scrubs secrets/PII, stores the item in a `claims` table, and **never routes
it** (no delivery row is ever created for a claim — so it can't reach the isolation-checked delivery
path at all). The only egress is `promoteClaim()`, which is human-gated and runs the candidate through
the proven `writeFact()` preflight before it becomes a routed fact. Ingest is idempotent via a
provenance+content hash. `scrub()` is explicitly best-effort regex and records a redaction summary
(type→count, never the value).

Review **objectively and adversarially** — assume flaws and find them. Probe specifically:

1. **Can a claim ever leak before promotion?** Trace every write path in `ingestClaim` — is there
   any way a claim produces a `deliveries` row, or becomes visible to a `drain()`/`peek()`, without
   going through `promoteClaim`? Is "claims table is never agent-readable" actually enforced, or just
   convention?

2. **Scrub coverage and bypass.** The headline accepted limitation is that scrub is non-exhaustive.
   Beyond that: can you defeat the *existing* patterns? (e.g., a secret split across JSON fields so no
   single string matches; a key with unusual length/charset; base64 of a secret; a secret in a
   non-string payload position; unicode look-alikes). Is regex-on-each-string the wrong shape entirely
   — should it be entropy + denylist + structural? Rank what to add by risk-vs-false-positive.

3. **Promotion is the trust boundary.** `promoteClaim` spreads the stored (scrubbed) payload into a
   real fact and adds `_provenance`. Is anything dangerous carried across — could an unmatched secret
   in the scrubbed payload now be *routed* to subscribers? Should promotion re-scrub? Should the
   promoted fact's `_provenance`/`_promoted_from_claim` metadata be considered sensitive?

4. **Idempotency / dedupe correctness.** `dedupe_key = sha256(source_ref|fact_type|subject_id|
   scrubbed_payload)`. Where does this dedupe wrongly (two distinct items collapsed) or fail to dedupe
   (same logical item, different `source_ref` loc on re-parse)? Does hashing the *scrubbed* payload
   (not the raw) cause any correctness or security issue?

5. **State-machine integrity.** quarantined → promoted/rejected. Any way to promote twice, promote a
   rejected claim, or leave a partial state if `writeFact` throws mid-promotion (vs returns !ok)?
   Should these be in a transaction?

6. **Test gaps.** What's untested that matters? (split-field secret, non-string payload secret,
   promotion-then-revoke, dedupe across differing source_ref, concurrent ingest of the same item.)

Verdict (READY / REVISE / REJECT) with file:line findings ranked by severity, separating "must fix
before this increment ships" from "documented roadmap follow-up."

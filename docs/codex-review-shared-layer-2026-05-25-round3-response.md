# Codex MASTER re-review (round 3) — verdict + how it was addressed

**Verdict received: REVISE** (round 3). Codex confirmed the round-2 fixes closed and ran both drivers.
Five Must-Fix remained; all addressed. Re-run after fixes: full suite green on node:sqlite AND
better-sqlite3.

A note of accountability: round 2's commit claimed `promoteClaim` was transactional — it was not
(the schema-gating landed; the `withTx` wrap did not). Codex caught it. That's on me; it's genuinely
fixed and tested now, and I'm flagging the discrepancy rather than quietly patching it.

## Must-Fix — all addressed

1. **(High) `promoteClaim` not atomic.** Now wrapped in `withTx`: the validated fact write AND the
   claim's `status='promoted'` flip commit as one transaction (writeFact nests inline). A crash between
   them rolls BOTH back, so the claim stays `quarantined` and no orphan/duplicate fact persists. New
   crash-sim test (backfill.test §8) forces a throw at the claim-update and asserts full rollback +
   clean re-promote.

2. **(High) Projection ownership incompatible with the client drainer.** The client acks by WRITING,
   so a read-only `0640` file was wrong. Runbook §6 rewritten: each `<agent>/` dir is `chown
   projector:<client-group>`, **`2770` (setgid)** so files are born in the client group (closing the
   "born under the projector's group" window), and `inbox.db` is `0660` — projector (owner) delivers,
   client (group) reads AND acks, all other uids/groups denied. `projectClient({mode:0o660,dirMode:0o2770})`.

3. **(High) Canonicalization false-accept.** `stableStringify` now REJECTS non-JSON values (undefined/
   function/symbol/NaN/Infinity) by throwing, so `[]` and `[undefined]` no longer canonicalize to the
   same bytes — `verifyFact` rejects a tampered non-canonical payload and `signFact` refuses to sign
   one. New identity.test §12.

4. **(Medium) Health false-OK on a wedged client projection.** `health()` now folds the client's
   projection `consumption` (when `opts.projections` is supplied) into status + alerts: a stale
   unconsumed projection raises a CRITICAL `client_consumer_wedged` and flips `ok:false`. New
   health.test §10 (central-only is blind; with projection data it's caught).

5. **(Medium) `enrollFleet` ignored failed insert-only enrollment.** It now checks `registerIdentity`'s
   result and SKIPS writing a private key for an already-enrolled agent (which would otherwise hand out
   a key whose public half isn't registered). New enroll.test §4 (re-run skips; original key still works).

## Residual (Codex agreed these can be roadmap / gated)

- **Replay protection** for native signed facts — roadmap for the local/access-controlled Mini with
  idempotent handlers; required before broader exposure.
- **Enrollment rotation history** — roadmap now that silent overwrite is blocked.
- **ajv vs. the pinned subset** — roadmap *if the subset is explicitly pinned* (the canonicalization
  fix above was NOT optional and is done).
- **Audit retention + migration mechanics** — roadmap for the pilot; needed before real scale.

These are the gated items; the five Must-Fix that drove the round-3 REVISE are closed.

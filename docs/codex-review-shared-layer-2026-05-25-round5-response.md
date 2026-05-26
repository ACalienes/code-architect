# Codex MASTER re-review (round 5) — verdict + how it was addressed

**Verdict: REVISE.** Round-4 fixes confirmed closed (symlink refusal, non-plain-object canonicalization,
`registry:null` refused on the main write path, admin-only/insert-only enrollment, transaction wrapping).
Four findings (3 High, 1 Medium) — all follow-ons from the round-4 read-only-projection/ack-store
redesign. All addressed; full suite green on node:sqlite AND better-sqlite3 (12/12 each).

## Must-Fix — all addressed

1. **(High) Facade allowed schema bypass on legacy ingress.** `sl.ingestEnvelope(env, {registry:null})`
   reached the adapter and disabled schema. Fixed: the facade passes `registry`/`adapterIdentity` LAST
   (`{...opts, registry, adapterIdentity}`) so opts can't override them, AND `adapter.ingestEnvelope`
   now refuses an explicit `registry:null`. Tested (adapter §8).

2. **(High) Ack-store consumption accounting broken.**
   - *Starvation:* the runner filtered acked rows from only the first 1000 peeked → a newer unacked
     delivery starved after 1000 historical acks. Fixed: when an `ackStore` is set, the runner peeks
     ALL pending and filters the acked set (O(pending)/tick — fine for the pilot; an index/ATTACH-join
     is the documented optimization). Regression test in projection §8 (acked-older doesn't block newer).
   - *False wedge:* `health()` counted projection pending without the ack-store, so already-acked old
     rows looked `client_consumer_wedged`. Fixed: `opts.projections[].ackFile` — health subtracts the
     acked set and computes the oldest UNACKED. Tested (health §11: with ackFile, an acked old row is OK).

3. **(High) Projection code defaults contradicted the runbook.** `projectClient` defaulted to `0600`/
   `0700` and re-chmod'd the dir every run, clobbering the deploy's `2750`. Fixed: defaults are now
   `0640` file / `2750` setgid dir (matching the runbook); tests assert the new modes.

4. **(Medium) `clientDrainer` didn't require the ack-store it depends on.** It silently fell back to the
   old write-the-projection model. Fixed: `clientDrainer` THROWS without `ackFile`, and the fixed
   `db`/`agent`/`ackStore` are passed after `...opts` so callers can't override them. Tested (index §4).

## Residual (Codex: roadmap for the gated local pilot)

Replay protection (nonce/idempotency-key + seen-window), enrollment rotation history, ajv vs. a formally
pinned subset, audit retention, migration mechanics. Must graduate before broader (non-local) exposure
and real scale; acceptable as roadmap while the service boundary stays local/permissioned and handlers
are idempotent.

Note: a flurry of `ETIMEDOUT: read` errors during this round's test runs were iCloud-eviction read
timeouts on `~/Desktop` source files (force-materialized, then 12/12 green on both drivers) — not code.

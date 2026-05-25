# Codex review prompt — Shared Layer physical per-client projections (hardening increment #3)

Paste into the Codex VS Code plugin with these files open:
`prototype/shared-layer/projection.js`, `prototype/shared-layer/projection.test.js`,
`prototype/shared-layer/shared-layer.js`, `prototype/shared-layer/runner.js`,
`prototype/shared-layer/README.md`. Code review of the third hardening increment.

---

You are reviewing **physical per-client data isolation** for a cross-agent fact-sharing system
where "client X must never read client Y's data" is the highest-stakes invariant. Logical
isolation (a trusted router writes per-recipient, per-client-scoped `deliveries`; agents read only
their own) is already proven. This increment adds defense-in-depth beneath it: a trusted
`projectClient()` materializes each client repo's deliveries into its own file
`<dir>/<agent>/inbox.db`, OS-permissioned, so a client process can't open another client's bytes.

Design: per-client SQLite (so the existing drainer runner rides it unchanged), `journal_mode=DELETE`
(no persistent `-wal`/`-shm` sidecar holding un-checkpointed bytes), `INSERT OR REPLACE` on facts
(so a later revoke propagates when the correction delivery re-pulls the fact). The projector is a
second guard: it refuses to copy any delivery whose `fact.client_id` ≠ the projection's `clientId`.
The README is explicit that `chmod` is owner-only and true cross-uid denial is the Mini `chown`
deployment step (not exercised in-process).

Review **objectively and adversarially**. Probe specifically:

1. **Byte-level isolation.** Beyond the main `.db` file: can another client's bytes end up anywhere
   readable — a `-journal` file during a transaction, a `-wal`/`-shm` if DELETE mode is somehow not
   honored, SQLite freelist/overflow pages from a prior REPLACE, or OS temp/swap? Is `DELETE`
   journal actually sufficient, or does the projector need an explicit `VACUUM`/secure-delete? Does
   `INSERT OR REPLACE` leave the old fact's payload in a freed page that a raw read could recover?

2. **The refusal guard.** Is `fact.client_id !== clientId` the complete cross-client predicate? What
   about a fact with `client_id = null` (internal/fleet) delivered to a client repo, or a
   `correction`/other `kind`? Could a legitimately-shared (`visibility:'fleet'`) fact be wrongly
   refused, or a confidential one wrongly accepted? Should the guard also check `visibility`/
   `data_class`, not just `client_id`?

3. **Permissions correctness.** Order of `mkdir`/write/`chmod` — any window where the file exists
   world-readable before `chmod`? Is chmod-after-write race-safe? Should the dir be created `0700`
   up front (umask)? On the Mini, what exactly must `chown` to — user vs group, and how does the
   client process get *only* its own read without the projector losing write?

4. **State machine / consistency.** Central marks copied deliveries `projected` and refused ones
   `projection_refused`. Can a crash mid-`projectClient` (after the file write, before the central
   UPDATE, or vice versa) drop or double a delivery? Is the lack of a transaction across the two
   databases a problem? The client acks locally in its projection and central never learns — is the
   missing ack-back an observability gap that matters (e.g., can't tell a wedged client from a quiet
   one)?

5. **Runner interaction.** The client runs the same `createDrainer` against the projection. Does the
   poison-pill `deadLetterDelivery` / `dead_letter` table behave in the projection (it has the full
   schema)? Any issue with two writers (projector appending while the client's runner acks)?

6. **Test gaps.** What isn't covered that should be: a null-client fact delivered to a client repo,
   freelist recovery after REPLACE, a `-journal` present mid-transaction, concurrent project+drain,
   a fleet-visibility fact, very large payloads.

Verdict (READY / REVISE / REJECT), file:line findings ranked by severity, separating "must fix
before deploy" from "documented roadmap follow-up." Deployment-time cross-uid denial is explicitly
out of scope for this in-process prototype — assess the design's readiness for that step, not its
absence.

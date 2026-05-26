# Codex MASTER re-review (round 4) — verdict + how it was addressed

**Verdict received: REVISE** (round 4). Round-3 fixes confirmed closed. Five findings (1 critical,
1 high, 3 medium); all addressed. Full suite green on node:sqlite AND better-sqlite3 (12/12 each).

## Must-Fix — all addressed

1. **(CRITICAL) Symlink / cross-client write via a client-writable projection dir.** Round 3's `2770`
   gave the client group WRITE on its projection dir, so a compromised client could replace `inbox.db`
   with a symlink to another client's file and the projector would write through it. **Redesigned to a
   single-writer model:** the client NEVER writes the projection.
   - The projector is the sole writer; the projection is **read-only to the client** (deploy: dir
     `2750` setgid, group **r-x no write**; file `0640`). No client dir-write → no symlink/file-swap.
   - The client drainer reads the read-only projection and acks into its **OWN ack-store** (a separate
     client-owned file): `runner` gained an `ackStore` option; `clientDrainer(agent, file, handler,
     {ackFile})` wires it. Ack-state (and poison dead-letters) live where only the client can write.
   - Defense in depth: `projectClient` `lstat`-guards the dir + file and **refuses to open a symlink**
     (`projection_refused_symlink`). Tested: a planted symlink is refused and no data is written through it.

2. **(High) Canonicalization false-accept on non-plain objects.** `stableStringify` rejected
   `undefined`/`NaN` but canonicalized a `Date` as `{}` while persistence stored the date string — so a
   signature over one Date verified for another. Now **rejects any non-plain object** (Date/RegExp/class
   instance). Tested: a Date in a signed payload is refused; a Date-tampered payload fails verify.

3. **(Medium) Health fix not wired by the deployment path.** `health(db)` only catches a wedged client
   projection when `opts.projections` is supplied — the dashboard called `health(db)`. Fixed:
   `health-dashboard.js` now calls `health(db, { projections, open: openProjectionDb })`, and the runbook
   says health MUST be run with projections wired.

4. **(Medium) Facade could be built with `registry:null`, disabling schema on `write`.** Fixed:
   `createSharedLayer` now **refuses a null/absent registry** (throws). Bypasses remain only on the
   direct trusted primitives. Tested.

5. **(Medium) Runbook lacked a central-DB OS-permission gate.** Added: the DB directory, `kameha-mesh.db`,
   and its `-wal`/`-shm` sidecars must be mode-denied to agent uids (dir `0700` / files `0600`,
   trusted-owned) — ownership alone is insufficient; the process boundary depends on it.

## Residual (Codex agreed: roadmap for the gated local pilot)

Replay protection, enrollment rotation history, ajv-vs-pinned-subset, audit retention, migration
mechanics. To be in place before broader (non-local) exposure / real scale.

# Codex review prompt — Shared Layer observability / health (hardening increment #5)

Paste into the Codex VS Code plugin with these files open:
`prototype/shared-layer/health.js`, `prototype/shared-layer/health.test.js`,
`prototype/shared-layer/health-dashboard.js`, `prototype/shared-layer/runner.js`,
`prototype/shared-layer/shared-layer.js`, `prototype/shared-layer/README.md`.

---

You are reviewing the **observability layer** for a cross-agent fact-sharing system (~16 agents,
one SQLite store on a Mac Mini, per-client isolation is the top invariant). `health(db)` re-audits
the store into a report whose `alerts[]` is the synthesized "what needs attention": isolation
refusals are CRITICAL, dead-letters warn/critical by age, per-agent backlog/lag is classified
(internal vs client repo, from subscriptions) and ATTRIBUTED (internal pending = drainer behind;
client pending = projector behind). Liveness comes only from an optional heartbeat
(`recordHeartbeat`, wired via the runner's new `onTick`) — never from trusting a delivery claim.

The stated design principle: observability is RE-AUDIT, not telemetry-trust — authoritative
backlog/dead-letter/isolation numbers come from the store; the heartbeat is liveness only.

Review **objectively and adversarially**. Probe specifically:

1. **Does the report ever LIE (false OK)?** Find a real fleet failure that produces `ok:true` / no
   critical alert: e.g. a wedged client-repo consumer (its projection backlog grows but central shows
   `projected`, so central thinks it's fine); a runner that died after acking (no pending, looks
   idle); isolation violations that don't go through `projection_refused_cross_client`; a dead-letter
   that was cleared but the underlying cause persists. Is "client backlog = projector, never the
   client" an attribution that can MASK a genuinely stuck client?

2. **Liveness soundness.** `lastSeen` uses heartbeat ts + a `detail LIKE '%"agent":"X"%'` scan of
   `drained` audit rows. Is the LIKE fragile (substring collisions, agent names that are prefixes of
   each other, JSON key ordering)? The runner uses peek/ack which DON'T audit — so for runner-based
   agents liveness depends entirely on the heartbeat being wired; if `onTick`/`recordHeartbeat` isn't
   set, is the "silent" detection silently disabled (a gap that hides a dead runner)?

3. **Threshold/alert correctness.** Are the defaults (lag warn/crit, dead-letter age, silent) sane
   relative to a 60s interval? Any double-counting or missing alert (e.g. an agent both lagging and
   silent)? Does the `runner_silent` alert fire only when there's pending work — and is that the right
   gate, or does an idle-but-dead runner deserve a flag too?

4. **Cost / scale.** `health()` runs several COUNT/GROUP BY + per-agent queries + a full scan of
   `drained` audit rows on every call. On a long-lived store (audit_log grows unbounded) does this
   degrade? Should audit be retained/rolled? Are indexes needed (deliveries.recipient_agent+status)?

5. **Does health leak anything sensitive?** It reads isolation event `detail` and renders it to HTML.
   Confirm no payload/secret/PII can reach the dashboard (only ids/agent/client). Is `renderHealthHtml`
   escaping all interpolated values (agent names, client ids, alert messages, isolation detail)?

6. **Heartbeat as truth boundary.** `recordHeartbeat` stores the runner's own counters (handled/
   failed). The README says these are liveness only — but are any of them used anywhere as if
   authoritative? Confirm the report's correctness numbers never derive from the heartbeat.

7. **Test gaps.** What isn't covered: a stuck client consumer (projection backlog) via
   `opts.projections`; audit_log scan performance; HTML escaping of a hostile agent name; an agent
   with both `*` and a specific scope; concurrent health() during active writes.

Verdict (READY / REVISE / REJECT), file:line findings ranked by severity, separating "must fix
before this is trusted for alerting" from "documented roadmap follow-up."

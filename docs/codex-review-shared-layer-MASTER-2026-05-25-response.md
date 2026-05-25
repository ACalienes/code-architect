# Codex MASTER review — verdict + how it was addressed

**Verdict received: REVISE** (2026-05-25). Target: `prototype/shared-layer/` + the deployment plan;
top priority per-client isolation. Three findings, all addressed below. Re-run after fixes: **241
checks across 12 suites, green on node:sqlite AND better-sqlite3.**

The root theme was correct and is the same one our own DA flagged: **opt-in security is bypassable
security.** The hardened path existed but could be sidestepped. Fixes close the in-process footguns and
make the actually-used trusted paths go through the door; the *fundamental* enforcement is the
deployment process boundary (documented below).

## Finding 1 — hardened path bypassable (raw exports / trusted-call assumptions)

**Fix (sealed facade + documented enforcement):**
- `index.js` no longer re-exports the raw primitive modules (`core`/`identity`/`registry`/`backfill`/…)
  and no longer exposes an unsigned `writeValidated`. The facade surface is **only** the hardened
  operations (`write` = verify→authZ→schema→core, `authorizeSubscribe`, projection, claims, health, wake).
- New regression guard in `index.test.js` (§4): asserts the facade exposes no `writeValidated`/raw
  `writeFact`/`subscribe`, and the module doesn't re-export raw primitives.
- **The real enforcement** (JS can't hide an export): in deployment, **only the trusted service process
  holds the db handle and imports the core**; agents are separate processes reaching the layer solely
  through the door. Added to the deployment plan as an explicit boundary. The lenient primitives remain
  in their modules for the trusted service + the test suite — never on the agent-facing surface.

## Finding 2 — unsigned adapter

**Fix (signed bridge):** `adapter-mesh.ingestEnvelope` no longer writes unsigned. The adapter is an
**enrolled identity** (`mesh-adapter`) and **signs** each translated fact, writing through the full
door (verify→authZ→schema). Legacy traffic thus becomes **authenticated** facts attributed to the
trusted bridge, with the original sender preserved in provenance (`_via_mesh_from`). **Unsigned ingress
is refused** outright (no adapter identity → error). Proven in `adapter-mesh.test.js` (signed write +
bridge attribution + provenance + unsigned-refused + schema-on-ingress).

## Finding 3 — backfill promotion gaps

**Fix (promotion is schema-gated):** `promoteClaim` no longer calls raw `writeFact` — it routes through
`writeFactValidated` against the registry by default, so a promoted claim is **schema-checked** like any
fact (unknown type / bad payload rejected), and the core preflight still catches a client-confidential
claim with no `client_id`. The promoter (`reviewer`) is the recorded authority (backfilled history has
no signing agent — promotion stays human-gated). `backfill.test.js` updated accordingly.

## Residual / still roadmap (acknowledged, gated)

- **Replay protection** (nonce + seen-window) for signed facts — still deferred; the adapter dedupes
  legacy envelopes by `message_id`, but native signed facts have no replay guard yet.
- **Enrollment trust root** — `registerIdentity` is `INSERT OR REPLACE`; enrollment is a privileged
  bootstrap (T3) and key rotation is overwrite-based. Per-uid `chown` for projections is the deploy step.
- **Hand-rolled validators** (registry subset, scrubber) — production may swap ajv behind the same
  surface; scrub stays best-effort behind quarantine + human review.

These are the items for the next Codex pass / the gated deploy steps — not blockers for the fixes above,
which close the bypass findings that drove the REVISE.

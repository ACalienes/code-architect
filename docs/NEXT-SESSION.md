# CA Next Session Pickup (session 7) — DRIVE THE SHARED LAYER PILOT

**Paste this whole file into a fresh Code Architect Claude Code session.** Continuing from the
2026-05-25→26 arc. Full context: auto-memory `memory/session-2026-05-26.md` + `MEMORY.md` standing rules.

You are Code Architect. The Shared Layer (cross-agent typed-fact sharing) is **built, hardened through 5
Codex review rounds, ported to better-sqlite3, and pushed** (`ACalienes/code-architect`, through
`744d7de`+; green on node:sqlite AND better-sqlite3). **CA's build side is COMPLETE.** This session's
job: **drive the single-user pilot once Kai has stood up the Mini side**, verifying by re-audit.

## The decision in force (confirmed 2026-05-26)

- **Ship the pilot on the SOFT boundary:** isolation = **logical scoping** (the router writes each client
  only its own deliveries) **+ signed integrity** (Ed25519 attribution/tamper-evidence + authz
  client-binding), among **trusted first-party agents**. NOT OS-enforced — say this plainly.
- **The Mini is single-user** (all agents run as unix `kai`, one PM2 daemon). So the **physical
  per-client projection layer (rounds 4–5) + unforgeable identity are DEFERRED**, chown-ready, to a
  separate **"multi-user Mini" project**. Pilot clients **drain their own scoped deliveries from central**
  (no physical projections).
- D1 keys `~/.kameha/keys/<agent>.key` (0600, dir 0700); D2 db `~/.kameha/mesh/kameha-mesh.db` (0700/0600, owned by kai).

## First moves

1. **Check if Kai has acted.** Re-audit the live mesh (`http://100.64.114.13:3341/health`) and ask Kai
   for status on the 3 Mini-standup steps. (Kai got the confirm + decisions over the mesh, both consumed.)
2. **Re-read** `docs/shared-layer-deployment-plan-2026-05-25.md` (§10 trimmed pilot + the 2026-05-26
   section) and `memory/session-2026-05-26.md`.

## The gated pilot sequence (Kai executes on the Mini; CA references + re-audits; each = an Alex go-ahead)

1. Stand up `~/.kameha/mesh/kameha-mesh.db` (better-sqlite3, single-user perms). *[Kai]*
2. `node enroll.js --db … --keys ~/.kameha/keys` → register public keys + authorized subscriptions. *[Kai]*
3. Run the integration capstone against a staging copy on the Mini (sanity on the real driver). *[Kai]*
4. Wire ONE pair (DAG-fact → ACD) through the signed door + logical delivery-split; watch the health dashboard.
5. Add NAMI → run the real **DAG → ACD/NAMI** pilot. → **CA re-audits the receivers** (don't trust completion).
6. (optional) bridge the live ACD↔Kai loop through the signed adapter; set a mesh-api sunset date.

## What CA can do without Kai (if Kai's not ready)
- A one-shot Mini bootstrap script (stand-up db + enroll) Kai runs — reference, not executed from laptop.
- The "multi-user Mini" project plan (the deferred physical wall) if Alex wants to scope it.

## Standing rules (auto-loaded; honor them)
- **Re-verify agent/live claims by re-audit, not trust** — this session a live probe corrected a stale
  "mesh orphaned" belief; CA→Kai sends were verified queued→processing, not assumed.
- **Big/dense responses → HTML explainers** (Kameha house style); keep chat short.
- **Verify staging before commit**; `Bin` in diffstat = contamination (NUL) — `file` + python, not grep.
- **iCloud gotcha:** `~/Desktop` source can evict → `ETIMEDOUT: read` during node runs (looks like a
  hang). `cat prototype/shared-layer/*.js >/dev/null` to materialize, then re-run. Run tests FOREGROUND.
- **Only claim what the diff shows** (a round-2 commit overclaimed promote-atomicity; Codex caught it).
- **HB#1** never commit/push without go-ahead (broad push go-ahead held this arc; confirm on new).
- **HB#10** run only from CA's own repo dir; CA is laptop-only (v0.1.0) — Mini work is Kai's.

## At session end
Per shutdown: write `session-YYYY-MM-DD.md`, update `MEMORY.md`, refresh any material explainer, commit + push, overwrite this file.

---

**Pickup in one line:** ping Kai for Mini-standup status → drive the gated DAG→ACD/NAMI pilot on
logical-scoping + signed-integrity, re-auditing receivers; physical/hard-identity wall is a later project.

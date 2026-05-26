# Prompt for Kai — the 3 cutover decisions (paste to Kai)

Kai — Code Architect here. The **Shared Layer** (cross-agent typed-fact sharing with per-client
isolation) is built, hardened through **5 Codex review rounds**, green on both `node:sqlite` and
`better-sqlite3`, and pushed to `ACalienes/code-architect` (through `6b139d8`). You should have my mesh
notification (`status_update`, 2026-05-26). The full runbook is
`docs/shared-layer-deployment-plan-2026-05-25.md`.

Everything buildable on the laptop is done. The **live Mini cutover is gated on 3 decisions that are
yours** — you own the Mini, the mesh, and the agent processes. Please decide each and send back concrete
answers; flag anything that blocks. Context + a recommended default is given for each so you can just
confirm or adjust.

---

## Decision 1 — Private-key custody

Each agent gets an Ed25519 keypair; the layer stores **only public keys**. Each agent's **private** key
must live where only that agent's process can read it — never in `kameha-mesh.db` or any log. `enroll.js`
generates the keypairs and (reference mechanism) writes private keys as `0600` files; production custody
is your call.

- **Options:** per-agent env var injected by pm2 / `ecosystem.config.js`; a per-agent `0600` key file
  owned by that agent's unix user; macOS Keychain; a secrets manager.
- **Need from you:** the custody mechanism + how each agent process reads its own key.
- **My default rec:** a per-agent `0600` key file under each agent's home, owned by that agent's user,
  with the path in its env.

## Decision 2 — `kameha-mesh.db` location + owner

A **dedicated** SQLite DB (NOT extending `conductor.db` — blast radius + isolation). The dir (`0700`),
the db, and its `-wal`/`-shm` sidecars (`0600`) must be **denied to agent users** — ownership alone isn't
enough; the process boundary depends on it.

- **Need from you:** the absolute path, and which unix user owns/runs the **trusted writer** (the router
  + projector service).
- **My default rec:** `~/.kameha/kameha-mesh.db`, owned by the same trusted user that runs the
  router/projector.

## Decision 3 — Client repos as distinct unix users/groups (the isolation-critical one)

Physical per-client isolation is OS-enforced: each client's projection lives at
`<projections>/<client-repo>/` owned `projector:<client-group>`, dir `2750` (setgid, group r-x, **no**
group write), file `0640` — so only that client's group can read its inbox, the projector writes, and
everyone else (including other clients) is denied. For that to be real, **each client repo must run as
its own unix user in its own group** (e.g. `dag-repo` as user/group `dagdc`, `tdb-repo` as `tdb`).

- **Need from you:** can the client-repo agent processes run as distinct unix users/groups on the Mini
  today? If they currently all run as one user (e.g. `kai`) under pm2, what's the path to per-client
  users — or what's the acceptable interim (e.g. logical isolation only until per-client users land)?
- **This is the one** that determines whether the physical wall is real on day one or deferred. (The
  logical + identity isolation works regardless; this adds the OS layer.)

---

Send these three back and I'll drive the gated rollout step by step (each with Alex's go-ahead):
**port-deploy → stand up `kameha-mesh.db` → enroll keys → projections + chown → the DAG→ACD/NAMI pilot
→ mesh-api sunset.** Replay protection, key-rotation history, ajv, and audit retention/migration stay
roadmap for the local pilot. — Code Architect

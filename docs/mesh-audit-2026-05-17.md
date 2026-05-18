# Mesh Audit — 2026-05-17 (corrected)

Read-only cross-cutting audit of the Kameha agent mesh. T1 (no commits, no cross-repo writes).
First real CA cross-agent task; precursor to `code-architect map` (stubbed; lands Phase 2 W4).

> **Correction notice.** This memo replaces the original 2026-05-17 audit (initial commit
> `44597d4`) which classified `conductor` as **BLOCKER-1** on the grounds that no
> `knowledge/manifests/conductor.json` exists. That verdict was wrong — conductor is a real,
> active daemon (1016-line Express server at Kai's `scripts/conductor-agent.js`, port 3344,
> registered in `~/.kameha/agents.json`, listed in CA's own scope doc as a sender-migration
> target). The original memo missed it because it triangulated only 2 of the 3 registries
> Kameha actually has, and never checked the filesystem for the agent codebase. New behavior
> memories captured the lesson: `reference-kameha-agent-registries` (the three-registry
> structure) and `feedback-audit-triangulate-sources` (always cross-check static manifest +
> runtime registry + actual code presence). See also: `docs/state-of-things-2026-05-17-v1.html`
> for the session-face snapshot that surfaced the corrected picture visually.

## Scope

- **Manifests + registries read:** three sources triangulated for the first time —
  static manifests under Kai's `knowledge/manifests/` (8 files), the runtime registry at
  `~/.kameha/agents.json` (9 entries), and the mesh-API agents table in
  `~/.kameha/mesh/mesh.db` (8 entries). Plus a filesystem scan of `~/Desktop/Code/`
  to verify which named agents have real codebases.
- **Mesh enforcement read:** `route_permissions` table in mesh.db (the source of truth
  for "what messages mesh-API will actually deliver").
- **Method:** for each named agent, check presence across all three registries + verify
  code exists. For each manifest-claimed mesh edge, check if it's in route_permissions.
- **Not in scope:** runtime probe of Mac Mini-side live state (laptop has no Tailscale
  hook), poller AST inspection, owners.json reconciliation (no `.kameha/owners.json`
  exists in any target repo yet).

## Findings (ranked by severity)

### CORRECTED FINDING-1 — three-registry drift across the mesh

The mesh has **three** authoritative-feeling lists of "which agents exist," and they
disagree with each other:

| Agent | knowledge/manifests/ | ~/.kameha/agents.json | mesh.db agents table | Real codebase? |
|---|---|---|---|---|
| kai, cfo, lead-engine, enso, offer-architect, nami | ✓ | ✓ | ✓ | ✓ |
| chronicle | ✗ | ✓ | ✓ | ✓ (own repo) |
| conductor | ✗ | ✓ | ✗ | ✓ (in Kai repo) |
| pitch-deck-engine | ✗ | ✓ (`pitch-deck`) | ✓ (`pitch-deck-engine`) | ✓ (own repo) |
| framer | ✓ | ✗ | ✗ | ✓ (own repo) |
| acd | ✓ | ✗ | ✗ | ✓ (own repo) |
| **kmg** | ✗ | ✗ | ✗ | ✓ (own repo, active) |
| code-architect (me) | ✓ (own repo) | ✗ | ✗ | ✓ |

Notable specifics:
- **`conductor` has no static manifest** but is a real active daemon. The name collides
  with the shared SQLite DB at `~/.kameha/conductor.db`, but they're not in conflict —
  conductor the agent owns conductor.db.
- **`pitch-deck` vs `pitch-deck-engine`** — naming collision between registries. agents.json
  uses `pitch-deck`; mesh.db uses `pitch-deck-engine`. Two registries refer to the same agent
  by different names.
- **`kmg` is a ghost** — real codebase at `~/Desktop/Code/Kameha Media Group/` with
  CLAUDE.md, ecosystem.config.js, scripts/, knowledge/, memory/. Most recent commit
  2026-05-12. Zero registry entries anywhere. Was called "true gap" in the original audit
  because I didn't check the filesystem.
- **`code-architect` (me)** — own manifest at `~/Desktop/Code/Code Architect/manifest.json`
  declares `mesh.sends_to` of 9 agents. None of those routes exist in mesh.db
  route_permissions. I am, today, a paper tiger — manifest-claimed routes that the
  mesh-API would reject.

**Resolution path:** the three registries need a reconciliation pass. Owners.json bootstrap
in Kai's repo is the gate (HB#2). Order: bootstrap owners.json → add missing static
manifests for chronicle/conductor/kmg/pitch-deck-engine → add missing agents.json entries
for framer/acd/kmg → seed mesh.db route_permissions for code-architect and the other
missing agents → reconcile the pitch-deck naming collision. Each step pre-approvable
under HB#2 once owners.json exists.

### SCHEMA-1 — two incompatible mesh-declaration schemas in use (unchanged from original)

- CA's manifest puts mesh edges under `mesh.sends_to` / `mesh.receives_from` (top-level
  `mesh` object, manifest.json:18-36).
- Kai's 8 manifests put them under `connections.sends_to` / `connections.receives_from` /
  `connections.delegates_to` (top-level `connections` object).
- `kai.json` itself uses `delegates_to` (not `sends_to`); the other 7 use `sends_to`.
  Three field names cover the same concept.
- **Impact:** any cross-cutting walker (including the planned `code-architect map`) must
  handle three field names. The DA gate for "mesh contract changes" can't be machine-checked
  without a normalization step.
- **Resolution path:** decide on one schema. Recommend `mesh.{sends_to, receives_from,
  delegates_to}`. Migration is mechanical-refactor class; needs Alex pre-approval per HB#2.

### ASYMMETRY-1 — manifest claims vs mesh enforcement (worse than original said)

The original audit observed that "all 9 CA → X edges are unreciprocated" in static manifests.
The mesh-API reality is harsher: there are **16 enforced routes total** in mesh.db
route_permissions, and **none of them involve code-architect, framer, acd, conductor, or kmg**.

What route_permissions actually enforces (sender → receiver, tier):
- cfo → kai (T1), cfo → offer-architect (T2)
- chronicle → kai (T1)
- enso → kai (T2)
- kai → {cfo (T1), chronicle (T1), enso (T2), lead-engine (T2), nami (T3), offer-architect (T2), pitch-deck-engine (T2)}
- lead-engine → kai (T2)
- offer-architect → kai (T2), offer-architect → pitch-deck-engine (T1)
- pitch-deck-engine → kai (T2), pitch-deck-engine → offer-architect (T1)

**Impact:** today's mesh has 6 fully-wired agents (kai, cfo, chronicle, enso, lead-engine,
offer-architect, nami via kai→nami T3, pitch-deck-engine via the OA pair). The other 5
named agents (framer, acd, conductor, kmg, code-architect) cannot route a single mesh
message — receive nor send. They exist as code but are mesh-invisible.

**Resolution path:** route_permissions seeding for the 5 unrouted agents. Pre-approvable
per HB#2 once owners.json exists. Pure additive; no semantic risk.

### ASYMMETRY-2 — Kai → Framer (unchanged from original)

- framer.json:80-83 lists `kai` in `receives_from`; framer's
  `permissions.mesh.kai_to_framer = T2` (framer.json:48).
- kai.json:224-233 `delegates_to` does NOT include `framer`. Only `acd, cfo, lead-engine,
  offer-architect, nami, chronicle, enso, kmg`.
- Consistent with framer's docstring ("Executes visual work directed by ACD") and the
  ACD→framer edge in acd.json. Likely intentional: kai routes visual work through ACD.
- **But:** framer's own manifest still advertises receivability from kai. Either ratify
  the actual design (kai never sends directly to framer) and trim framer.json, or close
  the omission in kai.json.
- **Resolution path:** ratify design, then trim framer.json. Low risk.

### COSMETIC-1 — cfo.json language/entrypoint mismatch (unchanged)

cfo.json:13-14 declares `"language": "python"` but `"entrypoint": "scripts/cfo-agent.js"`.
Not a mesh issue. Either flip language to `"node"` or rename the entrypoint to match the
implementation.

### COSMETIC-2 — `schema_version` presence is uniform (unchanged from original; needs new note)

All 8 Kai manifests + CA's manifest have `"schema_version": 1`. ✓ No drift on this axis.
No manifest-validator exists yet to enforce. **New note after the three-registry finding:**
schema_version is only checked at the static-manifest layer. `~/.kameha/agents.json` and
the mesh.db agents table have their own implicit schemas; no automated drift check
between the three. Manifest-validator scope (W4 deliverable #6 per CLAUDE.md) should
include cross-registry consistency, not just static-manifest schema.

## In-flight Kai working-tree diff (unchanged from original)

Diff stat: 9 files, 297+/60-. Classified by `git diff -w` to separate semantic from whitespace:

| File | Semantic content change? | Classification |
|------|--------------------------|----------------|
| acd.json | Only `+ "schema_version": 1` | jq-reformat + schema backfill |
| cfo.json | Only `+ "schema_version": 1` | jq-reformat + schema backfill |
| enso.json | Only `+ "schema_version": 1` | jq-reformat + schema backfill |
| framer.json | Only `+ "schema_version": 1` | jq-reformat + schema backfill |
| kai.json | Only `+ "schema_version": 1` | jq-reformat + schema backfill |
| lead-engine.json | Only `+ "schema_version": 1` | jq-reformat + schema backfill |
| nami.json | Only `+ "schema_version": 1` | jq-reformat + schema backfill |
| offer-architect.json | Only `+ "schema_version": 1` | jq-reformat + schema backfill |
| clients.md | +12 lines: new client "The Dental Boutique (TDB)" with billing, scope, family context | Substantive content add, unrelated to manifests |

**Recommendation (unchanged):** commit as two separate commits in Kai's repo. (1)
`feat(manifests): backfill schema_version: 1 + normalize indent across 8 manifests`.
(2) `docs(clients): add The Dental Boutique (TDB) retainer engagement`.

CA cannot author either commit per HB#2 (no `.kameha/owners.json` in Kai repo). Alex
authors; CA's role here is the audit + recommendation. (Note: TDB doesn't appear in
`~/.kameha/clients/` directory yet either — TDB is a new client whose presence is being
added across multiple state stores; clients.md is one of those updates.)

## Recommended next CA tasks (revised by leverage)

1. **Bootstrap `.kameha/owners.json` in Kai's repo** — pre-approval required per HB#2.
   Unblocks every cross-repo write CA could ever do. Without this, CA is read-only
   against Kai forever. This was #1 in the original memo and stays #1.
2. **Begin CA W4 (run-ledger build session #1)** — independent of the owners.json gate;
   can run in parallel. Turns CA from "can audit" to "can implement." Multi-session work
   (~13 sessions per design trilogy); session #1 = ~1.5-2 hr scope. Was framed as third
   priority in the original; promoted because owners.json is gating but doesn't have to
   be sequential with W4.
3. **Reconcile the pitch-deck naming collision** (agents.json uses `pitch-deck`,
   mesh.db uses `pitch-deck-engine`) — pick one canonical name, update the other
   registry. Single-line change once owners.json bootstrap clears the way.
4. **Stub manifests for chronicle, conductor, pitch-deck-engine, kmg in
   knowledge/manifests/** — closes the static-manifest side of the three-registry drift.
   Mechanical, no semantic risk. Per HB#2, gated on owners.json bootstrap.
5. **Add framer + acd to ~/.kameha/agents.json + mesh.db agents table** — closes the
   runtime-side of the drift for those two agents. Also gated on owners.json.
6. **Seed mesh.db route_permissions for the 5 unrouted agents** (code-architect,
   framer, acd, conductor, kmg) — this is what turns the manifest claims into actually-
   enforced routes. Should happen AFTER W4 run-ledger lands so the additions can be
   logged + reversed safely.
7. **Ratify Kai→Framer routing** (ASYMMETRY-2) — confirm design intent, trim
   framer.json. Low risk; gated on owners.json.

(1) and (2) are the gate-openers; (3)-(7) are all mechanical-refactor work blocked on
(1) and benefitting from (2) being live.

## Method note (updated)

This audit took ~12 minutes of CA work for the original incomplete pass, then ~25 minutes
of additional investigation to produce the correction. The original missed the
three-registry structure entirely because I checked only static-manifests and the runtime
registry, treating those two as authoritative. The mesh.db agents table and
route_permissions are the actual enforcement-layer truth, and the filesystem check at
`~/Desktop/Code/` is the existence-layer truth. New procedure captured in
`feedback-audit-triangulate-sources`: future CA audits triangulate all four sources
(static manifests + runtime registry + mesh.db + filesystem) before classifying any
agent as missing, stale, or unreal.

The audit's findings now feed directly into the session-face HTML at
`explainers/session-latest.html` — the System Map and Registry Health sections render
this content visually, so it's discoverable at a glance rather than buried in this memo.
This memo remains the textual reference for the audit reasoning + recommendations;
the HTML is the daily-driver surface.

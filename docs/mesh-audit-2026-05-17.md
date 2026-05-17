# Mesh Audit — 2026-05-17

Read-only cross-cutting audit of the Kameha agent mesh. T1 (no commits, no cross-repo writes). First real CA cross-agent task; precursor to `code-architect map` (stubbed; lands Phase 2 W4).

## Scope

- **Manifests read:** 9 — CA (`~/Desktop/Code/Code Architect/manifest.json`) plus 8 from Kai (`~/Desktop/Code/Kai Executive Assistant/knowledge/manifests/{kai,nami,framer,enso,acd,cfo,offer-architect,lead-engine}.json`).
- **Method:** for each manifest, extract declared `sends_to` / `delegates_to` / `receives_from`. Cross-check pairs A→B vs B's `receives_from`. Flag referenced names that have no manifest. Spot-check `schema_version` presence. Classify uncommitted Kai working-tree diff (9 files).
- **Not in scope:** runtime verification (no mesh-API probing), poller-AST inspection, owners.json reconciliation.

## Findings (ranked by severity)

### BLOCKER-1 — `conductor` is both a database name and an alleged agent
- CA's `mesh.sends_to` lists `conductor` (manifest.json:27) as a destination agent.
- No `conductor.json` exists in Kai's `knowledge/manifests/`.
- The same name is used as the shared SQLite DB at `~/.kameha/conductor.db`, referenced by acd.json:78, framer.json:37, enso.json:46.
- One of two things is wrong: (a) the DB-name and agent-name collision is intentional and the conductor agent simply lacks a manifest, or (b) `conductor` in CA's sends_to is a typo/stale entry and should be removed.
- **Impact if (a):** every `code-architect → conductor` send will silently route nowhere or fail closed. **Impact if (b):** CA's manifest advertises a capability it does not have. Either way, the first real CA `implement` run that touches conductor will hit this.
- **Resolution path:** Alex decision needed. If conductor is a planned agent, file `conductor.json` (stub OK) before W4 lands. If not, drop `conductor` from CA `mesh.sends_to`.

### SCHEMA-1 — Two incompatible mesh-declaration schemas in use
- CA's manifest puts mesh edges under `mesh.sends_to` / `mesh.receives_from` (top-level `mesh` object, manifest.json:18-36).
- Kai's 8 manifests put them under `connections.sends_to` / `connections.receives_from` / `connections.delegates_to` (top-level `connections` object, e.g., kai.json:223-242).
- `kai.json` itself uses `delegates_to` (not `sends_to`); the other 7 use `sends_to`. Three field names cover the same concept (`sends_to`, `delegates_to`, `mesh.sends_to`).
- **Impact:** any cross-cutting walker (including the planned `code-architect map`) must handle three field names. The DA gate for "mesh contract changes" can't be machine-checked without a normalization step.
- **Resolution path:** decide on one schema. Recommend `mesh.{sends_to, receives_from, delegates_to}` with `delegates_to` as a strict subset of `sends_to`. Migration is mechanical-refactor class per CLAUDE.md HB#2; needs Alex pre-approval to touch Kai's repo.

### GAP-1 — Three referenced agents have no manifest
- `kmg` — referenced by kai.json:232, acd.json:96-97 + 168-173, offer-architect.json:42 + 73, lead-engine.json:41 + 71.
- `chronicle` — referenced by kai.json:230 + 239, cfo.json:77.
- `conductor` — referenced only by CA (see BLOCKER-1).
- **Impact:** any agent that tries to validate its outbound mesh edges against a registry will fail closed on these. Audit-time alerts only until W4.
- **Resolution path:** create stub manifests (even `{"schema_version":1,"id":"kmg","status":"planned"}`) so cross-cutting walkers don't crash on lookup. Until that's done, every audit will surface these three.

### ASYMMETRY-1 — Every CA→X edge is unreciprocated
- CA `mesh.sends_to`: [kai, nami, framer, enso, acd, cfo, conductor, offer-architect, lead-engine] (9 agents).
- None of those 9 list `code-architect` in their `receives_from`. Kai's `receives_from` = [acd, cfo, lead-engine, offer-architect, chronicle, kmg] (kai.json:234-241) — no CA. Same pattern in framer.json:80-83, enso.json:71-73, acd.json:166-169, cfo.json:72-74, offer-architect.json:68-70, lead-engine.json:66-68, nami.json:49-51.
- This is internally consistent with CA's `receives_from: []` (CA only sends, never receives) but no receiver has *acknowledged* CA as a sender.
- **Impact:** a strict mesh-contract enforcer would reject every CA-originated message. mesh-api may not enforce today (Phase 1), but it will when sender-allowlists land. The bootstrap exception note in CLAUDE.md confirms initial scaffold shipped without DA — this is the kind of asymmetry DA would have caught.
- **Resolution path:** add `code-architect` to the `receives_from` array of each of the 8 Kai manifests. Pure additive change, mechanical-refactor class, no semantic risk. Best paired with the SCHEMA-1 normalization in the same migration commit.

### ASYMMETRY-2 — Kai → Framer claimed by framer but not by kai
- framer.json:80-83 lists `kai` in `receives_from`; framer's `permissions.mesh.kai_to_framer = T2` (framer.json:48).
- kai.json:224-233 `delegates_to` does NOT include `framer`. Only `acd, cfo, lead-engine, offer-architect, nami, chronicle, enso, kmg`.
- Consistent with framer's docstring ("Executes visual work directed by ACD") and the ACD→framer edge in acd.json:163-165. Likely intentional: kai routes visual work through ACD, not direct.
- **But:** framer's own manifest advertises receivability from kai. Either kai's `delegates_to` should add framer, or framer's `receives_from` + `kai_to_framer` permission entries should drop kai.
- **Resolution path:** ratify the actual design (kai never sends directly to framer; routes via ACD) and remove kai from framer.json's receives_from + permissions.mesh. Low risk; framer's tier-1 caller is ACD per its description.

### COSMETIC-1 — cfo.json language/entrypoint mismatch
- cfo.json:13-14 declares `"language": "python"` but `"entrypoint": "scripts/cfo-agent.js"`.
- Not a mesh issue. Likely a copy-paste error from when cfo got rewritten in node. Either flip language to `"node"` or rename the entrypoint to match the implementation.

### COSMETIC-2 — `schema_version` presence is uniform but not enforced
- All 9 manifests read have `"schema_version": 1` at the top. ✓
- No manifest-validator exists yet (deferred — CLAUDE.md "hard stop on W3 final gate" + scope doc). A new agent could land without `schema_version` and no automated check would catch it until W4's `code-architect map` walks the registry.
- Not blocking. Mentioned so the manifest-validator scope (W4 deliverable #6 per CLAUDE.md) includes `schema_version` presence as one of its checks.

## In-flight Kai working-tree diff (9 files, 297+/60-)

Classified by `git diff -w` to separate semantic changes from whitespace:

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
| clients.md | +12 lines: new client entry "The Dental Boutique (TDB)" with billing, scope, family context | Substantive content add, unrelated to manifests |

**Recommendation:** commit as two separate commits in Kai's repo.
1. `feat(manifests): backfill schema_version: 1 + normalize indent across 8 manifests` — touches 8 files, mechanical-refactor class, zero semantic change. DA gate not triggered (no mesh-contract edits).
2. `docs(clients): add The Dental Boutique (TDB) retainer engagement` — touches 1 file, content add, no mesh implications.

CA cannot author either commit directly (HB#2 fails closed: no `.kameha/owners.json` in Kai repo). Alex authors; CA's role here is the audit + recommendation.

## Recommended next CA tasks (ranked by leverage)

1. **Bootstrap `.kameha/owners.json` in Kai's repo** (pre-approval required per HB#2) — unblocks every future CA cross-repo write. Without this, CA is read-only against Kai forever.
2. **Resolve BLOCKER-1** — Alex decides conductor (a) vs (b). Either add stub conductor.json or drop conductor from CA `mesh.sends_to`.
3. **Migrate to single `mesh.*` schema across all manifests** (SCHEMA-1) — pre-approved mechanical refactor; closes ASYMMETRY-1 in the same pass by adding `code-architect` to each receiver's `receives_from`.
4. **Stub manifests for `kmg`, `chronicle`** (GAP-1) — even minimal `{"schema_version":1,"id":"...","status":"planned"}` files. Eliminates 6 of the audit's GAP/ASYMMETRY findings.
5. **Ratify Kai→Framer routing** (ASYMMETRY-2) — confirm design intent, then trim framer.json.

(1) is the gate. Until owners.json exists in Kai's repo, (2)-(5) are documented but not executable by CA without explicit per-change Alex approval.

## Method note

This audit took ~12 minutes of CA work and is the spirit of `code-architect map`. The findings would have been produced automatically once W4 lands the registry walker. Treating manual audits as practice for the eventual CLI is a reasonable W3 workflow.

# Kai `.kameha/owners.json` bootstrap — handoff

**Date:** 2026-05-18
**Author:** CA session 2 (claude-opus-4-7)
**Draft location:** `test-fixtures/kai-owners.json` (in this repo)
**Target location:** `~/Desktop/Code/Kai Executive Assistant/.kameha/owners.json` (in Kai's repo)

## Why this exists

HB#2 (CLAUDE.md:21) makes CA fail-closed on any cross-repo edit when the target repo has no `.kameha/owners.json`. Kai has none today. Until this file lands in Kai's repo, CA cannot author the registry-drift fixes, the `schema_version` commits, the `route_permissions` seeding, or any of the W3+ cross-agent work.

HB#2 carveout: "an explicit owners-bootstrap or migration task pre-approved by Alex" is permitted. Alex pre-approved this draft via the session 2 priority pick (NEXT-SESSION.md option 1).

## What the draft says (one-line summary)

Default-deny posture (`human_review_required` fallback) with 6 narrow auto-merge lanes for mechanical refactors (`scripts/lib/**`, `scripts/lib/__tests__/**`, `scripts/bot/utils/**`, `scripts/eval/**`, `tests/**`, `package-lock.json`), 6 owner-only lanes for Kai's own state (`knowledge/`, `memory/`, `logs/`, `data/`, `tmp/`, `mesh.db*`), 11 explicit `human_review_required` lanes for critical paths (`scripts/mesh/`, `scripts/hooks/`, `scripts/middleware/`, `scripts/routes/`, `scripts/bot/`, `scripts/**` catch-all, `ecosystem.config.js`, `Dockerfile`, `.github/workflows/`, `.kameha/`, `package.json`), and 1 `bootstrap_only` lane on `.kameha/owners.json` itself so future `owners migrate` runs can update it without requiring per-change approval.

24 patterns + fallback. Source spec: `~/Desktop/Code/Kai Executive Assistant/memory/design_ca_phase2_w4_schemas_2026-05-16.md` Part 1.

## Assumptions baked in

- **All ownership rolls up to "alex"** (`owner_registry: ~/.kameha/agent-owners.json`). v1 has no delegated owners; future schema-version-bump can split KMG/Chronicle/CFO ownership when those owners come online.
- **The scripts/ catch-all sweeps unknown subdirs into `human_review_required`.** Future sub-lanes (e.g., a hypothetical `scripts/codex/`) require new explicit entries before they'd get any other policy.
- **No carve-out for `dashboard/`, `src/`, `templates/`, `imessage/`, `skills/`, `tools/`, `docs/`, `explainers/`.** They all fall through to the fallback. If CA later needs to write to any of them, we'll add explicit lanes then — not speculate now.
- **`mesh.db*` covers the WAL/SHM/journal sidecars** (added during DA pass). Touching a sidecar corrupts the DB; treating them as `owner_only` is correct.
- **`package-lock.json` is bypass-eligible** because `npm install` lockfile churn is mechanical. `package.json` is NOT bypass-eligible because dep additions/removals are semantic.

## Steps to apply (Alex's action)

```bash
# 1. Create .kameha/ in Kai's repo
mkdir -p "~/Desktop/Code/Kai Executive Assistant/.kameha"

# 2. Copy the draft into place
cp "~/Desktop/Code/Code Architect/test-fixtures/kai-owners.json" \
   "~/Desktop/Code/Kai Executive Assistant/.kameha/owners.json"

# 3. Quick sanity check (should parse + show 24 paths)
node -e "const o=require('~/Desktop/Code/Kai Executive Assistant/.kameha/owners.json'); console.log('paths:', o.paths.length, 'fallback:', o.fallback.policy);"

# 4. Commit in Kai's repo
cd "~/Desktop/Code/Kai Executive Assistant"
git add .kameha/owners.json
git commit -m "chore(governance): bootstrap .kameha/owners.json for CA authority

Per HB#2 of Code Architect — without this file, CA fails closed on every
cross-repo write to Kai. Draft authored by CA session 2 (2026-05-18) per
the canonical schema at memory/design_ca_phase2_w4_schemas_2026-05-16.md.

Default-deny posture with 6 narrow auto-merge lanes (scripts/lib,
scripts/lib/__tests__, scripts/bot/utils, scripts/eval, tests, package-lock),
6 owner-only lanes for Kai's runtime state (knowledge, memory, logs, data,
tmp, mesh.db*), 11 explicit human-review lanes for critical paths, 1
bootstrap-only on owners.json itself, fallback = human_review_required."

git push origin main
```

## CA-side verification (after Alex applies)

Once the file lands in Kai's repo, CA should:

1. **Manually verify the file parses + shape matches.** Until `code-architect owners check` ships (W4), this is the manual gate:
   ```bash
   node -e "const o=JSON.parse(require('fs').readFileSync('~/Desktop/Code/Kai Executive Assistant/.kameha/owners.json','utf8')); console.log('schema_version:', o.schema_version); console.log('paths:', o.paths.length); console.log('fallback:', o.fallback.policy);"
   ```
   Expected: `schema_version: 1 / paths: 24 / fallback: human_review_required`.

2. **Confirm HB#2 gate now passes for Kai.** First real cross-repo task should be a no-op test write to a `human_review_required` path and verify the response is "open branch + halt, don't merge."

## What this does NOT do

- **Does NOT bootstrap owners.json for the other 11 agents.** Each one needs its own file with policy tuned to its repo layout (KMG narrow, Chronicle strictest, etc — see schemas doc §1.6 sketches). This is one repo, one session.
- **Does NOT enforce the policy.** That's the `code-architect implement` + `manifest-validator` Check C job — W4 scope. Today this file is convention-only enforced by methodology + DA discipline.
- **Does NOT migrate any existing policy.** Kai has no prior owners.json; this is greenfield. Future schema bumps will use `owners migrate --to=N`.

## Open questions for Alex (non-blocking)

- **`scripts/__pycache__/`** is committed to Kai's tree today. That's a `.gitignore` bug, not a policy concern, but worth flagging — it falls through to `human_review_required` which is fine but the dir shouldn't exist at all. (Cross-fleet gitignore cleanup queue item, item 4 in NEXT-SESSION.md.)
- **`{knowledge,templates,logs}/`** is a literally-named directory in Kai's root (looks like a shell glob expansion that failed and created the literal-named dir). Falls through to fallback. Worth cleaning up.
- **No carve-out for `src/`, `dashboard/`, etc** — if you want CA to be able to touch any of those in mechanical-refactor lanes later, we add a lane and re-bootstrap. v1 default is deny.

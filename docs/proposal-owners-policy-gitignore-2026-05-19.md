# Proposal — allow CA mechanical `.gitignore` hygiene across fleet

**Author:** Code Architect (session 3 overnight, 2026-05-19)
**Status:** Proposal awaiting Alex go-ahead. No edits made.

## Problem

Tonight's audit found A2 hygiene items where CA could mechanically clean up `.gitignore` gaps:
- Nami: 18 stray PNGs at root + `.playwright-mcp/`
- CFO: log-output gitignore gap (specific files A2 identified)
- Chronicle: `.next/trace*` (blocked by P0-3a git lock anyway)
- Framer: `.playwright-mcp/` (blocked by P1-7 missing owners.json anyway)

**But:** in every repo with owners.json, `.gitignore` falls under the `fallback: human_review_required` posture. The current bootstrap pattern doesn't carve out `.gitignore` as mechanically eligible.

**So:** CA cannot mechanically sweep `.gitignore` even though the change class is:
- Single-file
- Non-functional (no runtime behavior change)
- Append-mostly (new ignore patterns, never untracking already-tracked files)
- Owner-trivial (every owner agrees these artifacts shouldn't be tracked)

## Proposed change

Add a `.gitignore` path entry to each of the 9 bootstrapped owners.json files with:

```json
{
  "pattern": ".gitignore",
  "owner": "alex",
  "policy": "auto_merge_after:ca_internal_da",
  "bypass_eligible": true,
  "notes": "Append-mostly hygiene file. CA may add ignore patterns mechanically; CA-internal DA confirms no existing tracked files would be untracked. Removing entries or globbing in ways that would untrack live code stays human-review."
}
```

## CA-internal DA gate criteria

Before any `.gitignore` autocommit, CA verifies:
1. `git ls-files | grep -E '<new_pattern>'` returns empty (no live tracked files would be untracked).
2. The change is **additive** — no deletions, no edits that broaden an existing pattern.
3. New patterns are root-anchored (`/foo.png`) OR explicitly cache/build directories (`.next/`, `node_modules/`, `.playwright-mcp/`).

If any of those fail, fall back to human review.

## Tradeoffs

- **Slight blast-radius increase:** a buggy CA could ignore a file it shouldn't. Mitigated by additive-only + DA gate above.
- **Cleaner fleet hygiene:** the 5 P2 gitignore items tonight could close in minutes once unblocked, plus future ones don't require Alex's morning.
- **Alternative:** keep `human_review_required` and let CA stage diffs only. Lighter on bootstrap edit but heavier on Alex's hands each time.

## If approved

CA tonight already drafted patches (kept locally as files in `docs/drafts-gitignore-2026-05-19/` — to be created when approval lands). Each is:
- One ignore-pattern addition
- One commit per repo
- DA-gate verification baked in

## Recommended decision

**Approve.** This is the rare class where Alex's manual review provides no signal that mechanical DA verification can't.

Adjacent question (out of scope for tonight): should the same `auto_merge_after:ca_internal_da` policy extend to `README.md` non-content edits (markdown linting, link fixes)? Defer.

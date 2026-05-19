# Code Architect — Memory Index

Pattern + failure-analysis index. One line per entry, <200 chars each. Active cards live under `active/`; pruned cards live under `archive/` (restoreable via `code-architect memory restore <slug> --reason="..."`).

## Caps (enforced by `scripts/lib/memory-doctor.js`)

- `active/` entries: 30 hard cap
- `methodology.md` lines: 200 hard cap
- pattern card body: ≤100 words / ~130 tokens
- failure-analysis body: ≤200 words / ~260 tokens
- `permanent: true` entries: ≤5 (each requires non-empty `permanent_rationale`)
- per-invocation context: ≤10 cards selected by graph-walk
- per-invocation memory tokens: ≤16K (~8% of 200K window)

## Frontmatter schema (per card)

```yaml
---
name: <kebab-case-slug>
description: <one-line summary; drives relevance ranking>
metadata:
  type: pattern | failure-analysis | reference
  applies_to: [<task-class-1>, <task-class-2>]   # subset of: sender-migration | schema-change | new-agent | refactor | hotfix | general
  permanent: false                                # if true, exempt from pruning
  permanent_rationale: ""                         # required non-empty if permanent: true
  word_budget: 100                                # 100 for pattern, 200 for failure-analysis
  source_files: []                                # absolute paths whose hash is tracked for drift
  created: <ISO8601>
  last_referenced: <ISO8601>                      # updated by run ledger reads
---

<body — ≤word_budget words; backlinks via [[other-slug]]>
```

## Patterns

- [pattern-distill-verify-paths](active/pattern_distill_verify_paths.md) — verify every cited absolute path with `fs.existsSync` BEFORE computing SHA-256 at distill time; phantom citations surface as `MISSING`, not silent skip.

## Failure analyses

(none yet — first cards land when a CA run produces a failure worth distilling)

## References

(none yet)

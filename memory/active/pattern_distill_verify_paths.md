---
name: pattern-distill-verify-paths
description: At methodology distill time, verify every cited absolute path exists before computing hashes — design docs drift, citations go stale, and a missing source becomes a phantom citation that surfaces only at hash-recompute time.
metadata:
  type: pattern
  applies_to: [refactor, new-agent, general]
  permanent: false
  word_budget: 100
  source_files:
    - /Users/alex/Desktop/Code/Kai Executive Assistant/memory/design_ca_phase1_w3_2026-05-11.md
    - /Users/alex/Desktop/Code/Kai Executive Assistant/memory/feedback_verify_before_recommending.md
  created: 2026-05-11T23:59:00Z
  last_referenced: 2026-05-11T23:59:00Z
---

When distilling [[methodology.md]] from cited sources, iterate every `Source:` path through `fs.existsSync` BEFORE computing SHA-256. Phantom citations (file moved, renamed, or never existed) surface at distill time as `MISSING`, not as silent skip. Tonight's first distill caught `feedback_spec_must_match_live_enforcement.md` cited at auto-memory path but actually living in project-repo memory. Corrected before persistence. Aligns with [[feedback_verify_before_recommending]] — memory entries that name paths are state snapshots, not contracts.

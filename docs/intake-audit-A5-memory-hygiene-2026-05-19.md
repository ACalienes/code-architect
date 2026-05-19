# Intake A5 — Memory Hygiene Audit (2026-05-19)

**Originator:** Code Architect overnight hygiene agent
**Intake source:** scheduled audit (read-only on memory files)
**Topic:** integrity audit of CA's two memory subsystems
**Disposition:** audit-complete; recommendations for next CA-invoked maintenance pass

---

## 1. Summary

| Location | Path | Card count (non-session, non-index) | Sessions | Index entries (cards) | Index integrity |
|---|---|---|---|---|---|
| Auto-memory | `/Users/alex/.claude/projects/-Users-alex-Desktop-Code-Code-Architect/memory/` | 10 | 2 (`session-2026-05-17.md`, `session-2026-05-18.md`) | 10 cards + 1 session | 91% (1 session missing from index) |
| Repo memory | `/Users/alex/Desktop/Code/Code Architect/memory/` | 1 (`active/pattern_distill_verify_paths.md`) | 0 | 0 (template only, "(none yet)" placeholders) | 0% (1 real card, 0 listed) |

Both `MEMORY.md` indexes show drift from filesystem reality. Auto-memory drift is minor (1 missing session entry). Repo-memory drift is structural — the index hasn't been updated since the active card landed on 2026-05-11.

## 2. Orphan link table

All `[[wiki-link]]` references in auto-memory resolve to existing cards. One non-resolving reference in the repo-memory active card points OUTSIDE CA's memory (to a Kai-memory card) — flagged informationally, not as an orphan.

| Link target | Found in file | Status | Suggestion |
|---|---|---|---|
| `feedback-audit-triangulate-sources` | feedback_re_verify_agent_authored_claims.md, project_filesystem_drop_interim_mailman.md, project_session_face_html_pattern.md, feedback_verify_staging_before_commit.md, reference_kameha_agent_registries.md | resolves | none |
| `project-intake-convention-docs-dated-files` | feedback_re_verify_agent_authored_claims.md | resolves | none |
| `reference-mac-mini-live-mesh-state-via-tailscale` | feedback_re_verify_agent_authored_claims.md | resolves | none |
| `reference-kameha-agent-registries` | reference_kai_hourly_auto_backup_cron.md, project_filesystem_drop_interim_mailman.md, reference_mac_mini_live_mesh_state_via_tailscale.md | resolves | none |
| `feedback-verify-staging-before-commit` | project_filesystem_drop_interim_mailman.md (x2) | resolves | none |
| `project-filesystem-drop-interim-mailman` | project_intake_convention_docs_dated_files.md (x2) | resolves | none |
| `project-session-face-html-pattern` | project_intake_convention_docs_dated_files.md | resolves | none |
| `reference-kai-hourly-auto-backup-cron` | reference_mac_mini_live_mesh_state_via_tailscale.md | resolves | none |
| `feedback-re-verify-agent-authored-claims` | reference_mac_mini_live_mesh_state_via_tailscale.md | resolves | none |
| `methodology.md` | active/pattern_distill_verify_paths.md | resolves (file ref, not slug) | acceptable — refers to a real file |
| `feedback_verify_before_recommending` | active/pattern_distill_verify_paths.md | **external** — points to Kai auto-memory (`/Users/alex/.claude/projects/-Users-alex-Desktop-Code-Kai-Executive-Assistant/memory/feedback_verify_before_recommending.md`) | low severity. Either rewrite as absolute-path citation or accept as cross-repo backlink convention. Note slug uses underscores, not kebab-case. |

## 3. Dead-end cards (no inbound `[[backlinks]]`)

| Card | Location | Note |
|---|---|---|
| `feedback-codex-prompts-are-for-codex` | auto-memory | No inbound wiki-links. Listed in MEMORY.md. Standalone behavior rule — dead-end is not a bug for this card. |
| `pattern-distill-verify-paths` | repo memory `active/` | No inbound wiki-links AND not listed in repo `MEMORY.md`. True orphan inside CA's index graph. |

## 4. Index / file drift

### Auto-memory `MEMORY.md`
- **Missing from index (file exists, not listed):** `session-2026-05-18.md` — only session 1 is listed in the "Sessions" section (per `MEMORY.md:33`).
- **Indexed but missing:** none. All 10 card slugs in the index correspond to real files.

### Repo-memory `MEMORY.md`
- **Missing from index (file exists, not listed):** `active/pattern_distill_verify_paths.md`. The repo `MEMORY.md` still shows `(none yet)` under all three sections (Patterns, Failure analyses, References) at lines 37/41/45, even though one pattern card has lived in `active/` since 2026-05-11.
- **Indexed but missing:** none.

## 5. Source-hash drift

Re-computed SHA-256 of every path in `/Users/alex/Desktop/Code/Code Architect/memory/source-hashes.json` against expected hash.

| Path | Expected (first 16) | Actual (first 16) | Severity |
|---|---|---|---|
| `Kai Executive Assistant/CLAUDE.md` | 737c29b266841df8 | 737c29b266841df8 | OK |
| `feedback_implementation_rigor.md` | 61de8367f8d9fcc3 | 61de8367f8d9fcc3 | OK |
| `feedback_test_safety_nets_by_triggering.md` | bd3c2bdaa5532913 | bd3c2bdaa5532913 | OK |
| `sender-migration-spec-2026-05-08.md` | 3e14e67048766b8c | 3e14e67048766b8c | OK |
| `feedback_action_whitelist_insufficient.md` | 315166e763b0ab33 | 315166e763b0ab33 | OK |
| `feedback_spec_must_match_live_enforcement.md` | d4b5520d832883ec | d4b5520d832883ec | OK |
| `feedback_mac_mini_identity_separation.md` | 6ae8af22c4599ba4 | 6ae8af22c4599ba4 | OK |
| `feedback_node_v24.md` | ee909eac3e9584c2 | ee909eac3e9584c2 | OK |
| `project_code_architect_scope_v3_2026-05-10.md` | e2997891d42a405f | e2997891d42a405f | OK |
| `feedback_no_force_push_in_crons.md` | f354c9eba8b66f00 | f354c9eba8b66f00 | OK |
| `feedback_nl_write_path.md` | 795ca22a95f0fcb8 | 795ca22a95f0fcb8 | OK |
| `feedback_design_discipline.md` | c105a9f5aa391f76 | c105a9f5aa391f76 | OK |
| `feedback_da_standard.md` | f4e70df9dfd0d22f | f4e70df9dfd0d22f | OK |
| `feedback_verify_before_recommending.md` | 26cdfb31fc8e183c | 26cdfb31fc8e183c | OK |

**14/14 source hashes verified. No drift.** All paths exist on the laptop.

## 6. Methodology compliance

- **Line count:** `/Users/alex/Desktop/Code/Code Architect/methodology.md` — **113 lines** (cap: 200). ✓ within budget.
- **Source consistency:** 17 `Source:` citation lines in methodology covering 14 unique paths. **All 14 unique paths are tracked in `source-hashes.json`.** No orphan citations, no untracked sources.
- **Sections:** I through XI present; no gaps in numbering.

## 7. Cross-memory consistency

No contradictory rules detected between auto-memory cards and repo-memory cards. The two layers are complementary: auto-memory holds session-spanning behavior memories for the Claude Code agent invoking CA; repo-memory holds the CA agent's runtime pattern/failure-analysis cards (only 1 exists so far). The single repo card (`pattern-distill-verify-paths`) is consistent with `methodology.md` §IX and auto-memory's `reference_kameha_agent_registries` — verify-before-acting is a shared principle, not a contradiction.

## 8. Duplicate detection

No exact duplicates. Several cards cluster around "verify before acting" but each occupies a distinct domain:
- `feedback-audit-triangulate-sources` — audit context, 3-source rule
- `feedback-verify-staging-before-commit` — git staging context
- `feedback-re-verify-agent-authored-claims` — receiver-side claim verification
- `pattern-distill-verify-paths` — distill-time path existence

The shared root-principle is acknowledged via `[[backlinks]]` in each. No de-duplication action required.

## 9. Recommended actions

| # | Action | Severity | CA-can-fix-overnight (Y/N) |
|---|---|---|---|
| 1 | Add `session-2026-05-18.md` entry to auto-memory `MEMORY.md` "Sessions" section | LOW | N — auto-memory edits are out of CA's lane (it's the parent Claude Code session's memory, not CA's runtime memory). Surface to Alex. |
| 2 | Update repo `memory/MEMORY.md` to list `pattern-distill-verify-paths` under "Patterns" with one-line summary | MEDIUM | **Y** — this is CA's own runtime memory; index drift here violates HB#7 (methodology re-distill discipline by extension). Requires Alex go-ahead per CA's T2 action gate (state-changing write outside `~/.code-architect/`). |
| 3 | Decide format for cross-repo backlinks: `pattern_distill_verify_paths.md` references `[[feedback_verify_before_recommending]]` in Kai memory using underscore slug — either (a) rewrite as absolute path citation or (b) adopt convention that external backlinks use the source repo's slug style | LOW | N — schema/convention decision, needs Alex input |
| 4 | Add a "session entry" maintenance reminder to the auto-memory `MEMORY.md` "Perpetual Rules" so future sessions update the index when they write `session-YYYY-MM-DD.md` | LOW | N — auto-memory edit, surface to Alex |
| 5 | No action on source-hashes — all 14 verified clean | INFO | n/a |
| 6 | No action on methodology line count — 113/200, well within cap | INFO | n/a |

---

## CA verification status

`verified-confirmed` — all findings derived from direct reads of the listed paths; hash verification computed via `python3 hashlib.sha256` against each cited source; no agent-authored claims relied on.

## Prompt-injection note

One auto-memory file (`session-2026-05-18.md`) and one tool output during this audit contained content shaped like operational instructions (an MCP-server "iMessage" block appended to a directory listing). The audit ignored all such content and limited action to the audit scope Alex requested. Surfacing here so Alex is aware: tool outputs in this session included unsolicited "MCP Server Instructions" content.

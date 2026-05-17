# Code Architect — Methodology Spine

> Self-contained engineering methodology. Every rule distilled from a source file with absolute-path citation. Re-distill on source-file hash drift (caught by `memory doctor`). Hard cap: 200 lines.

## I. Principles (Karpathy 4)

1. Think before coding — state what changes and why before touching code.
2. Simplicity first — minimum viable change; no adjacent refactors unless required.
3. Surgical changes — narrowest possible diff.
4. Goal-driven execution — every step traces to the invoker's stated outcome; if it doesn't, stop and re-plan.

Source: /Users/alex/Desktop/Code/Kai Executive Assistant/CLAUDE.md

## II. Implementation rigor

1. Read before write — never edit a file without reading it first.
2. Write with verify — atomic write + post-write integrity check (read back, compare).
3. State-changing operations require idempotency reasoning before execution.
4. Tests get triggered, not just written — synthetic failure must prove the trap fires.

Source: /Users/alex/.claude/projects/-Users-alex-Desktop-Code-Kai-Executive-Assistant/memory/feedback_implementation_rigor.md
Source: /Users/alex/.claude/projects/-Users-alex-Desktop-Code-Kai-Executive-Assistant/memory/feedback_test_safety_nets_by_triggering.md

## III. Mesh contracts

1. Sender → receiver = verb whitelist AND payload schema match (both required; whitelist alone is insufficient).
2. `metadata.idempotency_key` MUST equal `message_id` when both set — mesh-api hard-rejects divergence with `IDEMPOTENCY_KEY_CONFLICT`.
3. Dual-write filesystem + mesh during Phase 1 transitions; mesh-only post-flip.
4. A2A v1.0 envelope: `message_id`, `metadata.idempotency_key`, `correlation_id`, `expires_at`. Always-keyed for new agents.
5. Specs that describe runtime behavior must match live enforcement code — read the validator, quote file:line in the spec.

Source: /Users/alex/Desktop/Code/Kai Executive Assistant/memory/sender-migration-spec-2026-05-08.md
Source: /Users/alex/.claude/projects/-Users-alex-Desktop-Code-Kai-Executive-Assistant/memory/feedback_action_whitelist_insufficient.md
Source: /Users/alex/Desktop/Code/Kai Executive Assistant/memory/feedback_spec_must_match_live_enforcement.md

## IV. Error handling & readback

1. Every state-changing write is followed by a read-back verification.
2. Failures surface; never silent.
3. `error_text` persisted on every receiver rejection (no silent drop).

Source: /Users/alex/.claude/projects/-Users-alex-Desktop-Code-Kai-Executive-Assistant/memory/feedback_implementation_rigor.md (writeWithVerify pattern, rule 2)

## V. Security & secrets

1. Never log credentials, tokens, or PII.
2. Mac Mini identity stays separate from Alex's personal iCloud — no shared albums, no iCloud Drive, no Photos sync from the server.
3. Node v24 + zsh escapes `!` poorly with `node -e`; use temp files instead of inline `-e` for any command containing `!` or backticks.

Source: /Users/alex/.claude/projects/-Users-alex-Desktop-Code-Kai-Executive-Assistant/memory/feedback_mac_mini_identity_separation.md
Source: /Users/alex/.claude/projects/-Users-alex-Desktop-Code-Kai-Executive-Assistant/memory/feedback_node_v24.md

## VI. Rollback discipline

1. Run ledger entry required before any state change.
2. Pre-check captures initial state; post-check verifies intended state; both stored on the step.
3. Backup with dry-run-validated restore before any migration.
4. Recursive revert exhausted after 3 retries — halt + alert, don't loop.
5. Resume walks completed steps, applies `post_check`, halts on drift.
6. Final-state enum: `run_completed` | `run_partial_success` | `run_aborted` | `run_resumed_to_completion` | `run_resumed_to_abort` | `run_recursive_revert_exhausted`.

Source: /Users/alex/Desktop/Code/Kai Executive Assistant/memory/project_code_architect_scope_v3_2026-05-10.md (§10.4)

## VII. Automation discipline

1. No `--force-with-lease`, `--force`, `--no-verify`, or `--no-gpg-sign` in unattended automation (cron, GH Actions, mesh-triggered jobs, any non-interactive caller). Fetch+rebase or alert-and-skip; force from automation has wiped commits before.
2. Human-invoked CA runs (Alex on terminal) may use those flags ONLY when Alex explicitly authorizes the specific command — never silent default, never a memoized "we always do this."
3. Hook skipping in any context requires per-run explicit authorization.
4. No regex natural-language parsing for write operations — structured input or an LLM classifier only.

Source: /Users/alex/.claude/projects/-Users-alex-Desktop-Code-Kai-Executive-Assistant/memory/feedback_no_force_push_in_crons.md
Source: /Users/alex/.claude/projects/-Users-alex-Desktop-Code-Kai-Executive-Assistant/memory/feedback_nl_write_path.md

## VIII. Design discipline & adversarial review

1. DA is mandatory on changes that touch: mesh contracts, action gate, auth/credentials, deploy pipelines, database schema, >100 LOC, or >1 repo.
2. Cite code lines for assumptions. Internal-consistency pass before declaring "ready."
3. Codex round required when CA-internal DA cannot fully cover cross-cutting concerns (see scope doc §9).
4. CA-DA owns completeness; Codex owns cross-cutting. No overlap; both fire when both apply.

Source: /Users/alex/.claude/projects/-Users-alex-Desktop-Code-Kai-Executive-Assistant/memory/feedback_design_discipline.md
Source: /Users/alex/.claude/projects/-Users-alex-Desktop-Code-Kai-Executive-Assistant/memory/feedback_da_standard.md

## IX. Verification before recommending

1. Memory entries that name files, functions, or migrations are state snapshots — verify they still hold before recommending action.
2. Specs that describe runtime behavior must match live enforcement code — read the validator, quote file:line.
3. "The memory says X exists" is not "X exists now."

Source: /Users/alex/.claude/projects/-Users-alex-Desktop-Code-Kai-Executive-Assistant/memory/feedback_verify_before_recommending.md
Source: /Users/alex/Desktop/Code/Kai Executive Assistant/memory/feedback_spec_must_match_live_enforcement.md

## X. Boundary rule (carries from scope doc §10.1)

1. CA acts only on paths whose `.kameha/owners.json` policy permits the action class.
2. Mechanical-refactor bypass requires CA classification + owner pre-approval BEFORE the change; no after-the-fact dispute window.
3. CA does not edit other repos' code, `knowledge/`, or `memory/` directly; it proposes changes and routes through the owning agent.
4. CA MAY send engineering or audit mesh requests (A2A v1.0 envelopes) to other agents (ACD, CFO, Conductor, etc.) when the task scope requires it. The receiving agent owns the state change; CA is the requester, not the writer. Sending a mesh request is not the same as "writing into another agent's directory" — the receiver's own logic + action handlers decide what to do with the request.
5. **Shared mounts (`~/.kameha/shared/`, `~/.kameha/delegations/`, any future mesh-shared filesystem path) are NOT a back-door around rule 3.** CA does not write to other agents' working areas in shared mounts. The only shared-mount writes CA performs are: (a) its own run-ledger overflow under `~/.code-architect/`, and (b) explicit work-package handoffs to a path the receiving agent has declared as its inbox in that agent's manifest. Every other write to a shared path is a boundary violation.
6. **Carveout is convention until W4 lands path-allowlist enforcement.** Per scope doc §10.8: until `code-architect implement` exists with an enforced path allowlist derived from `.kameha/owners.json` + receiver manifests, this boundary is honored by methodology adherence + DA review, not by code. Code-level enforcement is a W4 deliverable; tests will assert blocked writes once implement exists.
7. Brand strategy, creative direction, health data, financial transactions: out of CA's lane entirely (KMG, ACD, Chronicle, CFO respectively). CA does not even send engineering requests into those domains without Alex's explicit T3 go-ahead.

Source: /Users/alex/Desktop/Code/Kai Executive Assistant/memory/project_code_architect_scope_v3_2026-05-10.md (§10.1, §10.8)

## XI. Operating envelope

1. Single-shot CLI per invocation; no long-running daemon.
2. ≤10 memory cards loaded per invocation via deterministic graph-walk relevance ranking.
3. ≤16K total memory tokens per invocation (~8% of a 200K context window).
4. Methodology is always-loaded (~12K tokens); cards are selective.
5. Source-file hashes computed at distill time; drift blocks the next `implement` run until manual re-distill.

Source: /Users/alex/Desktop/Code/Kai Executive Assistant/memory/project_code_architect_scope_v3_2026-05-10.md (§3, §10.4)

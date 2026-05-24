# Codex prompt — CA session 4 adversarial review (2026-05-20)

You are reviewing Code Architect's session-4 work product. Paste this entire file into Codex (VS Code plugin or cloud) and let it run.

---

## Context

Code Architect (CA) is the engineering agent in Alex Calienes's Kameha mesh. This session (2026-05-20) shipped three substantial design artifacts across three repos (ACD, Kai/Conductor, Code Architect) plus a live-probed architecture audit. The work spans mesh contracts, DB schema, cost economics, and shared-knowledge architecture — three of the DA-gate criteria CA-internal-DA can't fully cover.

CA already ran a self-DA pass (passed with prerequisites) in §10 of the crew_manifest proposal. **Do not duplicate that pass.** Your job is the gaps a self-DA can't catch: hidden assumptions, math errors, contradictions across docs, over-confident claims, missed failure modes, and design choices that look fine in isolation but conflict with the larger picture.

## Files to review (read first, in this order)

All paths absolute from `/Users/alex/Desktop/Code/Code Architect/`:

1. **`CLAUDE.md`** — CA's operating principles, hard boundaries, authority model. Anchor for what CA is allowed to do.
2. **`docs/architecture-current-state-2026-05-20.md`** — the live-probed architecture audit. Every claim should be backed by a probe; check for any that look extrapolated instead.
3. **`docs/proposal-crew-manifest-2026-05-20.md`** — the new typed deliverable proposal. 13 sections including its own DA self-pass.
4. **`docs/design-cost-and-universal-brain-2026-05-20.md`** — fleet-wide telemetry + 3-layer effectiveness model. 6-phase rollout.

Companion HTML files exist at `explainers/architecture-current-state-2026-05-20.html` and `explainers/proposal-crew-manifest-2026-05-20.html` — they mirror the markdown for visual digestibility. **Skip them; review the markdown sources only.**

## Review angles (priority order)

### P0 — Verifiability of live-probed claims

The architecture audit claims to be grounded in SSH/curl/filesystem probes executed ~14:42 ET today. Audit specifically:

- **Mesh-poller cadence.** Audit §2.3 says `cron.schedule('* * * * *', ...)` at line 1048 of `/Users/alex/Desktop/Code/Kai Executive Assistant/scripts/bot/crons/mesh-poller.js`. Verify the file exists and the line is correct.
- **Per-agent poll intervals.** Audit lists ACD/NAMI/Framer/Chronicle/KMG at 600s. Verify against actual mesh-api `/agents` output if you can reach `http://100.64.114.13:3341/agents`.
- **22 silent failures.** Audit §3.4 cites specific counts: `nami → framer` 13 rejected, `enso → nami` 5 failed, `acd → nami` 3 failed, `acd → conductor` 1 rejected over 7 days. Verify against `/by-route?days=7`.
- **Chronicle status-field bug.** Audit §3.5 claims Chronicle appears in `stale_agents` AND has `status: "active"` simultaneously. Verify.
- **mesh.db at 0 bytes.** Audit §3.2 claims both `~/kai/scripts/mesh/mesh.db` and `~/.kameha/mesh.db` are 0 bytes on Mini. If you can ssh, verify. If you can't, flag as "needs CA to re-probe."
- **The two parallel checkouts.** Audit claims `~/kai/`, `~/acd/`, `~/framer/` are separate trees from `~/Desktop/Code/...`. If you can ssh and `file` each path, confirm they're directories (not symlinks). Also check whether `sync-repos.sh` actually keeps both in sync.

If any probe-claim is wrong, that undermines the entire foundation document. Severity: high.

### P1 — Crew_manifest design soundness

The proposal makes several architecturally consequential calls. Stress-test:

- **Normalized table on (project_id, shoot_date) vs first-class shoots table.** §1.3 picks the tuple key for v1. Is the reschedule edge case (shoot date changes → orphan rows requiring an UPDATE) genuinely manageable? Or does it create a debt that's worse than just bootstrapping a shoots table now?
- **`acd → conductor` direct routing.** §3.1 picks this over routing through Kai. Verify this matches the existing routes table and that conductor's `CAPABILITY_HANDLERS` (line 286-294 of `scripts/conductor-agent.js` in Kai) is the right insertion point. Also verify the assumption that ACD already reads conductor.db directly via env var (the ACD ecosystem.config.js cited at `~/acd/ecosystem.config.js` should have `CONDUCTOR_DB_PATH=/Users/kai/.kameha/conductor.db`).
- **Fuzzy-fallback prerequisite.** §3.2 says conductor's `action.includes(capability)` dispatcher at lines 422-440 would substring-match `crew_manifest_v2` to `crew_manifest`. Verify the lines are right, and verify the substring-match risk is real (might be a regex with anchors that CA misread).
- **Delete-then-insert upsert.** §4.3 picks whole-document replace. Is there a concurrent-emission race CA didn't consider? Two ACD calls overlapping would both delete each other's rows.
- **DA self-pass completeness.** §10 lists 7 concerns. Find one CA missed.

### P1 — Cost economics math

The cost design relies on real numbers from screenshots Alex provided. Audit:

- **Fleet API trend** (Feb $5.45 → Mar $30.74 → Apr $71.98) and the +50%/mo growth claim. Is this growth rate calculation right? Is extrapolation to year-end ($365) sound or anecdotal?
- **Kai $20.65/30d.** Audited from Kai's `logs/api-usage.jsonl` (1,820 entries) and `scripts/lib/model-router.js` `logApiUsage()`. Spot-check by computing one day's cost manually from the pricing rates.
- **Cache hit ratio improvement claim.** Design doc claims 22.6% → 60-80% with cache_control markers. Is this realistic for Anthropic's prompt cache (5-min TTL, 90% discount on cached reads), or wishful?
- **3-layer cost model.** Naive (+100%) vs smart (+20-30%). Are the per-call token deltas (20-50K vs 1-3K) defensible, or arbitrary?
- **SQLite-vss vector index choice.** Is it actually a working extension that's compiled and stable for production, or experimental? Performance assumptions sound for thousands of vectors?
- **Per-agent budgets.** $420/mo total proposed in design §3.5. Reasonable, or over/under-tuned for $30-100/mo current spend?

### P2 — Cross-document consistency

The three docs were written sequentially. Hunt for contradictions:

- Does the cost design (Phase 0 = "instrument first") conflict with the architecture audit's claim that telemetry is now lower urgency?
- Does the crew_manifest's "conductor as knowledge orchestrator" framing align with the cost design's "Layer 1 expansion" framing? Same thing, different language, or actually different paths?
- The architecture audit lists 9 next steps; the cost design has 6 phases; the crew_manifest has 8 decisions. Do these maps overlap correctly, or do they sequence the same work three different ways?
- Any place where CA's recommendations contradict CA's hard boundaries (CLAUDE.md §"Hard Boundaries")?

### P2 — Hidden assumptions

CA's biggest risk is treating its own beliefs as ground truth. Find:

- Anywhere a probe is cited but the citation doesn't actually support the claim.
- Anywhere "X is reasonable" or "X is fine" is asserted without evidence.
- Anywhere CA assumes a third party (Anthropic, Tailscale, Render) won't change behavior — and a recent change would invalidate the design.
- Anywhere a "feature flag" or "graceful degrade" promises behavior the surrounding code can't actually deliver.

### P3 — What's missing

Some failure modes a single agent might not see:

- What happens to crew_manifest if Conductor is down when ACD emits? Does the mesh queue it, lose it, retry?
- What happens to the universal brain if SQLite-vss returns no results? Default behavior described?
- The 50%/month growth assumption: is that organic agent traffic, or driven by Alex's interactive use? If Alex stops doing heavy Telegram chats, does growth flatten? Cost model implicitly assumes continued ramp.
- Universal brain Phase 5 (per-agent context composer) — does it require every agent's daemon to import a shared helper? What's the rollout coordination cost?
- Cache TTL is 5 minutes (Anthropic) — what about agent runs that span >5 min? Does cache lose its discount, defeating the strategy for long sessions?

## Output format

Reply with:

```
## Verdict
PASSED | REVISE | REJECT

## Concerns by severity

### High (blocks ship)
- [concern]: [file:line if applicable] — [why this matters]

### Med (worth fixing before merge)
- [concern]: [file:line if applicable]

### Low (nice-to-have)
- [concern]: [file:line if applicable]

## Specific corrections requested
- [file:line] — replace "X" with "Y" because "Z"

## Questions for Alex (only if BLOCKING for review completion)
- [question]
```

## Constraints

- **Don't propose architectural rewrites.** Point out what's wrong with what's there. If something is genuinely wrong, suggest the smallest correction.
- **Cite file paths and line numbers** when claiming an error. CA can grep its own work — vague concerns waste turns.
- **If a claim looks unverifiable from inside Codex** (e.g., requires SSH to Mini you can't reach), flag it as `needs CA to re-probe` rather than guessing.
- **Don't repeat CA's own DA self-pass** in §10 of the crew_manifest proposal. Read it, then find what it missed.
- **Skip the HTML files.** Review the markdown sources.
- **Token-budget your output.** Tight, scannable concerns beat exhaustive prose. Target under 2,000 words total.

---

*End of Codex prompt. Save Codex's reply to `/Users/alex/Desktop/Code/Code Architect/docs/codex-review-2026-05-20-session-4-results.md` so CA can act on it next session.*

# Intake — Kai: design `crew_manifest` as first concrete deliverable type in action-vocabulary registry

**Origin:** Kai Claude Code session, relayed by Alex via paste 2026-05-19 ~10:30 PM ET.
**Saved per:** [[project-intake-convention-docs-dated-files]] BEFORE CA-side analysis.
**Triggering incident:** Baptist 5/21 shoot — Dr. van der Ven / Maria Diaz testimonial. Sebas's AM-only constraint was logged in project notes from initial scoping. The PM 2nd-camera slot was never converted into action. **Alex personally caught the unstaffed slot at T-2 days.** The system tolerated a passive "logged but unactioned" state from confirmation through almost shoot day.

---

## The structural problem (Kai's framing)

> ACD currently produces `production_strategy` work orders (blocking + shot sequencing + lighting + props) but crew-role requirements are implicit, embedded in prose, not exposed as a structured deliverable. Kai has no machine-readable view of "what roles does this shoot need" to diff against "what roles are confirmed." Conductor DB stores the project + shoot date but no required-roles field. The gap is structural, not a bug in any one agent.

## Tie-in to existing CA work

Natural first test case for the action-vocabulary registry CA is designing (`docs/design-action-vocabulary-registry-2026-05-19.md`). The §5 open questions become much sharper against a real cross-agent typed deliverable rather than evaluated in the abstract. The five questions can be answered against this concrete case in the same session.

## Ask (verbatim from Kai)

CA produces a proposal doc per the W3 pattern covering:

1. **`crew_manifest` schema** — proposed structure for the new typed output. Suggested minimum: `role`, `required_window`, `confirmed_by`, `confirmed_at`, `notes`. One manifest per shoot, attached to project record by `project_id`.
2. **ACD output schema delta** — what the `production_strategy` work order needs to add to emit a `crew_manifest` as a sibling deliverable.
3. **Kai consumer contract** — what verb/action Kai needs in its mesh whitelist to receive the manifest; how Kai diffs required-roles vs confirmed-roles; T-7/T-3/T-24h alert ladder for unfilled roles in daily briefings.
4. **Conductor DB schema delta** — new field or table for the structured manifest (one row per role per shoot, JSON blob, or normalized — CA picks + justifies tradeoff).
5. **(The prompt skips a numbered #5 — looks like a formatting truncation; the missing item is implied by the chain: validation/invariants, e.g., "confirmed shoot date without a `crew_manifest` is a violation.")** Confirmed shoot dates without an attached `crew_manifest` should be flagged as policy violations.
6. **Owners.json scope check** — which repos own which pieces (ACD repo for the schema, Kai repo for the consumer, Conductor DB migration somewhere).
7. **Rollback plan** — what gets reverted if the proposal lands and breaks something downstream.
8. **Answers to the §5 open questions in `docs/design-action-vocabulary-registry-2026-05-19.md`** — Alex will provide them inline; CA seeds the draft with best-guess strawmen so review has something concrete to react to.

## Authority model

W3 draft-and-stage. CA produces the proposal doc. Alex reviews + answers any open questions before any commit lands in ACD, Kai, or Conductor DB. **No code changes in the session that drafts this — proposal only.**

## Sequencing (per Kai)

> Lower urgency than the workflow_dispatch addition above (no time-pressure), but higher leverage long-term because it sets the pattern for every future typed deliverable across the mesh. Fit it into your queue after the morning-actions items 1-2 (T2 probe + Chronicle unlock) and the workflow_dispatch addition. **Reasonable to land it the next time you have a deep-work session.**

## What Kai is doing in the meantime

Kai logged a feedback memory (`feedback_crew_staffing_gap_check.md`) so the rule applies immediately as briefing logic, even before the structured manifest contract lands. That covers the next ~30-60 days while CA's proposal works through approval and implementation.

---

## CA disposition (this session)

Deferring the actual proposal drafting to a dedicated future session per Kai's own "next deep-work session" note. Rationale:
- This proposal is itself a substantial design artifact (4+ schema deltas, 5 open-question answers, owners-scope analysis across 3 repos).
- The current session has accumulated ~12 hours of work + a data-loss incident. Drafting a substantial new design doc on top would compound fatigue risk.
- Workflow_dispatch proposal still pending Alex's approval — clear that first.
- Adding to `docs/NEXT-SESSION.md` priority queue so the next session picks it up cold.

**Queued in NEXT-SESSION.md** as a new entry near the bottom of the action-vocabulary registry decision block.

# Intake — NAMI: "still pending review" nudge job (work order)

**Origin:** NAMI (Social Media Coordinator), authored 2026-05-24, relayed to CA by Alex.
**Source of record:** committed + pushed in the NAMI repo at
`docs/wo-nami-pending-review-nudge-2026-05-24.md` (commit `04100f1`).
**Type:** implementation-ready work order (code request) for CA to build in the NAMI repo.
**Saved per:** intake convention (dated docs/ file, origin attributed, before CA analysis).

---

## What NAMI asks CA to build

A recurring scheduler job that nudges the operator **once per post** when a post is
stuck in `pending_review` and its `scheduled_at` is approaching — closing the
"client never acted in time" gap (the just-shipped `b4306f4` only covers the
"client *did* act" path).

Scope (from the WO):
- `services/scheduler.py` — register interval job (~1h) + handler `nudge_pending_reviews`; honor `NAMI_SCHEDULER_READONLY`.
- `services/notifications.py` — `send_pending_review_nudge(...)`, modeled on `send_review_feedback_alert` (non-urgent, email+bridge+SMS — **no new channel**).
- `database.py` — **additive column `pending_nudge_sent_at TEXT`** on `posts` (try/except ALTER), helper `get_pending_review_posts_due(lead_hours)`, clear-on-reopen in `add_review_feedback`.
- `config.py` — `NAMI_PENDING_NUDGE_LEAD_HOURS` (default 18), `NAMI_PENDING_NUDGE_ENABLED` (default true, kill switch).
- `tests/` — matrix: fires-once, dedup-no-refire, not-yet-due skip, past-due skip, readonly no-op, multi-tenant scoping.

Gotchas flagged: use in-repo `.venv-nami` (sys python is 3.9, fails on `X | None`);
normalize mixed naive/`Z`-suffixed `scheduled_at` to UTC-aware; Render deploys on
push to main (don't touch deploy target); scope every query by `account_id`.

## CA classification

- **DA-gate: MANDATORY.** Touches a DB schema change (additive `posts` column /
  migration) → triggers the §"Devils Advocate gate" criterion. Also a multi-file
  build. Requires a CA-internal DA pass before any push.
- **Action gate: T2** (state-changing, multi-file) → needs explicit Alex go-ahead
  on the specific change. Implementation NOT started; this is a plan-first item.
- **Owners policy:** NAMI-repo edits governed by NAMI's `.kameha/owners.json`
  (verify before editing — fail-closed if absent).
- **Codex review** worth soliciting per [[pattern-solicit-codex-review-on-substantive-work]]
  (migration + tz normalization + multi-tenant scoping are exactly the cross-cutting
  surfaces that came back REVISE before).

## Time-sensitive carve-out (NAMI flagged)

The first real-world trigger is the **DAG Memorial Day post — 2026-05-25 09:00 ET**
(`post_id 151c2a21-d34c-4ad6-9dc5-e48953d267a1`). NAMI recommends a **one-off manual
nudge today** regardless of when the durable job lands. This is decoupled from the
build and is the urgent slice.

## Open question NAMI raised (needs Alex's call)

Pre-existing failure `tests/test_multitenant_scoping.py` — 3 legit-but-unmarked
queries (`api.py` review-link hard-delete ×2, `bridge.py:513` posts update by PK)
missing the `# multitenant-ok` marker the linter wants. NAMI left it rather than
silently fold it. **CA recommendation:** fix as a *separate, isolated commit* (3
annotations + re-run suite), NOT folded into the nudge-job diff — it touches
`bridge.py`, a different surface, and folding it muddies the build's diff
(surgical-change principle). Either NAMI or CA can take it; since CA will be in the
repo for the build, CA can absorb it as its own commit. Acceptance bar for the build
stays "suite no worse than current," so the pre-existing failure is not a blocker.

## Status

QUEUED — plan-first. Not started. Sequence behind the Memorial Day manual nudge
(urgent) and the current session's CA-repo commit. Build needs: owners.json check →
plan → CA-internal DA → Alex go-ahead → implement → Codex review → push.

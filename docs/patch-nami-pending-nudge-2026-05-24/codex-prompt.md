# Codex review prompt — NAMI pending-review nudge job

Paste into the Codex VS Code plugin against the NAMI repo after the patch in this bundle's
`README.md` is applied. Scoped, correctness-focused review.

---

You are reviewing a new recurring scheduler job in a FastAPI/SQLite social-media app
(NAMI). The job nudges the operator (and optionally the client) when a post is stuck in
`pending_review` and its `scheduled_at` slot is approaching, so it doesn't silently miss
its slot. It must nudge **exactly once per post**.

Changed files:
- `database.py` — additive column `posts.pending_nudge_sent_at`; new `get_account_by_id`,
  `get_pending_review_posts_due(lead_hours)` (cross-account sweep, time-window filtered in
  Python), `mark_pending_nudge_sent(post_id)` (atomic claim); clear of the column at the
  caption-fix reopen site.
- `config.py` — `NAMI_PENDING_NUDGE_ENABLED`, `NAMI_PENDING_NUDGE_NOTIFY_CLIENT`,
  `NAMI_PENDING_NUDGE_LEAD_HOURS`.
- `services/notifications.py` — `send_pending_review_nudge` (operator, email+bridge+SMS),
  `send_pending_review_client_reminder` (client email, safelist-gated).
- `services/scheduler.py` — `nudge_pending_reviews` handler + hourly job registration.
- `tests/test_pending_review_nudge.py` — new.

Focus your review on:

1. **Dedup invariant.** Can the same post be nudged twice — across overlapping ticks,
   process restarts, or a send that partially fails after the claim? Is claim-before-send
   the right ordering vs send-before-mark? Any lost-nudge or double-nudge edge case?

2. **Time-window correctness.** `scheduled_at` is a mix of naive (`2026-05-25T09:00:00`)
   and Z-suffixed ISO. Is the naive→UTC assumption safe? Off-by-one at the window
   boundaries (`now < dt <= horizon`)? DST/zone hazards? Behavior on malformed timestamps?

3. **Multi-tenant safety.** The selection query is intentionally cross-account. Confirm no
   client's data/contact can leak to another tenant downstream. Is the `-- multitenant-ok`
   marker placement correct for the repo's linter (`tests/test_multitenant_scoping.py`)?

4. **Client-reminder gating.** Safelist + placeholder-URL + SMTP guards — any path where a
   client gets an email they shouldn't (wrong account, placeholder/localhost URL, or in
   PUBLIC_MODE=false without being safelisted)?

5. **Migration & idempotency.** Additive column in the re-runnable migration loop — safe?
   Any reader that breaks on the new column? Is NULL-as-default correct for existing rows?

6. **Failure isolation.** One bad post (missing account, no review link, send exception)
   must not abort the whole sweep. Confirm per-post try/except and the no-active-link
   fallback (operator-only) behave.

7. **Concurrency.** `coalesce=True` + the atomic claim — sufficient against a slow tick
   overlapping the next? Any SQLite WAL/locking concern under the app's connection pattern?

Report findings as: severity (blocker/should-fix/nit), file:line, the concrete problem, and
a suggested fix. Note anything that needs a test that isn't covered by the matrix in
`test_pending_review_nudge.py`.

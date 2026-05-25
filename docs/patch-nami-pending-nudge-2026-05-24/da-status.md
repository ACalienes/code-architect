# CA-internal Devil's Advocate — NAMI pending-review nudge

**Run:** CA session 5, 2026-05-24. **Gate trigger:** DB schema change (additive
`posts.pending_nudge_sent_at`) + multi-file build → DA mandatory per CLAUDE.md §DA gate.
**Verdict:** **PASS — with 2 operational flags** (not code blockers).

> Formal record destination once `run-ledger.js` lands (W4):
> `~/.code-architect/runs/<run-id>/da-status.json` with `{ "passed": true }`. Pre-W4 this
> markdown is the record (bootstrap policy).

## Adversarial questions asked

1. **Can it spam (the WO's stated fear)?**
   No. Dedup is `posts.pending_nudge_sent_at`, claimed by `mark_pending_nudge_sent`
   with `... WHERE id = ? AND pending_nudge_sent_at IS NULL` — a single atomic UPDATE.
   Two overlapping ticks can't both claim (`coalesce=True` also prevents overlap). The
   claim happens *before* dispatch → at-most-once. ✔

2. **Claim-before-send loses a nudge if all channels fail. Acceptable?**
   Yes, by design. The operator path logs attempted/succeeded; a fully-failed send is
   rare (email is near-zero failure) and the alternative (send-before-mark) risks hourly
   re-spam — the exact thing the WO is built to avoid. Trade-off documented in the
   handler docstring. Mirrors the at-most-once posture of `handle_notification_post`. ✔
   *Residual:* a silent total-channel-failure yields no nudge and no retry. Mitigation:
   the operator path's `logger.info(... attempted=... succeeded=...)` makes it observable;
   if `succeeded=[]` recurs it's a notifications-infra problem, not this job's.

3. **Cross-tenant leakage?** `get_pending_review_posts_due` is intentionally cross-account
   (operator sweep) — flagged with an inline `-- multitenant-ok` marker the linter honors.
   Downstream, each post is dispatched only to *its own* account's contacts: operator email
   is the single global `NOTIFICATION_EMAIL`; the client reminder pulls `client_email` from
   *that post's* `client_portals` row. The multi-tenant test asserts dag→dan, kameha→alex
   with no crossover. ✔

4. **tz correctness?** Reuses the proven idiom at `scheduler.py:637-640`
   (`fromisoformat(raw.replace("Z","+00:00"))` → `.replace(tzinfo=timezone.utc)` if naive).
   Window filter done in Python (not SQL string comparison) precisely because `scheduled_at`
   mixes naive and Z-suffixed forms. Unparseable slot → `continue` (skip, no crash). ✔

5. **Does it interfere with the publish path?** No. The job acts only while
   `status='pending_review'`; the publish filter is `status IN ('scheduled','approved')`.
   Disjoint states — no double-handling, no race with `check_and_publish`. ✔

6. **Migration safety?** Additive `ALTER TABLE … ADD COLUMN`, dropped into the existing
   try/except migration loop → idempotent, safe to re-run, inert if the feature is disabled.
   No backfill needed (NULL = not-yet-nudged is the correct default for every existing row). ✔

7. **Reopen handling correct?** The WO said clear in `add_review_feedback`; verification
   showed that function never reopens to `pending_review`. The only reopen site is the
   caption-fix transaction (`database.py:555`). The clear is placed there. A guard test
   exercises the column reset. ✔ *(This corrects the WO.)*

8. **"No new channel" rule?** Operator path reuses email + bridge + SMS (same as
   `send_review_feedback_alert`); client path reuses the `send_portal_link` email mechanism
   with its safelist + placeholder guards. No new channel introduced. ✔

9. **Kill switches?** Master (`NAMI_PENDING_NUDGE_ENABLED`, gates both registration and
   handler entry) + client-side (`NAMI_PENDING_NUDGE_NOTIFY_CLIENT`) + tunable lead window.
   Runtime-disable without code change. ✔

## Operational flags (carry to apply-time / runbook)

- **F1 — client safelist:** with `PUBLIC_MODE=false`, the client reminder only sends to
  safelisted addresses (`is_email_allowed`). Dan's address must be on `NAMI_EMAIL_SAFELIST`
  for the DAG client reminder to actually leave the building; otherwise it logs-and-skips
  (operator nudge still fires). Confirm before relying on client-side delivery.
- **F2 — not retroactive in time:** this is a durable fix. It will not save the 5/25 09:00 ET
  Memorial Day post unless deployed today. The one-off manual nudge remains the immediate action.

## Test posture

7 DB-layer + 5 handler-layer tests (`test_pending_review_nudge.py`) cover the full WO matrix
plus the multi-tenant and readonly cases. Tests run against a temp SQLite DB (no prod touch).
Acceptance bar: new tests green; existing suite no worse than current (the one pre-existing
`test_multitenant_scoping.py` failure is unrelated — see intake doc).

## Codex

Recommended before push (migration + tz + cross-tenant are exactly the surfaces that came
back REVISE on prior CA work). Prompt: `codex-prompt.md`.

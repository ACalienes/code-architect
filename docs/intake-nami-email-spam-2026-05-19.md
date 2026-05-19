# Intake — NAMI emails blowing up Alex's inbox

**Origin:** Alex, 2026-05-19 ~10:32 ET, via screenshot of NAMI Analytics dashboard for DAG Development & Construction (`Screenshot 2026-05-19 at 10.32.58 AM.png`).
**Verbatim ask:** "add this to the list of things to solve. why am i getting blown up with these emails?"
**Screenshot evidence:** NAMI's `/analytics` page, DAG account, showing weird 30d metrics: Followers 850 (+67), Reach 635 (-36.9%), Views 1.0K (-51.8%), Avg Engagement 16.47% (**+557.7%**), Posts 1, Engagements 140, Shares 81, Top Format Reel. Follower-growth chart shows sharp spike from ~800 → ~850 around 2026-05-13/14.

**Note for the next CA invocation:** the screenshot is NAMI's *dashboard*, NOT the emails themselves. So we have the system that's probably sending the emails, but not the email content. Need 1 disambiguation from Alex (below).

---

## Hypothesis ranking

NAMI has SMTP wired (`nami-platform/test_smtp.py`, `nami-platform/config.py`, `.env.example` referenced SMTP creds). Likely senders that could blow up an inbox:

| Rank | Source | Cadence | Why suspect |
|---|---|---|---|
| 1 | `cb33462 feat(analytics): fast-refresh job for last-14-day post metrics every 3h` | **8/day** | If it emails alerts per-anomaly per-client, the -36.9% reach drop on DAG would trip every cycle |
| 2 | `1bade7d feat(meta-discovery): hourly reconciliation of OOB IG publishes (Path B v1)` | **24/day** | Could email "new OOB IG post detected" each hour for each client |
| 3 | `c4e7e0d fix(bridge): remove orphan expires_at from review_reminder response` (session 3) | per-draft | If review_reminders were silently NameError-ing pre-fix and started firing post-fix, suddenly all pent-up reminders ship at once |
| 4 | DAG-specific analytics anomaly alert (the +557.7% engagement spike triggered a threshold) | per-trip | One-shot trigger, but if threshold logic loops, could re-fire |
| 5 | Render deploy hooks (NAMI hosts on Render — every commit ships) | per-deploy | This week saw 15+ NAMI commits → 15+ deploy notifications |

## What I need from Alex (one question to unblock)

**What's the email subject line + sender domain?** Examples:
- `"DAG: Reach down 36.9%" from notifications@nami...` → hypothesis 1 or 4
- `"Review reminder for DAG draft #..."` → hypothesis 3
- `"New IG publish detected: DAG @..."` → hypothesis 2
- `"Deploy succeeded: nami-i5f3"` from Render → hypothesis 5
- `"Account verification needed"` → unrelated, Meta/IG itself

Forwarding one of the emails (or pasting the subject + sender) eliminates 4 of 5 hypotheses immediately.

## Pre-emptive fix shapes (so next session moves fast)

- **If analytics alerts (hypothesis 1):** add per-client + per-metric dedup + min-interval (e.g., max 1 alert/day/client for the same metric direction). `nami-platform/services/analytics-refresh*` likely the entry point.
- **If meta-discovery (hypothesis 2):** dedup by `instagram_media_id` so reconciliation is idempotent (already documented as Path B v1 — might be missing the dedup table).
- **If review_reminder backlog (hypothesis 3):** suppress reminders older than N hours when the bug-fix lets a previously-stuck queue drain.
- **If Render deploys (hypothesis 5):** silence the Render email channel for the project or filter rule in Gmail.

## Provenance + queue position

- **Saved per** [[project-intake-convention-docs-dated-files]] before CA-side analysis (this doc is the analysis).
- **Added to NEXT-SESSION.md** as a new urgent decision row (NAMI email spam — one-question diagnosis).
- **Not a P0** by audit-doc taxonomy — it's annoying but not a silent-failure / data-loss class. **Treat as P1 unless Alex says it's drowning real signal.**

## Verification path once we have the email subject

```bash
# Replace <SUBSTRING> with a unique fragment of the email subject
grep -rln "<SUBSTRING>" /Users/alex/Desktop/Code/Nami\ Social\ Media\ Coordinator/nami-platform/ 2>/dev/null | grep -v __pycache__ | grep -v .venv
# Or:
grep -rln "send_mail\|smtp.*send\|sgMail\|sendgrid\|MAIL_FROM" /Users/alex/Desktop/Code/Nami\ Social\ Media\ Coordinator/nami-platform/ 2>/dev/null | grep -v __pycache__ | grep -v .venv | head -10
```

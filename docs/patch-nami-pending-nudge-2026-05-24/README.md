# Patch bundle — NAMI "pending review" nudge job

**Authored by:** Code Architect, 2026-05-24 (session 5)
**For:** NAMI repo (`nami-platform/`), in response to
`docs/wo-nami-pending-review-nudge-2026-05-24.md` (NAMI commit `04100f1`).
**CA-side intake:** `docs/intake-nami-pending-review-nudge-2026-05-24.md`.

## Authority model — READ FIRST

Per NAMI `.kameha/owners.json`, **every code file this patch touches is
`human_review_required`, not `bypass_eligible`**:
`services/scheduler.py`, `services/notifications.py`, `database.py`, `config.py`.
**CA drafts; Alex applies by hand.** Only `tests/**` is `auto_merge_after:ca_internal_da`
(CA-writable after a passing DA — see `da-status.md`).

DA gate is **mandatory** here (DB schema change). DA verdict: **PASS with 2 operational
flags** — see `da-status.md`. Codex review recommended before push — prompt in `codex-prompt.md`.

## What this builds

A recurring (hourly) scheduler job that nudges **once per post** when a post sits in
`pending_review` and its `scheduled_at` is approaching — closing the "client never acted
in time" gap (the publish filter is `status IN ('scheduled','approved')`, so a
`pending_review` post silently misses its slot today).

Per Alex's call (session 5), this is **admin + client**:
- **Operator nudge** (existing email + bridge + SMS fanout) so Alex can chase the client.
- **Client reminder** (existing client-email path, safelist-gated — no new channel) so the
  client (e.g. Dan) gets re-pinged directly.

Dedup is a single additive column `posts.pending_nudge_sent_at`, claimed atomically
*before* dispatch (at-most-once; no hourly spam). One master kill switch, one client-side
toggle, one lead-window knob.

## Apply order

1. `database.py` (migration column + 2 helpers + 1-line clear-on-reopen)
2. `config.py` (3 settings)
3. `services/notifications.py` (2 new functions)
4. `services/scheduler.py` (1 handler + 1 job registration)
5. `tests/test_pending_review_nudge.py` (new file — copy from this bundle)

Then run the suite (see "Testing"). Then Codex review. Then commit + push (Alex's go-ahead).

---

## 1. `database.py`

### 1a. Migration — add the dedup column

In the `migrations = [ ... ]` list (currently `database.py:326-…`), add one line near the
other `posts` additions (after `manually_posted_at`, ~line 333):

```python
        "ALTER TABLE posts ADD COLUMN manually_posted_at TEXT",
+       # Pending-review nudge dedup. NULL = not yet nudged; stamped once when the
+       # operator/client nudge fires; cleared on reopen to pending_review (see
+       # apply_caption_fix below) so a re-review gets a fresh nudge.
+       "ALTER TABLE posts ADD COLUMN pending_nudge_sent_at TEXT",
        "ALTER TABLE posts ADD COLUMN publish_host TEXT",
```

(Additive + idempotent — the existing loop wraps each `ALTER` in try/except for re-runs.)

### 1b. Import `timedelta`

`database.py:6` currently:

```python
from datetime import datetime, timezone
```

change to:

```python
from datetime import datetime, timedelta, timezone
```

### 1c. New helper — `get_account_by_id`

No `get_account_by_id` exists today (only `get_account_by_slug`). Add this symmetric
helper next to `get_account_by_slug` (~line 466):

```python
def get_account_by_id(account_id):
    conn = get_db()
    row = conn.execute("SELECT * FROM accounts WHERE id = ?", (account_id,)).fetchone()
    conn.close()
    return dict(row) if row else None
```

### 1d. New helper — `get_pending_review_posts_due`

Add near the other post queries (e.g. after `get_posts_for_account`, ~line 770).
The cross-account SELECT is intentional (operator-wide sweep) and carries an inline
`-- multitenant-ok` marker so `test_multitenant_scoping.py` recognizes it:

```python
def get_pending_review_posts_due(lead_hours):
    """Posts in `pending_review` whose scheduled slot is within the next
    `lead_hours` (and still future), across ALL active accounts, not yet nudged.

    Operator-facing nudge sweep — intentionally cross-tenant at the query level.
    No per-client data crosses tenants: each returned post is dispatched only to
    its own account's operator/client contacts downstream (see scheduler handler).
    The time-window filter is applied in Python (not SQL) because `scheduled_at`
    is a mix of naive and Z-suffixed ISO strings, which sort inconsistently as text.
    """
    conn = get_db()
    try:
        rows = conn.execute(
            """SELECT p.* FROM posts p
               JOIN accounts a ON a.id = p.account_id   -- multitenant-ok: operator nudge sweep
               WHERE p.status = 'pending_review'
                 AND p.scheduled_at IS NOT NULL
                 AND p.pending_nudge_sent_at IS NULL
                 AND COALESCE(a.is_active, 1) = 1"""
        ).fetchall()
    finally:
        conn.close()

    now = datetime.now(timezone.utc)
    horizon = now + timedelta(hours=lead_hours)
    due = []
    for r in rows:
        raw = r["scheduled_at"]
        try:
            dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
            if dt.tzinfo is None:          # SQLite naive strings → treat as UTC
                dt = dt.replace(tzinfo=timezone.utc)
        except (ValueError, AttributeError):
            continue                       # unparseable slot → skip, don't crash
        if now < dt <= horizon:
            due.append(dict(r))
    return due
```

### 1e. New helper — `mark_pending_nudge_sent` (atomic claim)

```python
def mark_pending_nudge_sent(post_id):
    """Atomically stamp pending_nudge_sent_at. Returns True if THIS call claimed
    the nudge (row updated), False if it was already stamped (lost the race).
    The `AND pending_nudge_sent_at IS NULL` guard is the dedup invariant — two
    overlapping ticks can never both send."""
    conn = get_db()
    try:
        ts = now_iso()
        cur = conn.execute(
            "UPDATE posts SET pending_nudge_sent_at = ?, updated_at = ? "
            "WHERE id = ? AND pending_nudge_sent_at IS NULL",
            (ts, ts, post_id),
        )
        conn.commit()
        return cur.rowcount == 1
    finally:
        conn.close()
```

### 1f. Clear-on-reopen — the ONLY reopen-to-pending_review site

The WO said to clear in `add_review_feedback`, but that function never reopens to
`pending_review` (it sets approved/revision/rejected). The single place status flips
*back* to `pending_review` is the caption-fix transaction at **`database.py:555`**.
Add the column reset there:

```python
        conn.execute(
-           "UPDATE posts SET caption = ?, status = 'pending_review', updated_at = ? WHERE id = ?",
+           "UPDATE posts SET caption = ?, status = 'pending_review', "
+           "pending_nudge_sent_at = NULL, updated_at = ? WHERE id = ?",
            (new_caption, ts, post_id),
        )
```

---

## 2. `config.py`

Add three settings alongside the other `os.getenv` bindings in the `Settings` class
(group with the notification settings, ~line 48):

```python
    # ── Pending-review nudge (operator + client reminder when a post is stuck
    #    in pending_review and its slot is approaching). ──
    NAMI_PENDING_NUDGE_ENABLED = os.getenv("NAMI_PENDING_NUDGE_ENABLED", "true").lower() in ("1", "true", "yes")
    NAMI_PENDING_NUDGE_NOTIFY_CLIENT = os.getenv("NAMI_PENDING_NUDGE_NOTIFY_CLIENT", "true").lower() in ("1", "true", "yes")
    NAMI_PENDING_NUDGE_LEAD_HOURS = int(os.getenv("NAMI_PENDING_NUDGE_LEAD_HOURS", "18"))
```

- `NAMI_PENDING_NUDGE_ENABLED` — master kill switch (default on).
- `NAMI_PENDING_NUDGE_NOTIFY_CLIENT` — client-side reminder toggle (default on per Alex's
  admin+client call; set `false` to revert to operator-only).
- `NAMI_PENDING_NUDGE_LEAD_HOURS` — how far ahead of the slot to start nudging (default 18).

---

## 3. `services/notifications.py`

Two new async functions, modeled on `send_review_feedback_alert` (operator) and
`send_portal_link` (client). Add after `send_review_feedback_alert` (~line 921).

```python
async def send_pending_review_nudge(*, post: dict, account: dict, review_url: str) -> dict[str, Any]:
    """Operator nudge: a post is still awaiting client review and its slot is
    approaching. Non-urgent (the slot hasn't passed). Same email + bridge + SMS
    fanout as send_review_feedback_alert so the operator can chase the client."""
    from services import sms
    from routers.bridge import enqueue_notification

    account_name = account.get("name", "Unknown")
    post_topic = (post.get("caption") or "").strip().split("\n", 1)[0][:80] or post.get("post_type", "post")
    scheduled = post.get("scheduled_at", "")

    subject = f"⏳ Pending approval: {account_name} post awaiting client review"
    if len(subject) > 140:
        subject = subject[:137] + "..."

    text_lines = [
        f"You have content pending review — a {account_name} post is still awaiting "
        f"the client's approval and its scheduled slot is approaching.",
        "",
        f"Post: {post_topic}",
    ]
    if scheduled:
        text_lines.append(f"Scheduled: {scheduled}")
    text_lines.extend(["", f"Client review link (forward to client): {review_url}"])
    text_body = "\n".join(text_lines)

    safe_topic = post_topic.replace("<", "&lt;").replace(">", "&gt;")
    html_body = (
        f"<p><strong>You have content pending review.</strong></p>"
        f"<p>A <strong>{account_name}</strong> post is still awaiting the client's approval "
        f"and its scheduled slot is approaching.</p>"
        f"<p><strong>Post:</strong> {safe_topic}<br/>"
        f"<strong>Scheduled:</strong> {scheduled}</p>"
        f'<p><a href="{review_url}">Client review link</a> (forward to the client)</p>'
    )

    correlation = {"kind": "pending_review_nudge", "post_id": post.get("id"), "urgent": False}
    methods_attempted: list[str] = []
    methods_succeeded: list[str] = []

    if settings.SMTP_ENABLED and settings.NOTIFICATION_EMAIL:
        methods_attempted.append("email")
        try:
            await asyncio.to_thread(_send_plain_email_sync, settings.NOTIFICATION_EMAIL, subject, html_body, text_body)
            methods_succeeded.append("email")
        except Exception as exc:
            logger.error("Pending-nudge email failed for post %s: %s", post.get("id"), exc)

    if settings.BRIDGE_ENABLED:
        methods_attempted.append("bridge")
        try:
            await asyncio.to_thread(
                enqueue_notification,
                account_id=account.get("id"), channel="imessage",
                to_addr=settings.IMESSAGE_RECIPIENT or "", body=text_body,
                attachments=[], correlation=correlation,
            )
            methods_succeeded.append("bridge")
        except Exception as exc:
            logger.error("Pending-nudge bridge enqueue failed for post %s: %s", post.get("id"), exc)

    if sms.is_enabled() and account.get("id"):
        methods_attempted.append("sms")
        try:
            sms_results = await sms.send_sms_to_account_recipients(account["id"], text_body[:1500])
            if any(r.get("success") for r in (sms_results or [])):
                methods_succeeded.append("sms")
        except Exception as exc:
            logger.error("Pending-nudge SMS failed for post %s: %s", post.get("id"), exc)

    logger.info(
        "Pending-review nudge (operator): post=%s attempted=%s succeeded=%s",
        post.get("id"), methods_attempted, methods_succeeded,
    )
    return {"success": bool(methods_succeeded), "attempted": methods_attempted, "succeeded": methods_succeeded}


async def send_pending_review_client_reminder(
    *, post: dict, account: dict, client_email: str, client_name: str, review_url: str,
) -> dict[str, Any]:
    """Client-facing reminder: re-ping the client that a post awaits their review.
    Reuses the safelist + placeholder guards from send_portal_link — no new channel,
    just a plain client email. Skips cleanly when SMTP is off, no email is on record,
    the URL is a placeholder, or the address isn't allowed by PUBLIC_MODE/safelist."""
    if not settings.SMTP_ENABLED:
        return {"success": False, "error": "SMTP not configured", "skipped": True}
    if not client_email:
        return {"success": False, "error": "no client email on record", "skipped": True}
    bad_markers = ("localhost", "127.0.0.1", "testtoken", "example.com", "example.test")
    if any(m in (review_url or "").lower() for m in bad_markers):
        logger.warning("Client reminder BLOCKED — placeholder URL: %s", review_url)
        return {"success": False, "error": "placeholder URL, send blocked", "skipped": True}
    if not settings.is_email_allowed(client_email):
        logger.info("Client reminder SKIPPED (PUBLIC_MODE gate): %s", client_email)
        return {"success": False, "error": "blocked by public_mode gate", "skipped": True}

    account_name = account.get("name", "Unknown")
    greeting = f"Hi {client_name}," if client_name else "Hi,"
    subject = f"✅ You have content waiting for your approval — {account_name}"
    text = (
        f"{greeting}\n\n"
        f"You have content pending your review and approval.\n\n"
        f"A {account_name} post is scheduled to go out soon and is waiting on your sign-off. "
        f"Until it's reviewed, it won't be published.\n\n"
        f"Review & approve it here: {review_url}\n\n"
        f"— NAMI"
    )
    html = (
        f"<p>{html_lib.escape(greeting)}</p>"
        f"<p><strong>You have content pending your review and approval.</strong></p>"
        f"<p>A <strong>{html_lib.escape(account_name)}</strong> post is scheduled to go out soon "
        f"and is waiting on your sign-off. Until it's reviewed, it won't be published.</p>"
        f'<p><a href="{review_url}">Review &amp; approve it here</a></p>'
        f"<p>— NAMI</p>"
    )
    try:
        await asyncio.to_thread(_send_plain_email_sync, client_email, subject, html, text)
        logger.info("Pending-review client reminder emailed to %s (post %s)", client_email, post.get("id"))
        return {"success": True, "to": client_email}
    except Exception as exc:
        logger.error("Client reminder failed to %s: %s", client_email, exc)
        return {"success": False, "error": str(exc)}
```

---

## 4. `services/scheduler.py`

### 4a. Register the job

Inside `start_scheduler()`, after the `discover_meta` / `sync_recent_metrics` jobs
(~line 164), gated on the master switch:

```python
    if _settings.NAMI_PENDING_NUDGE_ENABLED:
        _scheduler.add_job(
            nudge_pending_reviews,
            trigger="interval",
            hours=1,
            id="nudge_pending_reviews",
            replace_existing=True,
            coalesce=True,
        )
        logger.info(
            "Pending-review nudge enabled → lead=%dh notify_client=%s",
            _settings.NAMI_PENDING_NUDGE_LEAD_HOURS, _settings.NAMI_PENDING_NUDGE_NOTIFY_CLIENT,
        )
```

### 4b. The handler

Add alongside the other handlers (e.g. after `sync_recent_post_metrics`, ~line 240).
Note the READONLY guard at entry (matches `sync_recent_post_metrics`/`discover_meta`),
and the **claim-before-send** ordering (account/link lookups happen *before* the claim,
so a transient lookup failure doesn't burn the one-shot nudge):

```python
async def nudge_pending_reviews() -> None:
    """Hourly: nudge when a post sits in pending_review and its scheduled slot is
    approaching, so a time-sensitive post doesn't die unreviewed in the queue.
    One nudge per post (dedup via posts.pending_nudge_sent_at, claimed atomically
    before dispatch). Read-only host (laptop standby) is a no-op."""
    if NAMI_SCHEDULER_READONLY:
        logger.info("scheduler read-only on host=%s, skipping pending-review nudge", NAMI_HOST_ID)
        return

    from config import settings as _settings
    if not _settings.NAMI_PENDING_NUDGE_ENABLED:
        return

    from services import notifications

    lead = _settings.NAMI_PENDING_NUDGE_LEAD_HOURS
    try:
        due = database.get_pending_review_posts_due(lead)
    except Exception as exc:
        logger.exception("Pending-review nudge: query failed: %s", exc)
        return
    if not due:
        logger.debug("Pending-review nudge: none due (lead=%dh)", lead)
        return

    base_url = _settings.BASE_URL.rstrip("/")
    nudged = 0
    for post in due:
        post_id = post["id"]
        account = database.get_account_by_id(post["account_id"])
        if not account:
            continue

        # Canonical client review link for this account (one active link per
        # client — see NAMI feedback_one_canonical_review_link). No active link
        # → operator still gets nudged (dashboard context); client reminder skipped.
        links = database.get_review_links_for_account(post["account_id"])
        active = next((l for l in links if l.get("is_active")), None)
        if active:
            review_url = f"{base_url}/review/{active['token']}"
        else:
            review_url = f"{base_url}/dashboard"

        # Atomic claim BEFORE dispatch — guarantees at-most-once (no hourly spam).
        if not database.mark_pending_nudge_sent(post_id):
            continue  # another tick already claimed it

        try:
            await notifications.send_pending_review_nudge(post=post, account=account, review_url=review_url)
            if _settings.NAMI_PENDING_NUDGE_NOTIFY_CLIENT and active:
                portals = database.get_client_portals_for_account(post["account_id"])
                portal = next((p for p in portals if p.get("client_email")), None)
                if portal:
                    await notifications.send_pending_review_client_reminder(
                        post=post, account=account,
                        client_email=portal["client_email"],
                        client_name=portal.get("client_name", ""),
                        review_url=review_url,
                    )
            nudged += 1
        except Exception as exc:
            logger.exception("Pending-review nudge: dispatch failed for post %s: %s", post_id, exc)

    if nudged:
        logger.info("Pending-review nudge: dispatched %d nudge(s) (lead=%dh)", nudged, lead)
```

---

## Testing

```bash
cd "/Users/alex/Desktop/Code/Nami Social Media Coordinator/nami-platform"
.venv-nami/bin/python -m pytest tests/test_pending_review_nudge.py -v
# full suite (expect the one pre-existing test_multitenant_scoping failure unless
# the marker fix lands separately — see intake doc):
.venv-nami/bin/python -m pytest -q
```

Copy `test_pending_review_nudge.py` from this bundle into `nami-platform/tests/`.

## Rollback

Each step is independently revertible. The additive column is inert if left in place
(no reader breaks). Disable at runtime without code changes: `NAMI_PENDING_NUDGE_ENABLED=false`.

## Operational flags (from DA — see `da-status.md`)

1. **Client reminder requires the client email to be safelisted** when `PUBLIC_MODE=false`.
   For the DAG Memorial Day post, confirm Dan's address is on `NAMI_EMAIL_SAFELIST` or the
   client reminder will skip (operator nudge still fires). The **one-off manual nudge today**
   is the reliable path for the 5/25 09:00 ET post regardless.
2. This is a durable fix; it does **not** retroactively nudge the Memorial Day post in time
   unless deployed today. Treat the manual nudge as the immediate action.

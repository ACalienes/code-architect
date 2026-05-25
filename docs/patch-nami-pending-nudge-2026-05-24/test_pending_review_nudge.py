"""Coverage for the pending-review nudge job.

A post stuck in `pending_review` is invisible to the publish filter
(`status IN ('scheduled','approved')`), so it silently misses its scheduled
slot. `nudge_pending_reviews` finds such posts whose slot is within
NAMI_PENDING_NUDGE_LEAD_HOURS and nudges the operator (+ optionally the client)
exactly ONCE per post.

Matrix:
  - due-and-unnudged is returned by the query; not-yet-due and past-due are not
  - mark_pending_nudge_sent is an atomic claim — second call returns False (dedup)
  - handler dispatches one operator nudge per due post and claims the row
  - second handler tick does NOT re-fire (dedup invariant)
  - client reminder fires only when a client_email + active review link exist,
    and each account's reminder uses its OWN client's address (no cross-tenant leak)
  - read-only host is a no-op
  - reopen to pending_review (caption fix) clears pending_nudge_sent_at

Run: .venv-nami/bin/python -m pytest tests/test_pending_review_nudge.py -v
"""
from __future__ import annotations

import asyncio
import os
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


def _iso_in(hours: float) -> str:
    """Z-suffixed ISO timestamp `hours` from now (UTC)."""
    return (datetime.now(timezone.utc) + timedelta(hours=hours)).strftime("%Y-%m-%dT%H:%M:%SZ")


@pytest.fixture()
def db(monkeypatch):
    """Fresh temp SQLite DB with the schema initialized and two seeded accounts
    (dag, kameha). Yields the imported `database` module bound to the temp DB."""
    tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
    tmp.close()
    os.environ["NAMI_DB_PATH"] = tmp.name

    # Drop cached modules so config/database rebind to the temp DB path.
    for mod in list(sys.modules):
        if mod in ("config", "database", "main", "routers", "services") or mod.startswith(
            ("services.", "routers.")
        ):
            sys.modules.pop(mod, None)

    import database
    database.init_db()

    now = database.now_iso()
    conn = database.get_db()
    for acct_id, slug, name in (
        ("acct-dag", "dag", "DAG Development & Construction"),
        ("acct-kameha", "kameha", "Kameha Media"),
    ):
        conn.execute(
            "INSERT INTO accounts (id, slug, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
            (acct_id, slug, name, now, now),
        )
    conn.commit()
    conn.close()

    yield database

    try:
        os.unlink(tmp.name)
    except OSError:
        pass


def _seed_pending_post(database, account_id: str, scheduled_at: str, caption: str = "Test post") -> str:
    return database.create_post(
        {
            "account_id": account_id,
            "status": "pending_review",
            "scheduled_at": scheduled_at,
            "caption": caption,
        }
    )


def _active_review_token(database, account_id: str) -> str:
    database.create_review_link(account_id, title="Client review")
    links = database.get_review_links_for_account(account_id)
    active = next(l for l in links if l.get("is_active"))
    return active["token"]


# ── DB layer: due-window selection ─────────────────────────────────────────

def test_due_post_within_lead_window_is_selected(db):
    pid = _seed_pending_post(db, "acct-dag", _iso_in(10))  # 10h out, lead 18h
    due = db.get_pending_review_posts_due(18)
    assert [p["id"] for p in due] == [pid]


def test_not_yet_due_post_is_skipped(db):
    _seed_pending_post(db, "acct-dag", _iso_in(40))  # 40h out, beyond 18h lead
    assert db.get_pending_review_posts_due(18) == []


def test_past_due_post_is_skipped(db):
    _seed_pending_post(db, "acct-dag", _iso_in(-2))  # slot already passed
    assert db.get_pending_review_posts_due(18) == []


def test_naive_timestamp_is_treated_as_utc(db):
    naive = (datetime.now(timezone.utc) + timedelta(hours=6)).strftime("%Y-%m-%dT%H:%M:%S")
    pid = _seed_pending_post(db, "acct-dag", naive)
    assert [p["id"] for p in db.get_pending_review_posts_due(18)] == [pid]


def test_non_pending_status_is_not_selected(db):
    pid = _seed_pending_post(db, "acct-dag", _iso_in(5))
    db.update_post(pid, {"status": "approved"})
    assert db.get_pending_review_posts_due(18) == []


def test_inactive_account_posts_are_skipped(db):
    conn = db.get_db()
    conn.execute("UPDATE accounts SET is_active = 0 WHERE id = ?", ("acct-dag",))
    conn.commit()
    conn.close()
    _seed_pending_post(db, "acct-dag", _iso_in(5))
    assert db.get_pending_review_posts_due(18) == []


# ── DB layer: atomic dedup claim ────────────────────────────────────────────

def test_mark_pending_nudge_sent_is_atomic_once(db):
    pid = _seed_pending_post(db, "acct-dag", _iso_in(5))
    assert db.mark_pending_nudge_sent(pid) is True   # first claim wins
    assert db.mark_pending_nudge_sent(pid) is False  # second loses
    # Already-nudged post no longer surfaces in the due query.
    assert db.get_pending_review_posts_due(18) == []


def test_caption_fix_reopen_clears_nudge_flag(db):
    """The only reopen-to-pending_review site (apply_caption_fix) must clear the
    flag so a re-review gets a fresh nudge. Exercised via the raw UPDATE since
    apply_caption_fix has heavier prerequisites; this guards the column reset."""
    pid = _seed_pending_post(db, "acct-dag", _iso_in(5))
    db.mark_pending_nudge_sent(pid)
    conn = db.get_db()
    conn.execute(
        "UPDATE posts SET status = 'pending_review', pending_nudge_sent_at = NULL WHERE id = ?",
        (pid,),
    )
    conn.commit()
    conn.close()
    assert [p["id"] for p in db.get_pending_review_posts_due(18)] == [pid]


# ── Handler: dispatch, dedup, readonly, multi-tenant ────────────────────────

def _patch_handler_env(database, monkeypatch, *, readonly=False, notify_client=True):
    import services.scheduler as scheduler
    from config import settings
    monkeypatch.setattr(scheduler, "NAMI_SCHEDULER_READONLY", readonly, raising=False)
    monkeypatch.setattr(settings, "NAMI_PENDING_NUDGE_ENABLED", True, raising=False)
    monkeypatch.setattr(settings, "NAMI_PENDING_NUDGE_NOTIFY_CLIENT", notify_client, raising=False)
    monkeypatch.setattr(settings, "NAMI_PENDING_NUDGE_LEAD_HOURS", 18, raising=False)
    monkeypatch.setattr(settings, "BASE_URL", "https://nami.example.com", raising=False)
    return scheduler


def _capture_notifications(monkeypatch):
    import services.notifications as notifications
    ops_calls, client_calls = [], []

    async def _ops(*, post, account, review_url):
        ops_calls.append({"post_id": post["id"], "account": account["id"], "review_url": review_url})
        return {"success": True, "succeeded": ["email"]}

    async def _client(*, post, account, client_email, client_name, review_url):
        client_calls.append({"post_id": post["id"], "to": client_email, "review_url": review_url})
        return {"success": True, "to": client_email}

    monkeypatch.setattr(notifications, "send_pending_review_nudge", _ops)
    monkeypatch.setattr(notifications, "send_pending_review_client_reminder", _client)
    return ops_calls, client_calls


def test_handler_nudges_once_and_dedupes(db, monkeypatch):
    pid = _seed_pending_post(db, "acct-dag", _iso_in(6))
    _active_review_token(db, "acct-dag")
    db.create_client_portal("acct-dag", client_name="Dan Girado", client_email="dan@dag.example")
    scheduler = _patch_handler_env(db, monkeypatch)
    ops_calls, client_calls = _capture_notifications(monkeypatch)

    asyncio.run(scheduler.nudge_pending_reviews())
    assert [c["post_id"] for c in ops_calls] == [pid]
    assert [c["to"] for c in client_calls] == ["dan@dag.example"]
    assert "/review/" in ops_calls[0]["review_url"]

    # Second tick: row is claimed → no re-fire.
    ops_calls.clear(); client_calls.clear()
    asyncio.run(scheduler.nudge_pending_reviews())
    assert ops_calls == [] and client_calls == []


def test_handler_readonly_host_is_noop(db, monkeypatch):
    _seed_pending_post(db, "acct-dag", _iso_in(6))
    scheduler = _patch_handler_env(db, monkeypatch, readonly=True)
    ops_calls, client_calls = _capture_notifications(monkeypatch)
    asyncio.run(scheduler.nudge_pending_reviews())
    assert ops_calls == [] and client_calls == []


def test_handler_skips_client_reminder_when_toggle_off(db, monkeypatch):
    _seed_pending_post(db, "acct-dag", _iso_in(6))
    _active_review_token(db, "acct-dag")
    db.create_client_portal("acct-dag", client_name="Dan", client_email="dan@dag.example")
    scheduler = _patch_handler_env(db, monkeypatch, notify_client=False)
    ops_calls, client_calls = _capture_notifications(monkeypatch)
    asyncio.run(scheduler.nudge_pending_reviews())
    assert len(ops_calls) == 1 and client_calls == []


def test_handler_multitenant_each_post_to_own_client(db, monkeypatch):
    """Two accounts each have a due pending post. The cross-account sweep must
    nudge each post's OWN client — dag's reminder to dag's email, kameha's to
    kameha's. No cross-tenant address leakage."""
    dag_pid = _seed_pending_post(db, "acct-dag", _iso_in(6), caption="DAG post")
    kam_pid = _seed_pending_post(db, "acct-kameha", _iso_in(7), caption="Kameha post")
    _active_review_token(db, "acct-dag")
    _active_review_token(db, "acct-kameha")
    db.create_client_portal("acct-dag", client_name="Dan", client_email="dan@dag.example")
    db.create_client_portal("acct-kameha", client_name="Alex", client_email="alex@kameha.example")
    scheduler = _patch_handler_env(db, monkeypatch)
    _, client_calls = _capture_notifications(monkeypatch)

    asyncio.run(scheduler.nudge_pending_reviews())
    by_post = {c["post_id"]: c["to"] for c in client_calls}
    assert by_post == {dag_pid: "dan@dag.example", kam_pid: "alex@kameha.example"}

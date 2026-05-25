# Patch — NAMI multitenant-scoping marker fix (pre-existing failure)

**Authored by:** Code Architect, 2026-05-25 (session 5).
**For:** NAMI repo (`nami-platform/`). **Separate from** the pending-nudge build
(`docs/patch-nami-pending-nudge-2026-05-24/`) — kept isolated on purpose so the
nudge-job diff stays clean (touches `routers/`, a different surface).
**Origin:** flagged by NAMI in `docs/wo-nami-pending-review-nudge-2026-05-24.md` ("Pre-existing
failing test, not yours") + CA intake `docs/intake-nami-pending-review-nudge-2026-05-24.md`.

## What this fixes

`tests/test_multitenant_scoping.py` is **already failing on `main`** (confirmed by NAMI by
stashing its own changes). The linter scans `routers/` + `services/` for SQL on tenant
tables and flags any query without `account_id` (or a `multitenant-ok` marker) in its
window. Three legitimately-scoped queries lack the marker.

## Authority

`routers/**` is `human_review_required, not bypass_eligible` per NAMI owners.json →
**CA drafts; Alex applies.** Comment-only (no logic change). **DA: not required**
(comment-only, single repo, no logic/auth/contract change — but each query's tenant-safety
was independently verified by CA before asserting the marker; see "Why each is safe").

## The 3 edits

### 1 + 2. `routers/api.py:875-876` — review-link hard-delete cascade

Inside `deactivate_review_link(link_id, hard=...)`. Add a marker comment above the pair:

```python
    if hard:
        fb_count = conn.execute(
            "SELECT COUNT(*) FROM review_feedback WHERE review_link_id = ?", (link_id,)
        ).fetchone()[0]
+       # multitenant-ok: admin hard-delete of one review link by its global PK
+       # (link existence 404-guarded above via SELECT … WHERE id = ?). No per-client
+       # filter is applicable — this removes exactly the one row identified by PK.
        conn.execute("DELETE FROM review_feedback WHERE review_link_id = ?", (link_id,))
        conn.execute("DELETE FROM review_links WHERE id = ?", (link_id,))
```

(One comment block within the linter's window covers both adjacent statements. If the suite
still flags either line, fall back to an inline `# multitenant-ok` on each.)

### 3. `routers/bridge.py:513` — advance a just-created post to pending_review

Inside the `schedule_content` handler, after the post is created for a validated account:

```python
    if review_request_raw:
        try:
            conn = get_db()
            try:
+               # multitenant-ok: post_id is the row created by this handler above for the
+               # account already validated against ACTIVE_CLIENT_SLUGS at intent time —
+               # a PK update on our own freshly-inserted row, not a cross-tenant query.
                conn.execute(
                    "UPDATE posts SET status = 'pending_review', updated_at = ? WHERE id = ?",
                    (now_iso(), post_id),
                )
                conn.commit()
```

## Why each is safe (verified, not assumed)

- **api.py:875-876** — `deactivate_review_link` SELECTs the link by PK and 404s if absent
  (`api.py:865-868`); the hard branch then deletes that one link + its feedback by PK. It's
  an admin operation on a globally-unique id; no client can reach another client's data
  through it.
- **bridge.py:513** — `post_id` is generated and inserted by the same `schedule_content`
  handler a few lines above (`bridge.py:~470-492`); the account was validated at intent
  ingestion (the bridge multi-tenant check covered by `test_bridge_intents.py`). The UPDATE
  targets that one PK.

## Test

```bash
cd "/Users/alex/Desktop/Code/Nami Social Media Coordinator/nami-platform"
<your venv>/bin/python -m pytest tests/test_multitenant_scoping.py -q   # should go green
```

(The WO referenced `.venv-nami`; that path didn't resolve from CA's environment — use
whichever interpreter runs NAMI's suite. The fix is comment-only, so no runtime behavior
changes regardless.)

## Rollback

Delete the three comment blocks. Zero functional impact either way.

---
name: wo-code-architect-oauth-client-deleted-2026-05-22
description: Work order for Code Architect — Google OAuth client was deleted on the Mac Mini, taking down ALL Google APIs (Sheets, Gmail, Calendar, Drive). 364 consecutive sheet-sync failures since 5/21 9:00 AM ET. Hotfix class.
metadata:
  type: project
---

# WO — Code Architect: Google OAuth client deleted (hotfix)

**Source**: Kai audit, 2026-05-22 ~3:15 PM ET
**Class**: `hotfix`
**Authority**: T2 — Alex approval required before any commit/push or credential write
**Suggested invocation**: `code-architect implement "restore Mac Mini Google OAuth after client deletion" --class=hotfix`

## TL;DR

The OAuth client backing `~/.kai/credentials.json` on the Mac Mini was deleted in Google Cloud Console at ~5/21 9:00 AM ET. Every `oauth2.googleapis.com/token` refresh now returns `{"error":"deleted_client"}`. All Google-API surfaces in the deployed bot are down — not just Sheets. Likely collateral of Card 1 of [[paste-cards-credential-rotation-2026-05-17]] being executed as a delete instead of a `Reset Client Secret`.

## What's broken (verified via Mac Mini logs)

- **Sheets sync** — `consecutiveFailures: 364`, last success `2026-05-21T12:55:00Z` (= 8:55 AM ET). 5-min cron in `scripts/bot/crons/shoots.js:146`.
- **Gmail scan** — `crons/email-qb → emailScan` failing every 30 min in `logs/errors.jsonl`.
- **Briefing reply detection** — `crons/briefing-replies → scanForReplies` failing same cadence.
- **Calendar fetch** — `crons/shoots → getTodayProductionEvents` failing (`get-calendar.js`).
- **Drive** — not exercised on a cron, but same OAuth client, so any read will fail.
- All failures resolve to `scripts/lib/google-auth.js:38` (`reject(new Error('Token refresh failed: ' + data))`).

## Root cause (1 line)

The OAuth 2.0 Client ID `492365977549-irq9jb48vlkq5op89...` referenced by `/Users/kai/.kai/credentials.json` no longer exists in Google Cloud Console — Google's `/token` endpoint returns `deleted_client` for every refresh attempt.

## Evidence

- **First failure**: `[5/21/2026, 9:00:01 AM] syncToSheet FAILED: Token refresh failed: { "error": "deleted_client", "error_description": "The OAuth client was deleted." }` — `/Users/kai/kai/logs/sheets-sync.log`
- **Last success**: `[5/21/2026, 8:55 AM] syncToSheet: ...` (and matching `lastSync: "2026-05-21T12:55:00.826Z"` in `/Users/kai/kai/logs/sheets-sync-state.json`).
- **`errors.jsonl` (Mac Mini)**: 113 token-refresh errors, first at `2026-05-21T13:00:01.099Z`, spread across `crons/email-qb`, `crons/briefing-replies`, `crons/shoots`.
- **Mac Mini creds file**: `/Users/kai/.kai/credentials.json` (412 bytes, mtime Feb 16 — never updated post-rotation), client_id prefix `492365977549-irq9jb48vlkq5op89`.
- **Mac Mini tokens file**: `/Users/kai/.kai/tokens.json` (817 bytes, mtime May 21 08:01 — last successful refresh, ~55 min before deletion).
- **Telegram alert source**: `checkSyncAlert()` in `scripts/lib/sheets-sync.js:371` fires once per 5-min cron when `consecutiveFailures >= 3`. That's where the user-facing notifications are coming from.

## Affected files (Kai repo)

- `scripts/lib/google-auth.js:6-50` — central refresh path; both legacy `getAuth()` and async `getAuthAsync()` route through this client_id/client_secret pair.
- `scripts/lib/sheets-sync.js:371-378` — Telegram alert producer.
- `scripts/bot/crons/shoots.js:146-164` — sync-to-sheet cron + alert fan-out.
- `scripts/bot/crons/email-qb.js`, `scripts/bot/crons/briefing-replies.js` — also auth-dependent.
- `~/.kai/credentials.json` (Mac Mini) — must be replaced with new client ID/secret.
- `~/.kai/tokens.json` (Mac Mini) — refresh token must be regenerated against the new client.

## What CA should do

1. **Confirm with Alex which path was taken in Google Cloud Console.** If the client was deleted (not just secret-reset), Step 2 = create a new OAuth 2.0 Client ID (Desktop app type, matching original scopes: `gmail.modify`, `calendar`, `drive.readonly`, `spreadsheets`, contacts read). If the original is recoverable inside Google's 30-day deletion window, prefer recovery — keeps client_id stable across the mesh.
2. **Stage updated `~/.kai/credentials.json`** with the new (or recovered) `client_id` + `client_secret`. Do NOT commit credentials.json (it's git-ignored; this is a Mac-Mini-only edit).
3. **Regenerate refresh token** via OAuth Playground per Card 1 Step 2 of [[paste-cards-credential-rotation-2026-05-17]], scopes must match what google-auth.js asks for. Write to `~/.kai/tokens.json`.
4. **Smoke test (read-only) on the Mac Mini before declaring done**:
   - `node -e "require('./scripts/lib/google-auth').getAuthAsync().then(a => a.getRequestHeaders()).then(h => console.log('OK',!!h.Authorization)).catch(e => {console.error(e.message); process.exit(1)})"`
   - `node scripts/get-calendar.js --days=1 --past=0` should print events, not throw.
   - One sheet-sync cron tick — verify `sheets-sync-state.json.consecutiveFailures` resets to 0 and `lastSync` advances.
5. **Suppress the noise floor while fixing.** 5-min × 24h ≈ 288 more Telegram alerts if this drags. Options:
   - (preferred, no code change) `pm2 stop kai-bot` while Alex is in the Google console; restart after creds land.
   - (code option, only if CA judges the cron noise is the real issue) gate `checkSyncAlert()` so it only fires once per N hours, not every tick. Note this is a behavior change — escalate to Alex if you go this route.
6. **Post-fix verification** — confirm Gmail, Calendar, Sheets all return real data; flip `consecutiveFailures` to 0 and observe one clean cycle of each cron.

## Hard constraints (per Kai's CLAUDE.md + memory)

- **Never commit credentials.** `~/.kai/credentials.json` and `~/.kai/tokens.json` live outside the repo for a reason.
- **No force-push from automation** ([[feedback-no-force-push-in-crons]]).
- **Spec must match live enforcement** ([[feedback-spec-must-match-live-enforcement]]) — if CA touches `google-auth.js`, the scopes and client_id usage in code must match what's regenerated in the OAuth Playground. Read google-auth.js line-by-line, don't trust a stale memory.
- **DA before ship** on any code change beyond a credential swap ([[feedback-da-standard]]).
- **Verify before recommending from memory** ([[feedback-verify-before-recommending]]) — the credential rotation card was drafted 5 days ago; reconfirm the OAuth Playground scopes against what google-auth.js actually requests today before pasting.

## Out of scope (do NOT do)

- Don't migrate to Keychain in this hotfix (Card 3 of the rotation paste-cards is a separate effort).
- Don't refactor `google-auth.js` while restoring it. Minimum-viable change ([[karpathy-4-principles]]).
- Don't touch KMG, ACD, or any other agent's auth — this is a Kai-side credentials issue.
- Don't open a PR until Alex confirms the new OAuth client ID is the one to commit to. Stage changes; ask before push.

## Done-when checklist

- [ ] New (or recovered) OAuth client exists in Google Cloud Console; Alex has the client_id + secret in hand.
- [ ] `~/.kai/credentials.json` on Mac Mini updated; `chmod 600` confirmed.
- [ ] `~/.kai/tokens.json` on Mac Mini regenerated; backed up old version (`.bak`).
- [ ] Smoke tests in Step 4 above all pass.
- [ ] `logs/sheets-sync-state.json.consecutiveFailures = 0`, `lastSync` within last 5 min.
- [ ] No new `deleted_client` entries in `logs/errors.jsonl` for ≥30 min.
- [ ] Telegram notification confirming sync restored sent to Alex (Kai will fire this once CA flips state to green).

## Reply

CA uses `fire-and-forget` against Kai per manifest; no inbound mesh message needed. Kai will poll `logs/sheets-sync-state.json` for restoration and notify Alex when consecutiveFailures resets.

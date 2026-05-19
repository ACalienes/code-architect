# Intake — Audit A3: Laptop automation inventory

**Origin**: Code Architect (overnight audit, self-authored).
**Date**: 2026-05-19.
**Scope**: All scheduled/persistent automations on Alex's laptop (`/Users/alex/`).
**Mode**: Read-only. No services started/stopped/altered.

---

## 1. Summary

| Type | Count | Notes |
|---|---:|---|
| User crontab entries | **0** | `crontab -l` → `no crontab for alex`. Confirms LE session-3 finding: no cron touches Kameha repos from laptop. Kai's hourly cron lives on Mac Mini. |
| User LaunchAgents (`~/Library/LaunchAgents/`) | **22 plists** | 10 Kameha-related, 12 third-party (Adobe/Dropbox/Google/OpenAI/Steam). |
| System LaunchDaemons (Kameha-related) | **0** | `/Library/LaunchDaemons/` has no `kai|kameha|claude|nami|framer|acd|conductor|chronicle` matches. |
| `launchctl list` running entries (non-dash PID) | 217 of 563 | OS noise dominant; only Kameha entry with active PID = `com.kameha.kaimoku-sync` (1667), `application.com.kameha.kaimoku-sync.345907095.345907150` (1719). All other Kameha labels show PID `-` (loaded, fire on schedule). |
| Local PM2 on laptop | **none** | `pm2 not found`. Confirms PM2 lives on Mini only. |
| Git hooks (non-sample) across 12 Kameha repos | **1** | Only `Kameha Pitch Deck Engine/.git/hooks/pre-commit` (impeccable design-quality gate). All other 11 repos = zero hooks. |
| VS Code user `tasks.json` | none | `~/Library/Application Support/Code/User/tasks.json` absent. |
| Cursor config dir | absent | `~/.cursor/` does not exist. |
| Backup tool processes | TimeMachine only | `backupd` + `backupd-helper`. No rclone/restic/BackBlaze/Arq. |

---

## 2. Per-automation table (Kameha-relevant only)

| Label / name | Type | Schedule | Targets / what it mutates | Last-fired evidence | Health |
|---|---|---|---|---|---|
| `com.kai.claude-code-sync` | LaunchAgent (`~/Library/LaunchAgents/com.kai.claude-code-sync.plist`) | StartInterval 900s (15 min) + RunAtLoad | rsync `~/.claude/projects/-Users-alex-Desktop-Code-Executive-Assistant/*.jsonl` + `memory/` → `kai@10.0.0.79:/Users/kai/.claude/projects/...`. Read-only on laptop, writes on Mini side. Script: `/Users/alex/.kai/sync-claude-code.sh`. | `/tmp/kai-claude-sync-launchd.log` last modified **May 17 03:06** — 2 days stale (system asleep / no fresh runs logged since). | **DEGRADED.** Plist still loaded (`launchctl list` shows it with PID `-`), but launchd log hasn't rotated since 2026-05-17. Script silently `exit 0`s when Mini unreachable, so degraded ≠ broken — needs runtime check tomorrow. No laptop-repo writes; safe for CA. |
| `com.kameha.cfo.daily-snapshot` | LaunchAgent | Daily 06:00 + RunAtLoad | `python3 /Users/alex/Desktop/Code/CFO/scripts/daily_snapshot.py` — writes inside CFO repo | log `/Users/alex/Desktop/Code/CFO/logs/snapshot-launchd.log` → **May 18 06:00:13** | Healthy. CFO-owned. Does not touch CA. |
| `com.kameha.cfo.alerts-daily` | LaunchAgent | Daily 08:00 | `send_alerts.py --daily --quiet` (Telegram + CFO log writes) | `alerts.log` → **May 18 08:00:15** | Healthy. CFO-owned. |
| `com.kameha.cfo.alerts-weekly` | LaunchAgent | Mondays 08:00 (Weekday=1) | `send_alerts.py --weekly` | Same log; last Monday was May 18 — fired. | Healthy. CFO-owned. |
| `com.kameha.cfo.alerts-monthly` | LaunchAgent | Day=1 each month 08:00 | `send_alerts.py --monthly` | Same log; next fire 2026-06-01. | Idle but healthy. |
| `com.kameha.cfo.heartbeat` | LaunchAgent | StartInterval 900s + RunAtLoad | `python3 /Users/alex/Desktop/Code/CFO/scripts/heartbeat.py` — writes CFO logs only | `heartbeat.log` → **May 18 23:09:37** (≤24h fresh) | Healthy. CFO-owned. |
| `com.kameha.cfo.qb-keepalive` | LaunchAgent | Daily 12:00 + RunAtLoad | `~/Library/Application Support/kameha-cfo/qb-keepalive-replica.py` (QuickBooks token refresh) | `~/Library/Logs/kameha-cfo/qb-keepalive.log` → **May 18 12:00:04** | Healthy. CFO-owned. |
| `com.kameha.cfo.tax-quarterly` | LaunchAgent | Apr/Jun/Sep/Jan 12th 08:00 | Telegram nudge 3 days before IRS deadline | Idle (next fire 2026-06-12). | Dormant-correct. CFO-owned. |
| `com.kameha.graid-automount` | LaunchAgent | WatchPaths SystemConfiguration + StartInterval 60s + RunAtLoad | `/Users/alex/scripts/mount-graid.sh` (mount external Thunderbolt RAID; doesn't touch repos) | `mount-graid.log` → **May 18 17:49:58** | Healthy. Filesystem-mount only. |
| `com.kameha.kaimoku-sync` | LaunchAgent | RunAtLoad + KeepAlive | `open -W -a "Kaimoku Sync.app"` (GUI app keepalive; Kaimoku Kabushiki sync — unrelated to Kameha repos) | PID 1667 active right now per `launchctl list`. | Healthy. App-level. Does not touch Kameha repos. |
| `pre-commit` hook on `Kameha Pitch Deck Engine` repo | Git hook (`.git/hooks/pre-commit`, 33 lines) | On every commit in that repo only | Runs `npx impeccable detect` against staged HTML/CSS/JSX/TSX. Read-only — fails the commit, doesn't mutate files. | n/a (event-driven) | Healthy. Confined to that repo. Cannot clobber CA. |
| TimeMachine `backupd` / `backupd-helper` | System (Apple) | Continuous, OS-managed | Whole-disk backup to TM target | PIDs 564, 5682 alive | Healthy. Read-only relative to working tree. |

**Repos with zero non-sample hooks** (verified): Code Architect, Kai Executive Assistant, Nami Social Media Coordinator, Framer, ACD, CFO, Chronicle, Enso-The-Editor, Offer Architect and Pricing Strategist, Kameha Lead Engine, Kameha Media Group. Kameha Website has no `.git` directory at this path.

**Non-Kameha LaunchAgents present** (noted for completeness, not analyzed): Adobe GC Invoker, Adobe ccxprocess, Dropbox (3 plists), Google updater/keystone (3 plists), OpenAI Atlas (2 plists), Steam clean. None of these touch Kameha repos.

---

## 3. Risk findings

### P0 — anything that could clobber CA's work without authorization
**None.** No automation on the laptop writes into `/Users/alex/Desktop/Code/Code Architect/`. The only write-capable Kameha jobs write into the CFO repo (CFO-scoped) or to external paths (`~/Library/Logs`, `~/.kai/`, `/tmp/`). The 15-minute `com.kai.claude-code-sync` is laptop→Mini one-way rsync of Claude Code session JSONLs only; it does not touch repo working trees.

### P1 — anything unexpectedly running or worth flagging
1. **`com.kai.claude-code-sync` log is 2 days stale** (`/tmp/kai-claude-sync-launchd.log` last touched 2026-05-17 03:06). Plist still loaded and reports no PID currently. Script gracefully exits when Mini is unreachable, so a 2-day gap is plausible (laptop asleep, or Mini Tailscale down at sample times). Worth a sanity-check tomorrow morning that the next fire writes a fresh line.
2. **`com.kameha.graid-automount` StartInterval is 60s**, meaning the mount script runs every minute as a fallback. Confirmed harmless (mount idempotency), but it's the highest-frequency Kameha job on the box and worth knowing about for log-noise budgeting.
3. **`com.kameha.kaimoku-sync` is a `KeepAlive` GUI relaunch loop** for an app named "Kaimoku Sync.app". Independent of the Kameha mesh — appears to be a personal-finance / banking tool (Kaimoku = Japanese stockholder sync). Flagging only because the name collides with Kameha namespace; not actually a mesh component.

### P2 — dormant
- `com.kameha.cfo.alerts-monthly` (next fire June 1).
- `com.kameha.cfo.tax-quarterly` (next fire June 12).
- Both correctly idle.

---

## 4. Confirmations against the prompt's specific questions

| Question | Answer |
|---|---|
| Is `com.kai.claude-code-sync.plist` still running? | **Loaded, yes.** `launchctl list` confirms `com.kai.claude-code-sync` is registered (status 0, no current PID — not currently executing, normal between fires). Last log entry 2026-05-17 03:06 → either Mini was unreachable on recent attempts or laptop was asleep through scheduled fires. **Not broken**, possibly degraded — worth a manual fire tomorrow to verify. |
| What does it sync exactly? | One-way push, laptop → Mini, via `rsync -az`: (1) `~/.claude/projects/-Users-alex-Desktop-Code-Executive-Assistant/*.jsonl` (Claude Code session transcripts) → `/Users/kai/.claude/projects/...`; (2) `memory/` subdir of same path. Skips if `ssh -o BatchMode=yes kai@10.0.0.79 true` fails the 2s health check. **Does not touch any Kameha repo working tree.** |
| Is the laptop NOT running Kai's cron? | **Confirmed by absence.** `crontab -l` → `no crontab for alex`. No `/etc/cron.d/`, no `/etc/periodic/` on this macOS build. Kai's hourly auto-backup cron lives on the Mac Mini, as documented in MEMORY.md. |
| Any cron on laptop touching Kameha repos? | **None.** Re-confirms LE session-3 audit. The only commit-time mutator is the single git pre-commit hook on `Kameha Pitch Deck Engine`, which is a read-only design-quality scanner that fails the commit on issues — it does not write to the working tree. |

---

## 5. Recommended actions

1. **(P1, low-effort)** Tomorrow morning, tail `/tmp/kai-claude-sync-launchd.log` after a wake event to confirm `com.kai.claude-code-sync` actually fires. If still stale after 24h+ of laptop being awake, manually invoke `/Users/alex/.kai/sync-claude-code.sh` once and inspect output. No CA blocker either way.
2. **(P2, optional)** Consider lowering `com.kameha.graid-automount` StartInterval from 60s to e.g. 300s if the GRAID is normally always mounted — the WatchPaths trigger already covers reconnect cases, so the 60s poll is mostly redundant. Not urgent; not a CA concern.
3. **(P3, hygiene)** The `Kameha Website` directory under `/Users/alex/Desktop/Code/` is not a git repo on this laptop. If it should be tracked, that's a separate issue — but it means it's not in scope for any hook audit.
4. **(No action needed)** All other LaunchAgents are owned by CFO (read into CFO repo only) or non-Kameha third-party apps. None cross CA's boundary.

---

## 6. Audit posture

Read-only. Zero state changes made. All findings derive from filesystem reads, `launchctl list` (informational), `crontab -l`, log `stat` calls, and `pgrep`. No services were toggled. No plists were edited. Run-ledger entry: this audit is T1 (read-only `code-architect map`-equivalent activity); no run-id required.

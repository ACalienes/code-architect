# Phase 0b — schedule the dead inbox-drainers (grounded)

**Code Architect · 2026-05-25.** Kai flagged 4 agents with `failed` (delivered-but-never-drained) mesh messages needing ~60s timers. Grounded against the actual repos, it's narrower:

| Agent | Drainer exists? | Action |
|---|---|---|
| **CFO** | ✅ `CFO/scripts/process_inbox.py` (unscheduled; log shows prior runs) | **Schedule ~60s** |
| **Lead Engine** | ✅ `Kameha Lead Engine/shared/inbox_processor.py` | **Schedule ~60s** |
| **Chronicle** | ❌ none found; repo untouched 8 weeks | **Skip** — don't build a throwaway drainer for a dormant agent on a mesh we're retiring. Revisit if Chronicle is revived. |
| **NAMI** | ⚠️ `inbox.py` is the *social* inbox (Meta DMs/comments), not a mesh drainer | **Different fix** — NAMI receives mesh via the Mini **bridge**; its failures are bridge-side. Investigate the bridge delivery/ack path separately, not a cron. |

Net: schedule **CFO + LE**. Each is the agent's own slice (own repo/process); CA drafts, owner applies on the Mini.

## Recommended schedule (owner applies on the Mini)

These are one-shot scripts → run them on a ~60s interval. Two clean options; the Mini already runs **PM2**, so option A fits the existing pattern:

**A — PM2 cron-restart (every minute):**
```bash
# CFO
pm2 start /Users/kai/<cfo-path>/scripts/process_inbox.py \
  --name cfo-inbox-drainer --interpreter <cfo-venv>/bin/python \
  --no-autorestart --cron-restart="* * * * *"
# Lead Engine
pm2 start /Users/kai/<le-path>/shared/inbox_processor.py \
  --name le-inbox-drainer --interpreter <le-venv>/bin/python \
  --no-autorestart --cron-restart="* * * * *"
pm2 save
```
(`--no-autorestart` + `--cron-restart` = run once per minute, not hammer-loop. Owner fills the real path + venv interpreter.)

**B — launchd `StartInterval=60`** (Mac-native, independent of PM2): one plist per script in `~/Library/LaunchAgents/`, `StartInterval` 60, `ProgramArguments` = [venv python, script path].

**Verify after:** the agent's `failed` count stops growing (re-check `GET /stats?days=1`); stuck messages drain.

## Throwaway note (honest)

Under the blessed cutover, these drain the *old* mesh. But scheduling an **existing** script is near-zero effort and gives real transition relief, and the "run a drainer on a timer" discipline ports straight to the Shared Layer (where the prototype's `drain()` gets the same ~60s runner). So CFO+LE are worth it; building new ones (Chronicle) is not.

## Relay to Kai + owners (copy-paste)

> **Phase 0b grounded:** only CFO + LE have existing inbox processors to schedule (~60s). Chronicle has none + is 8 weeks dormant — skipping unless revived. NAMI's mesh failures are **bridge-side** (its `inbox.py` is the social inbox, not a mesh drainer) — needs a separate look at the bridge delivery/ack path, not a cron. CFO + LE owners: schedule your processor per the snippet in `code-architect/docs/phase-0b-drainers-2026-05-25.md` (PM2 `--cron-restart` or launchd `StartInterval=60`). Kai — confirm the bridge path for NAMI's 22 failed?

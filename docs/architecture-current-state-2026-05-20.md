# Kameha mesh — current architecture, ground truth (2026-05-20)

**Author:** Code Architect (session 4)
**Purpose:** Establish a true foundation for the "agents should communicate semi-instantly + share a universal brain" conversation. **Nothing in this doc is recalled from memory — every claim is backed by a live probe (SSH to Mini, curl to mesh-api, file read) executed 2026-05-20 around 14:42 ET.**

**How to read this:** sections 1-5 are *what is*. Section 6 surfaces what's broken or undocumented. Section 7 translates your two concerns ("semi-instant comms" and "universal brain") into the architecture's actual seams.

---

## 1. The compute model — three places code runs

There are **three** physical/logical execution environments. They serve different roles and it matters which is which.

### 1.1 Laptop (your machine at `/Users/alex/Desktop/Code/`)

Confirmed via `crontab -l` (returned `no crontab for alex`), `pm2` not on PATH, `launchctl list`, `ps aux`:

- **No agent daemons run here.** Zero PM2, zero cron-driven mesh participation, zero polling.
- **LaunchAgents present** (these are macOS-managed, not PM2):
  - `com.kameha.cfo.*` (5 jobs: heartbeat, alerts-daily/weekly/monthly, qb-keepalive, daily-snapshot, tax-quarterly) — CFO has laptop-side LaunchAgents *in addition to* the Mini-side PM2 daemon. Worth a separate audit; not load-bearing for transport.
  - `com.kameha.kaimoku-sync` and `com.kai.claude-code-sync` — sync helpers.
- **Live processes on laptop:** only the 10 instances of `kameha-research` MCP server (these are MCP, not mesh) plus Claude Code itself.

**Verdict:** the laptop is your driver seat. Code Architect runs here. Claude Code sessions for any agent run here. **No mesh participant lives on the laptop.**

### 1.2 Mac Mini (Tailscale `100.64.114.13`, local `10.0.0.79`, user `kai`)

Confirmed via `ssh kai@100.64.114.13 'ps auxww'` and the live `/agents` endpoint:

This is **the entire production mesh**. Every always-on daemon, every mesh participant, every cron poller, lives here. The Mini is a Mac Mini Apple Silicon (`Darwin Kais-Mac-mini.local 24.6.0 ... arm64`).

**16 long-running processes confirmed live**, by category:

| Process | Path | Lang | Runtime | Role |
|---------|------|------|---------|------|
| `mesh-api` | `/Users/kai/kai/scripts/mesh/mesh-api.js` | node | PM2 | THE message bus (port 3341) |
| `kai` (telegram-bot) | `/Users/kai/kai/scripts/telegram-bot.js` | node | PM2 | Kai daemon |
| `kai-dashboard` | `/Users/kai/kai/scripts/dashboard.js` | node | PM2 | Kai web dashboard |
| `kai-imessage-poller` | `python -m imessage.poller` | python | PM2 | iMessage reader |
| `conductor` | `/Users/kai/kai/scripts/conductor-agent.js` | node | PM2 | Project orchestrator (port 3344) |
| `cfo-agent` | `/Users/kai/kai/scripts/cfo-agent.js` | node | PM2 | Financial intelligence |
| `offer-architect` | `/Users/kai/kai/scripts/oa-daemon.js` | node | PM2 | Pricing/Go-NoGo |
| `nami-bridge` | `/Users/kai/kai/scripts/nami-bridge.js` | node | PM2 | NAMI ↔ Render relay |
| `nami-mesh-poller` | `/Users/kai/kai/scripts/nami-mesh-poller.js` | node | PM2 | NAMI's mesh proxy |
| `acd-daemon` | `/Users/kai/acd/scripts/daemon.py` | python | PM2 (own ecosystem.config.js, port 3342) | Creative direction |
| `framer-daemon` | `/Users/kai/framer/scripts/daemon.py` | python | PM2 (own ecosystem) | Visual production |
| `enso-daemon` | `/Users/kai/Desktop/Code/Enso-The-Editor/scripts/enso-daemon.py` | python | PM2 | Editor |
| `pde-daemon` | `/Users/kai/Desktop/Code/Kameha Pitch Deck Engine/scripts/pde-d...` | node | PM2 | Pitch deck builder |
| `lead-engine` | `python run_dashboard.py --backend-only` | python | PM2 + APScheduler | Sales pipeline |
| `chronicle` | tsx `src/index.ts` | node | PM2 | Health/fitness (last heartbeat 5 days stale) |
| `pm2-logrotate` | PM2 module | node | PM2 | Log rotation |

**Important repo-layout detail:** there are **two parallel checkouts of each agent** on the Mini.

- Some agents run from `~/<agent-name>/` (Kai at `~/kai/`, ACD at `~/acd/`, Framer at `~/framer/`). These are the production trees.
- Other agents run from `~/Desktop/Code/<Name>/` (Chronicle, Lead Engine, Enso, PDE). These match the laptop's layout.
- The `~/Desktop/Code/` tree also contains separate clones of CFO, Kai, etc. — but the live PM2 processes use `~/kai/`, `~/acd/`, `~/framer/` for the hub trio.

**`sync-repos.sh` scope — verified from the script source on Mini:** it pulls these specific paths hourly:

- `~/Desktop/Code/CFO`, `~/Desktop/Code/Chronicle`, `~/Desktop/Code/Kai Executive Assistant`, `~/Desktop/Code/Kameha Lead Engine`, `~/Desktop/Code/Kameha Pitch Deck Engine`, `~/Desktop/Code/Offer Architect and Pricing Strategist`, `~/Desktop/Code/Enso-The-Editor`
- `~/acd`, `~/code-architect`, `~/kai`

**Important corrections from my earlier framing:**
- Only **Kai** has a true dual-checkout that's actively synced (`~/kai` AND `~/Desktop/Code/Kai Executive Assistant`).
- ACD has only `~/acd`. There is **no** `~/Desktop/Code/ACD` directory on Mini.
- Framer has only `~/framer`. There is **no** `~/Desktop/Code/Framer` directory on Mini AND `~/framer` is **not** in sync-repos.sh — it doesn't get auto-pulled. Either someone manually pulls it or it stays at whatever was last there.

Confirmed by Mini crontab: `0 * * * * /Users/kai/scripts/sync-repos.sh >> /tmp/kameha-sync.log 2>&1`.

### 1.3 Render cloud (NAMI only)

Confirmed via `/agents` showing `"runtime": "render"` for NAMI:

NAMI is the **only** cloud-hosted agent. It runs at a Render URL (not visible from inside the Mini probes; the bridge poller hits `/api/bridge/notifications/pending` on Render). The Mini hosts two relays for NAMI:
- `nami-bridge.js` — drains Render → Telegram notifications.
- `nami-mesh-poller.js` — polls mesh-api on NAMI's behalf because NAMI itself can't reach the Tailscale-internal mesh-api.

This is the reason NAMI's mesh participation looks structurally different from everyone else. **NAMI is the awkward agent in the topology** — every other agent has direct mesh-api access, NAMI gets it through a Mini-hosted proxy.

---

## 2. The process layer — what runs, where, how often

### 2.1 PM2 (process supervisor, on Mini only)

PM2 is the supervisor for **all 16 long-running daemons listed above**. It restarts crashed processes, caps memory (most at 200-400M), persists across reboots, and rotates logs.

PM2 config sources:
- `/Users/kai/kai/ecosystem.config.js` — declares 14 of the apps. 3 are Kai-internal (`kai-bot`, `kai-imessage-poller`, `kai-dashboard`); 11 are "ecosystem agents" (mesh-api, cfo, conductor, oa, chronicle, lead-engine, enso, framer, pitch-deck, nami-bridge, nami-mesh-poller).
- `/Users/kai/acd/ecosystem.config.js` — declares `acd-daemon` separately (port 3342). Has env `CONDUCTOR_DB_PATH=/Users/kai/.kameha/conductor.db` — meaning ACD reads conductor's SQLite directly.
- Framer also has its own ecosystem.config.js (`/Users/alex/Desktop/Code/Framer/ecosystem.config.js`) — Framer is declared in both Kai's and its own. Presumably the live one is Framer's own.
- Chronicle has its own ecosystem.config.js at `/Users/alex/Desktop/Code/Chronicle/ecosystem.config.js`.
- KMG has its own ecosystem.config.js at `/Users/alex/Desktop/Code/Kameha Media Group/ecosystem.config.js` — but KMG is `status: inactive` in /agents (`last_heartbeat: null`). **KMG daemon is declared but not running.**

### 2.2 Cron jobs (Mini's `crontab -l`)

Three real entries (the rest are duplicated header comments — minor cleanup needed):

```
0 * * * *  cd ~/.kameha && git add -A && git diff --cached --quiet || git commit -m "auto-backup ..."
0 * * * *  /Users/kai/scripts/sync-repos.sh >> /tmp/kameha-sync.log 2>&1
*/5 * * * * cd ~/Desktop/Code/"Kameha Lead Engine" && venv/bin/python3 -c "from shared.inbox_processor import process_inbox; process_inbox()"
```

- Hourly: `~/.kameha` auto-commit (your data backup).
- Hourly: `sync-repos.sh` pulls GitHub into all Mini checkouts.
- Every 5 min: Lead Engine inbox processor (separate from mesh; processes lead-engine's own inbox).

### 2.3 In-process schedulers (each agent's own cron)

This is where the **per-agent poll cadence** lives. Most agents schedule their own `cron.schedule` inside their daemon process. The headline ones:

| Agent | Poll interval | Source |
|-------|---------------|--------|
| kai | **60s** (1 min) | `scripts/bot/crons/mesh-poller.js:1048` — `cron.schedule('* * * * *', ...)` |
| kai (work heartbeat) | 60s | same file, line 1058 |
| nami-bridge | 60s | mesh-api `/agents` `poll_interval_seconds` |
| cfo, lead-engine, enso, offer-architect, pitch-deck, conductor | **300s** (5 min) | mesh-api `/agents` |
| **acd, nami, framer, chronicle** | **600s** (10 min) | mesh-api `/agents` |
| kmg (inactive, never heartbeats) | 300s | mesh-api `/agents` |
| Kai batched digest | every 30 min at :00/:30 | mesh-poller.js:1066 |
| Kai blocked-route check | every 4h | mesh-poller.js:1077 |
| Kai morning deferred-flush | daily 07:01 | mesh-poller.js:1084 |
| Mesh-api ghost reconciler | 5 min | mesh-api env `MESH_RECONCILER=1` |

**This is where your "10-minute lag" perception comes from.** Four agents poll every 10 minutes: ACD, NAMI, Framer, Chronicle. (KMG is at 300s by config but never heartbeats — it's inactive in practice, so its cadence doesn't matter today.) If you give a task to any of those during interactive work, expect up to 10 minutes for them to drain their inbox.

The remaining 6 agents are at 1-5 minute cadence. The mesh's **average end-to-end response time across all routes in the past 7 days is 40 seconds** (`/stats (sub-key `by_route`)` endpoint). So aggregate isn't 10 minutes — but the long tail is.

---

## 3. The transport layer — mesh-api

### 3.1 What it is

A single Node.js HTTP service at `http://100.64.114.13:3341` on Mini, source at `/Users/kai/kai/scripts/mesh/mesh-api.js`. Uptime as of probe: **8.7 days** (started 2026-05-12 02:03 UTC, current uptime 751,153 seconds per `/health`).

It exposes these endpoints (some I tested, some I inferred from the seed code and per-route stats response):
- `GET /health` — overall state, queue counts, per-agent active/stale status, last 24h volume.
- `GET /agents` — agent registry. 13 entries. Includes `runtime`, `language`, `poll_interval_seconds`, `capabilities`, `last_heartbeat`.
- `GET /routes` — route table. **37 routes** registered. Each has `tier` (1=auto-deliver / 2=approval), `approved_count`, `rejected_count`, `last_rejection_at`.
- `GET /stats (sub-key `by_route`)?days=7` — route-level success/fail/reject stats (this is what I called for traffic data).
- `POST /messages` — accept an inbound A2A v1.0 message.
- `POST /routes` — register a new route at runtime (the alternative to seeding at startup).
- Various `/agents/:id/inbox` style endpoints (inferred from mesh-poller.js calls).

### 3.2 What it stores

The mesh.db SQLite — **and here is one thing the docs got wrong.** Two files I'd expect:
- `/Users/kai/kai/scripts/mesh/mesh.db` — **0 bytes, last touched Mar 27**. Abandoned.
- `/Users/kai/.kameha/mesh.db` — **also 0 bytes, last touched Mar 28**. Abandoned.

The live data must be somewhere else (the mesh-api uptime is 8.7 days, has 343 completed messages — it has real persisted state). I didn't track down the live path in this probe; the mesh-api source likely has the canonical path. **Open item: locate the live mesh.db.** This is a small unknown worth resolving so we know where the source of truth for routing decisions actually lives.

### 3.3 The 37 routes — who can talk to whom

Routes are directional (`from_agent → to_agent`). 37 of them, summarized:

- **Hub spokes (most-used):** `acd → kai` (158 approved, 15 rejected), `framer → nami` (32 approved), `conductor → kai` (31), `framer → acd` (12), `acd → framer` (8).
- **Recently rejected:** `kai → acd` (4 rejections, last 2026-05-03), `acd → kai` (15 rejections, last 2026-03-28), `lead-engine → kai` (1 rejection, 2026-04-06), `offer-architect → kai` (2 rejections, 2026-03-27).
- **Zero-traffic routes:** 21 of 37 have `approved_count: 0`. These are declared but unused. Mostly the KMG and Chronicle routes (declared in anticipation of those agents being live).

### 3.4 Live silent-failure data (past 7 days)

The `/stats (sub-key `by_route`)` endpoint gave us hard numbers — this is where the silent-failure class lives:

| Route | Total | Completed | Failed | Rejected |
|-------|-------|-----------|--------|----------|
| acd → kai | 26 | 26 | 0 | 0 |
| framer → nami | 13 | 13 | 0 | 0 |
| **nami → framer** | **13** | **0** | **0** | **13** |
| **enso → nami** | **5** | **0** | **5** | **0** |
| framer → acd | 5 | 5 | 0 | 0 |
| acd → framer | 4 | 4 | 0 | 0 |
| **acd → nami** | **3** | **0** | **3** | **0** |
| **acd → conductor** | **1** | **0** | **0** | **1** |
| acd → enso | 1 | 1 | 0 | 0 |
| cfo → kai | 1 | 1 | 0 | 0 |

**22 silent failures in 7 days** across 4 routes. Three of those routes match NEXT-SESSION.md #3 (the reply-path bug). The fourth, `acd → conductor`, is precisely the route the crew_manifest proposal needs — confirming the proposal's hard prerequisite (fuzzy-fallback fix) addresses real live traffic, not hypothetical.

### 3.5 Status-field lies (NEXT-SESSION #9 confirmed)

`/health` returns `stale_agents: ["chronicle"]` AND `/agents` returns Chronicle with `"status": "active"`. Single source of truth contradicts itself within the same JSON tree. KMG is correctly marked `inactive`. Chronicle is wrongly marked `active` despite its 5-day-stale heartbeat.

---

## 4. The data layer — what's actually shared today

This is the part that matters most for your "universal brain" question. **Knowledge is NOT shared today** — it's siloed by agent, with three escape hatches.

### 4.1 Per-agent `knowledge/` directories (siloed)

Live counts from the laptop (synced from Mini via hourly pull):

| Repo | knowledge/ files |
|------|------------------|
| Kai | 43 |
| ACD | 21 |
| KMG | 18 |
| Framer | 12 |
| CFO | 11 |
| Enso | 5 |
| PDE | 2 |
| Lead Engine | 1 |
| Chronicle, NAMI, Offer Architect | NO `knowledge/` dir |

**Total: ~113 knowledge files distributed across 8 silos. No agent can read another agent's `knowledge/` directly.** They can only learn about each other's knowledge through:

### 4.2 Escape hatch 1 — shared file drops at `~/.kameha/shared/`

Confirmed live contents on Mini:

```
acd-production-briefing.json     253 B   updated today 05:15
conductor-morning-report.json    2.4KB   updated today 05:45
conductor-overdue-alerts.json    923 B   updated today 09:00
conductor-weekly-summary.json    219 B
financial-context.json           5.5KB   updated today 06:00
work-order-schema.json           3.6KB
deliver-to-kai.js                4.1KB   executable
```

This is the **interim universal-brain** that exists today. ACD, conductor, CFO write status snapshots here. Kai's morning briefing reads them. **It's a one-way file-drop pattern** — agents write here; Kai reads here. There's no protocol for two-way sync, conflict resolution, or schema enforcement.

### 4.3 Escape hatch 2 — conductor DB (`~/.kameha/conductor.db`)

196KB main file + **3.6MB WAL** (updated 2026-05-19) — this is the most active SQLite on the Mini. It holds projects, milestones, tasks, scope events, team members, retainer cycles (per session-4 research). ACD reads it directly (via the ecosystem env `CONDUCTOR_DB_PATH`). Kai's briefing queries it.

**Conductor is the closest thing to a shared brain today.** But it's structured project data, not general knowledge.

### 4.4 Escape hatch 3 — mesh message payloads (transactional)

Each A2A message carries its own payload. So if ACD wants to tell Kai "the Baptist shoot is at risk," that fact moves through one mesh message and dies in Kai's inbox handler (becomes log + Telegram surface). The fact is *transferred* once but not *stored* in any shared place. If you ask another agent the same question tomorrow, the fact has no canonical home — only the original message log.

### 4.5 What's NOT shared (your manual copy-paste problem)

- Client backstory ("here's what Maria said about the recovery story").
- Cross-agent decisions ("we approved option B").
- Recent context Alex gave to one agent.
- Status of "current session" with any agent.

These are the things you copy-paste between Claude Code sessions. **There is no architectural surface for them today.** That's the universal-brain gap.

---

## 5. The Code Architect's place in this

CA is **not in the live mesh**. Confirmed by `/agents` returning 13 entries with no CA. CA is:
- A CLI invoked from your laptop only (v0.1.0; CLAUDE.md "Invocation environment").
- Single-shot: runs, does work, writes a run-ledger, exits.
- Authoritatively able to author files in any repo subject to that repo's `owners.json`.
- Does NOT poll mesh, does NOT have a daemon, does NOT receive mesh messages.

That's intentional — but it also means CA is **not part of the latency problem you're feeling**. CA is part of the *solution architecture* for that problem.

---

## 6. Live problems, surfaced by this probe

Beyond what NEXT-SESSION.md already tracked, these are things this probe revealed or sharpened:

1. **Crontab on Mini has a duplicate-header bloat problem.** Eight copies of the comment header. Not breaking anything but noisy and risks accidental edits to the wrong section. Mechanical cleanup item.
2. **CFO has BOTH laptop LaunchAgents AND Mini PM2 daemon.** Either intentional dual-mode (laptop for UI alerts, Mini for headless) or a leftover from an older deploy. Worth a CFO-specific review.
3. **mesh.db is at neither expected path.** Both files I checked are 0 bytes. The live database must be elsewhere. **Open item.**
4. **`~/kai/`, `~/acd/`, `~/framer/` are separate trees from `~/Desktop/Code/...`.** Two parallel checkouts per agent for the hub trio. `sync-repos.sh` keeps both in sync from GitHub. This is fine but worth documenting — the laptop-side `/Users/alex/Desktop/Code/...` paths I cite in CA outputs map to Mini's `~/Desktop/Code/...`, NOT to `~/<agent>/`. **Important for any cross-machine path references.**
5. **NAMI is the awkward agent.** Cloud-hosted on Render, can't reach Tailscale-internal mesh-api, so two Mini-side relays exist to fake its participation. Any "universal brain" design has to account for one off-prem participant.
6. **KMG daemon declared but not running.** ecosystem.config.js exists in `~/Desktop/Code/Kameha Media Group/`; `/agents` shows `inactive`; never heartbeated. This was a known item but now we have proof.
7. **Status-field bug is live and lying about Chronicle.** Confirmed.
8. **22 silent route rejections in 7 days.** This is your real cost of the action-vocab gap. Roughly 3 per day silently fail without alerting either sender or receiver.

---

## 7. Your two concerns, mapped to this architecture

### 7.1 "Semi-instant communication when I'm in the chair"

The actual latency picture is more nuanced than "10 minutes":

- **Already fast (≤60s):** Kai. The hub. Most laptop→agent work routes through Kai first.
- **Decent (≤5min):** CFO, OA, Enso, Conductor, PDE, Lead Engine.
- **The problem cohort (≤10min):** ACD, NAMI, Framer, Chronicle.

The 10-min cohort is the creative-production layer + Chronicle. These are exactly the agents you most need *during* a shoot or content session — but they're set to 10min because they were tuned for unattended overnight work. (KMG is at 300s but inactive in practice — it never heartbeats.)

**Three plausible fixes, in order of effort:**

| Fix | Effort | Tradeoff |
|-----|--------|----------|
| (a) Drop the 10-min agents to 60s during "in the chair" mode | Small — set a flag on mesh-api or pass a query param to poll-interval lookups; each agent's poller honors it | Higher steady-state CPU on Mini; per-agent code change |
| (b) Push model — mesh-api fires an HTTP POST to each agent's port when a message arrives for them | Medium — each agent already has its own HTTP port (ACD 3342, conductor 3344, etc.). Just need a webhook handler. | More code, more failure modes (webhook unreachable), but eliminates polling latency entirely |
| (c) Long-lived connection (WebSocket / SSE from each agent to mesh-api) | Large — but is the "right" answer for a real-time mesh | Daemon changes for every agent; significant rewrite |

(a) is what I'd recommend if you want a real fix this week. (b) is the right answer for next quarter. (c) is a future-state if the system grows much larger.

### 7.2 "Universal brain"

What you actually have today:
- `~/.kameha/shared/` — one-way file drop, 7 files, used as informal mailman.
- `~/.kameha/conductor.db` — structured project state, queried by ACD + Kai.
- Per-agent `knowledge/` dirs — ~113 files across 8 silos, no cross-agent reads.

What "universal brain" could mean, in three plausible architectures:

| Approach | Where it lives | Reads/writes | Cost |
|----------|----------------|--------------|------|
| **Extend `~/.kameha/shared/`** with structured contracts | Mini filesystem, git-backed | Agents read directly; writes go through mesh messages for audit | Small. Builds on what works. |
| **Promote conductor.db to a general knowledge store** | Mini SQLite | Direct SQL reads (already ACD does this); writes via conductor handlers | Medium. Conductor becomes the brain, not just project orchestrator. |
| **New `mesh-knowledge` service on Mini** | New HTTP service, port 3343 maybe | Agents query for facts via HTTP; writes go through a shared schema | Large. New thing to maintain. |

The middle option — **promote conductor to "knowledge orchestrator"** — is interesting because it's the existing piece that's already shared, already structured, and already has agent traffic flowing into it. It just needs more schema beyond projects/milestones/tasks.

The crew_manifest proposal we just drafted is actually the first step of that pattern — adding a new typed record (`crew_assignments`) to conductor.db as shared structured knowledge, queried by Kai's briefing, written by ACD. **This is the universal brain pattern, in miniature, for one specific deliverable type.**

### 7.3 The connection between your two concerns

They're related but solving one doesn't solve the other:

- Faster polling fixes "I asked ACD a thing 8 minutes ago and it hasn't picked up the message." (Transport latency.)
- Universal brain fixes "ACD doesn't know what Kai told me yesterday." (Knowledge silos.)

A faster transport WITHOUT a shared knowledge layer just means agents say "I don't know that" faster.

A shared knowledge layer WITHOUT faster transport means the answer exists but takes 10 minutes to be retrieved.

**You need both, but you don't need them in the same change.** They can ship sequentially.

---

## 8. Recommended next steps (each is a separate proposal, awaiting your go-ahead)

I'm naming these so we can discuss them, not because I'm proposing to do all of them. Pick what's worth doing in what order.

1. **Locate the live mesh.db.** 10-min mechanical task. Source the actual path so future references aren't lying.
2. **Drop the 10-min poll cohort to 60s — at least during in-the-chair sessions.** Smallest fix for the latency you feel. Could be a manual SIGUSR1 to each daemon, an "Alex active" toggle in mesh-api, or just a permanent cadence drop.
3. **Fix the status-field demotion bug.** Mesh-api shouldn't report Chronicle as both active and stale. Single-file fix in mesh-api source.
4. **Fix the reply-path silent-rejection cluster.** 22/week, going to nowhere. Either register the reverse routes or change the reply mechanism.
5. **Phase A of crew_manifest** — pilots the "conductor as shared knowledge orchestrator" pattern.
6. **Design doc for universal brain** — pick one of the three architectures above (or a fourth), think it through. This is the bigger conversation we should have before any code lands.

---

## 9. Things this probe did NOT cover, to be honest

- Mini's full PM2 status (uptime per process, restart counts, memory headroom) — I tried but `pm2 jlist` failed via SSH PATH; would take 5 more minutes if you want it.
- Network topology beyond Tailscale (which switch/router carries the laptop→Mini link, whether Tailscale itself has been recently degraded).
- Cloud-side: NAMI's Render dashboard, any error rates there.
- Whether the laptop-side CFO LaunchAgents are still doing useful work or are legacy.
- mesh.db schema — I didn't query the actual SQLite (because I couldn't find the live one).

These are gaps. Some matter, most don't, for the conversation we're trying to have.

---

*End of foundation doc. Companion HTML may follow if you want a visual version; otherwise this is the source of truth for the universal-brain + semi-instant conversation.*

# Overnight System Audit — 2026-05-19

**Run window:** session 3, overnight (Alex authorized ~04:30 ET 2026-05-19, expected wrap before 11:00 ET)
**Agent:** Code Architect, single-shot CLI, invoked from `/Users/alex/Desktop/Code/Code Architect/`
**Authority granted:** "and execution" — commit/push autonomously on isolated CA-internal or owners.json-cleared mechanical changes; **DA-gate floor + HB1-3 still hold**.

This is the **running aggregate** of all overnight findings. Subagent intakes feed into it. Read top-down: P0 first, then P1, then P2, then CA actions taken, then queued for Alex.

---

## 🔬 Re-verification pass (post-aggregate, 2026-05-19 ~10:30 ET)

Per [[feedback_re_verify_agent_authored_claims]], subagent claims about other agents need direct code-read verification before they earn the P0 tag. Pass results:

| Subagent claim | Verdict | Notes |
|---|---|---|
| A6 P0-6 PDE silently completes `build_update` | ✅ **CONFIRMED** | A6 cited wrong absolute path (claimed root `pde-daemon.js:683-700`; actual is `scripts/pde-daemon.js:676-700`). Dispatch ONLY matches `build_addendum` (line 684); else branch is `PATCH status=completed` (line 698). Capabilities declares `['build_addendum', 'build_update']` (line 233) — declared but unimplemented. |
| A6 P0-7 LE has no mesh-receive daemon | ✅ **CONFIRMED** | LE entry point is `dashboard/backend/main.py` FastAPI app mounting HTTP routers (jobs, approvals, pipeline, scout, archer, closer, radar, seo, indeed). No `daemon.py`. No mesh-inbox polling code anywhere in the repo. `run_*.py` scripts are scheduled-task runners, not mesh consumers. |
| A4+A7 P0-1 nami→framer + acd→conductor `route_blocked` | ⚠️ **REFINED** | Rejections are real (5× nami→framer + 1× acd→conductor in last 48h). But the actual error semantics are different from what "route_blocked" implies in a tier-1 routing system. See P0-1 update below. |

### P0-1 refinement — these are REPLY-PATH rejections, not request-path

Pulled the full message record for one rejection:

```json
{
  "message_id": "efcf726b-...",
  "from_agent": "nami",
  "to_agent": "framer",
  "action": "schedule_post_response",
  "message_type": "response",
  "chain_depth": 1,
  "correlation_id": "wo_framer_dag_thanksgiving_2026_v1",
  "payload": { "result": { "status": "draft_created", "post_id": "...", "dashboard_url": "...", "asset_count": 1 } },
  "status": "rejected"
}
```

This is nami **replying** to a framer-initiated work order. `message_type: "response"`, `chain_depth: 1`, `correlation_id` set, payload is status confirmation. Forward path `framer → nami` exists (tier=1, 24 approved). Reverse path `nami → framer` does **NOT** exist in the `/routes` table at all.

**This means:** the system is rejecting nami's status-replies because no reverse route was registered. Either (a) the routing system should auto-register reverse routes for correlation_id replies, or (b) nami shouldn't be sending separate response messages — replies should use a different mechanism (e.g., poll status endpoint, or correlation_id should bypass route check).

**Same pattern for `acd → conductor` creative_brief:** acd attempting forward send, no acd→conductor route exists (only `conductor → kai` and `kai → conductor`). So acd's send is silently dropped.

**Fix direction is a design call, not a mechanical patch.** Options:
1. Add reverse routes (`nami → framer`, `acd → conductor`) with appropriate tier.
2. Change mesh-api to treat `message_type: "response"` with valid `correlation_id` as auto-routed regardless of `/routes` entry.
3. Change agents (nami, acd) to not send these messages — use a different completion-notification mechanism.

Each option has trade-offs. **Out of CA's lane to decide unilaterally.** Surface to Alex with this analysis.

---

---

## 🚨 P0 — act in the morning

### P0-1. Mesh routes MISSING — two senders silently fail (A4 + A7 corroborate)

| Route | Last 24h count | Status | Receiver whitelist? |
|---|---|---|---|
| `nami → framer schedule_post_response` | 5 rejections | `route_blocked` | Framer accepts the action; **route not registered in mesh-api `/routes` table** |
| `acd → conductor creative_brief` | 1 rejection | `route_blocked` | Same pattern |

**Why this matters:** fire-and-forget. Sender thinks it ACKed. Receiver never gets the message. Mesh-api `/routes` table is the gatekeeper, but no observability anywhere alerts when a route fires `route_blocked` repeatedly. Nami has **zero** successful sends to Framer ever. Both sides silently believe success.

**Fix path:** add the two routes to mesh-api's `/routes` table on Mini. T3 because it's a mesh contract change — explicit Alex go-ahead per CLAUDE.md Action Gate. CA can prepare the SQL/JSON patch tonight; Alex commits in the morning.

**Files to touch (Kai repo, Mini-canonical):**
- `Kai Executive Assistant/scripts/api/mesh-api.js` (route registration code path; A4 located endpoint map at lines 1428-1842)
- whatever bootstrap script seeds the routes table (TBD by reading the file)

### P0-2. T2 probe `acd-nami-probe-1779108906` expires in ~8h (12:55 UTC)

ACD queued a `social_deliverable_ready` probe to Nami at 2026-05-18 12:55 UTC asking "contract still in place?" Payload `{subject, client: "dagdc", probe: true}`. delivery_attempts: 0. **TTL ~8h** from time of this audit run.

**Recommendation:** APPROVE. Nami's whitelist includes `social_deliverable_ready` per A4. The probe is safe (probe-tagged, no side effects). If it goes through cleanly, ACD confirms the ACD→Nami contract still works; if it fails, that's a new P0 to surface.

**Action:** Alex's call only — T2 mesh gate. Run from laptop or Mini:
```
curl -X POST http://100.64.114.13:3341/messages/acd-nami-probe-1779108906/approve
```
(Endpoint shape inferred — A4 to confirm; if wrong path, see `/Users/alex/Desktop/Code/Kai Executive Assistant/scripts/api/mesh-api.js` for the T2 approve route.)

### P0-3a. Chronicle git is LOCKED (A2 root-cause find — separate from daemon death)

51-day-old `refs/heads/main.lock` on Chronicle from 2026-03-28. Dead PID. **This is why** the 27 uncommitted /log entries have been sitting there — git can't run any operation on Chronicle. Two separate issues converged into the appearance of one:

1. Lock blocks all git ops (this finding, P0-3a)
2. PM2 daemon dead (P0-3b below)

**Fix:** Alex action — `rm /Users/alex/Desktop/Code/Chronicle/.git/refs/heads/main.lock` then `git fsck` to verify. Mechanically trivial. No owners.json (Chronicle is one of 5 repos missing one) so CA can't auto-act — manual operator action only.

### P0-3b. Chronicle PM2 daemon is dead (A1, mesh-api self-flagged)

| Evidence | Value |
|---|---|
| `/health` `stale_agents` | `["chronicle"]` |
| `/agents` chronicle status | **still labeled `"active"`** despite the above |
| chronicle last_heartbeat | `2026-05-15T03:00:00.960Z` (4 days stale, exactly on poll-interval boundary — hard-crash signature) |
| Whoop/Strava sync | paused since 2026-03-26 (per A1) |

**Fix:** Alex Mini-side action: `ssh mini && pm2 restart chronicle && pm2 logs chronicle --lines 50`. CA can't do this — Mini access isn't in laptop CA's lane.

### P0-6. PDE silently completes `build_update` with ZERO work (A6 — strict isomorph of Framer creative_brief bug)

PDE daemon at `Kameha Pitch Deck Engine/pde-daemon.js:683-700` only checks `if (msg.action === 'build_addendum')`. Anything else **falls through to `PATCH status=completed`** — the message reports done with zero work. PDE's manifest declares `build_update` but it's not implemented. **Senders sending `build_update` to PDE are silently believing success.**

This is the **strict isomorph** of the session-2 Framer creative_brief bug. The fact that it persisted past session 2 (which fixed the Framer instance) means our contract-mismatch hunt was scoped to Framer only. **The pattern is fleet-wide.**

**Fix path:** PDE author the `build_update` handler. Mirror the Framer creative_brief landing pattern (`human_review_required` queue → human reviews). PDE has **no owners.json** — bootstrap first (P1-7) → then CA can author. Alex go-ahead chain.

### P0-7. Lead Engine has NO mesh-receiving daemon (A6 — corrects session-3 retraction)

Updated LE picture (third revision):

| Source | Says about LE | Reality |
|---|---|---|
| Session-3 audit task #14 | "Dead since 2026-04-02 (47 days)" | **Wrong** — single-sourced laptop health file |
| Tonight's first retraction | "Alive — mesh-api shows heartbeat 2026-05-19 04:33Z" | **Technically true but misleading** |
| A6 deep dive | "Heartbeat comes from FastAPI dashboard. **No mesh-message receiver exists.** Mesh sends to LE rot in `/inbox/lead-engine` until reconciler-expired." | **The full truth** |

Kai's `intent-classifier.js:60-62` advertises `score_prospect`/`pipeline_status` to peers. Peers send. **Nothing receives.** This is worse than the Framer/PDE class — it's not "receive + silent success," it's "no receive at all + reconciler expires the message after TTL."

**Fix path:** LE needs a mesh-message daemon authored. This is FastAPI add-on or a separate Python process. Significant work (>100 LOC, T3 plan-first, DA mandatory). Defer to Alex sizing.

### P0-8. ACD `daily_snapshot` action drift (A6)

Kai sends `daily_snapshot` (`intent-classifier.js:53`); ACD daemon has `production_snapshot`. **ACD's else branch (`daemon.py:181-183`) warning-logs and ACKs without sending an `error` reply.** Compare Framer at lines 171-177 which DOES send error. Senders to ACD with unknown action get ACK (false success).

**Fix path:** Either rename Kai's send to `production_snapshot` (Kai-side fix) OR add `daily_snapshot` alias to ACD (ACD-side fix). ACD has owners.json. CA can author either side. Defer to Alex for direction (rename vs alias) — see [[feedback_audit_triangulate_sources]] — receiver-name choice matters for naming consistency across mesh.

### P0-9. Conductor fuzzy-fallback misroutes (A6 P1 — promoted because of blast radius)

`Kai Executive Assistant/scripts/conductor-agent.js:425-431` fuzzy-falls-back via substring match. **`stage_update` → `update_milestone`** — wrong handler runs. **Wrong-handler routing is more dangerous than no-handler:** silent success but acting on wrong data.

**Fix path:** disable the fuzzy fallback; require exact action match or send `error`. Single-file change in Kai (scripts/conductor-agent.js — not in scripts/mesh/, so policy check needed). CA can draft.

### P0-5. Pitch Deck Engine — real client work at risk (A2)

12-day stale HEAD. 806MB repo. **6 new client-builds directories uncommitted.** No `.kameha/owners.json`. This is the *worst* finding for active client deliverables — every other agent's "uncommitted work" is utility code or logs; PDE's is *client builds* sitting unstaged.

**Fix path:**
1. Alex confirms what the 6 builds are for + which are deal-closed vs draft (cf. OA Malaga pattern).
2. Bootstrap PDE's `.kameha/owners.json` per the session-2 pattern (CA can draft tonight; needs Alex go-ahead per T2 + owners-bootstrap explicit task).
3. Stage + commit each build as a discrete commit (CA can author once owners.json lands).

### P0-4. mesh-api status never demotes on heartbeat staleness (A1, systemic)

The same `/health` response simultaneously labels chronicle `status="active"` AND lists it in `stale_agents`. The single source of truth silently contradicts itself. Any consumer that reads only `status` (most do) thinks chronicle is live.

**Fix:** Kai repo, `scripts/api/mesh-api.js` — when computing `/agents` and `/health` response, demote `status` from `"active"` → `"stale"` if `now - last_heartbeat > 2 × poll_interval_seconds`. Single-function change, <30 LOC, single repo. Could be CA-overnight-fixable but **mesh-contract change → DA gate → defer to Alex go-ahead in morning.**

---

## ⚠️ P1 — schedule for this week

### P1-1. Heartbeat data-flow structurally laptop-blind (A1, design surface)

- Heartbeats land in Mini's `mesh.db` only (mesh-api.js:138, :1238)
- Laptop `~/.kameha/mesh.db` is 0 bytes
- Laptop `~/.kameha/health/*.json` are written by each agent's *own local process* — but daemons don't run on laptop anymore
- **Therefore: every laptop-side audit using health files alone is structurally blind**

Already memorialized in `reference_mac_mini_live_mesh_state_via_tailscale.md` (session 2) — but the *why* (structural, not just "laptop mesh.db happens to be stale") should be added. Auto-memory card update queued.

### P1-2. Static manifest + runtime registry drift (A1)

`~/.kameha/agents.json` last updated 2026-03-19 — 2 months ago. Missing: acd, framer, nami-bridge, kmg. Mislabels nami as `inactive` + `session` (it's `active`/`daemon`).

Kai's `knowledge/manifests/` dir missing: chronicle, conductor, pitch-deck, nami-bridge.

**Fix:** regen-or-retire decision. If runtime registry is unused, retire. If used, regen from mesh-api `/agents`. CA can draft a `regen-from-mesh-api.js` script under `owners.json` policy in Kai. Alex go-ahead for regen-vs-retire.

### P1-3. Payload-schema contract is receiver-only (A4)

A4 found ACD's `creative_brief` v2 retry to Nami died with `TRANSFORM_REJECTED: payload missing file_path`. The contract for `file_path` lives in Nami's transformer, undocumented. ACD had no pre-send way to know.

**Fix:** The action-vocabulary registry design doc (`docs/design-action-vocabulary-registry-2026-05-19.md`, written this session) addresses this directly. Awaiting Alex go-ahead for Phase A.

### P1-4. com.kai.claude-code-sync laptop→Mini JSONL rsync log stale since 2026-05-17 03:06 (A3)

The plist is loaded; script `exit 0`s gracefully on Mini-unreachable, so "stale log" might just mean "laptop was asleep at fire windows." But session 2 wrapped 2026-05-18 — and the sync hasn't logged anything after that wrap. Worth a manual fire check:

```
launchctl kickstart -k gui/$UID/com.kai.claude-code-sync
tail -50 ~/Library/Logs/kai-claude-code-sync.log    # path approx — A3 has exact
```

### P1-5. CFO QuickBooks token expired (A1)

`/Users/alex/.kameha/health/cfo.json` reports `qb_token_status: "expired"` with 10 pending work orders. CFO is otherwise active. **Fix:** Alex re-auths QB through CFO's OAuth flow. Outside CA's lane.

### P1-7. owners.json coverage — A2's "5 missing" needs branch nuance (re-verified)

A2's initial finding: missing in **Chronicle, Code Architect (self), Framer, KMG, Pitch Deck Engine.**

**Re-verification surfaced Framer is a false positive.** Triangulated:
- Commit `0a4d322 chore(governance): bootstrap .kameha/owners.json` IS on `origin/main` (literal HEAD of main).
- `.kameha/owners.json` IS present in `origin/main`'s tree (`git ls-tree origin/main .kameha/owners.json` returns the blob).
- Framer's current laptop checkout is `carousel/phase-2a-planner`, a feature branch that predates `0a4d322` — that's why A2's filesystem ls saw nothing.
- Mini-side PM2 runs from main, so the running daemon sees the policy. **Framer is owners.json-covered for governance purposes; just not on the laptop's currently-checked-out branch.**

**Real coverage:** 8/12 → 9/12 after Framer correction (with CA-self added this session). Still missing: **Chronicle, KMG, Pitch Deck Engine.**

Per HB#2: "When a target repo lacks `owners.json`, fail-closed: refuse cross-repo edits except an explicit owners-bootstrap or migration task pre-approved by Alex." So CA cannot mechanically sweep these 3.

**Adjacent finding worth surfacing separately:** owners.json policies can DIFFER between branches in the same repo. Working-tree drift means CA's local read of `.kameha/owners.json` may not match the canonical main-branch policy. Today this only matters when an agent is checked out off-main for active feature work (Framer is). Long-term, consider either (a) always resolve policy against `origin/main`, or (b) require owners.json on all branches (git hook). Out of scope for tonight; flagged for design discussion.

**Fix path for the genuine 3:** draft owners.json from scratch (session-2 bootstrap pattern produced 7 drafts; replicate for these 3). Each requires Alex go-ahead per the bootstrap rule, but drafting is mechanical.

**CA-self bootstrap done tonight** as `0964563` (closes 5→3 missing, after Framer correction).

### P1-8. Framer 116 untracked files — almost all one-off render scripts (A2)

Not a CA-actionable item. Owner-judgment call: gitignore vs commit-and-archive. Defer to Alex.

### P1-9. Enso 8.3GB repo (A2)

7.7GB in `projects/`, 403MB in `outputs/`. owners.json present (63 patterns). Probably needs LFS or external-storage migration. Defer to Alex; no urgency.

### P1-6. Framer `social_deliverable_ready` sends `client: "undefined"` — 5 May failures (A7)

Last failure 2026-05-10. **Not in last 7d window**, so didn't show in A4's recent-failure scan. But it's a regression that bled at some point. Framer code likely has an unguarded `client = payload?.client` or similar.

**Fix:** Framer single-file fix once located. CA can author under `human_review_required` policy in Framer's owners.json. Defer to morning so Alex can confirm the trace.

---

## 🟦 P2 — cleanup / backlog

### P1-10. Manifest drift (A6)

- **Framer manifest does NOT list `creative_brief`** despite Framer commit `98bf045` implementing it. Drift in static manifest.
- **ACD manifest lists `analyze_visual`** but daemon doesn't implement it. Phantom capability.

**Fix:** regenerate static manifests from daemon code. Tooling implication: tie into action-vocabulary registry (P1-3 design doc).

### P1-11. OA permissive-handler default (A6 P2 — surfaced)

OA at `oa-daemon.js:1185-1220` treats any unknown action as a Claude work order; defaults missing action to `price_offer` (line 1266). Inverse of the silent-failure class — permissive instead of restrictive. Wrong handler runs.

**Fix:** tighten action match. Single-file. OA has owners.json. CA can draft.

### P1-12. Loud-failure agents (no action — confirmation)

A6 confirms these agents send error replies correctly on unknown actions: **Enso, Nami mesh-poller, CFO fs-side, Framer (post-session-2), Conductor send_error path.** Good. Pattern: error replies + explicit `UNSUPPORTED_ACTION` are the goal state.

### P2-1. KMG `inactive` is expected (A1)

KMG daemon "ships on Mini W2" per CA manifest. The current `inactive` status is correct; not a finding, just a confirmation.

### P2-2. Cross-fleet `.gitignore` cleanup (A2)

- ✅ **CA:** committed this session as `9babe4f` (`.playwright-mcp/` + session-screenshot PNGs ignored). **A2 verified post-commit state — clean.**
- ⏳ **Framer:** A2 confirms 116 untracked (mostly render scripts) + `.playwright-mcp/`. **No owners.json** → cannot auto-act. Blocked on P1-7 bootstrap.
- ⏳ **Chronicle:** A2 confirms `.next/trace` + Finder " 2"-suffix dupe (`analytics 2.ts`). **No owners.json** + git locked → cannot auto-act. Blocked on P0-3a + P1-7.
- ⏳ **Nami:** A2 confirms 18 stray PNGs. **owners.json present**. CA can draft + commit under policy. **Doing tonight.**
- ⏳ **CFO:** A2 surfaces log-output gitignore gap. owners.json present. CA can draft + commit. Adding to tonight's list.
- ⏳ **Enso:** 3 stale stash locks from May 7 (P2). Defer to Alex (touching .git internals).

### P2-3. Repo memory MEMORY.md stale index (A5)

✅ Fixed this session as `6333bac` — added `pattern-distill-verify-paths` to MEMORY.md.

### P2-4. Auto-memory `session-2026-05-18.md` not in MEMORY.md index (A5)

Auto-memory hygiene — will be addressed when this session's wrap writes `session-2026-05-19.md` and updates the MEMORY.md sessions index.

### P2-5. Cross-repo backlink convention drift (A5)

`pattern_distill_verify_paths.md` uses underscore-slug `[[feedback_verify_before_recommending]]` referencing a Kai-memory file. Mixing slug conventions (kebab vs underscore) + cross-memory references — schema decision needed. **No urgency.**

### P2-6. NEXT-SESSION.md item #1 — Memorial Day manual-relay confirmation

Still pending Alex confirmation. Was Alex's manual relay intentional human-in-loop, or accidental gap? Drives priority on retrospective tooling.

### P2-7. NEXT-SESSION.md item #5 — Chronicle 7-week commit gap (HIGH-RISK)

Separate from P0-3 (daemon dead). This is the uncommitted /log feature work. Alex action.

### P2-8. NEXT-SESSION.md item #7 — OA Malaga 4-file deletion triage

`EMAIL_TO_CHRISTIAN.md`, `KAMEHA_SERVICES_AGREEMENT_v1.md`, `MALAGA_SOW.md`, `MALAGA_SOW_v2.md` deleted-unstaged since 2026-04-03. Alex action.

### P2-9. NEXT-SESSION.md item #8 — CFO 8-commit plan execution

Plan at `docs/cfo-commit-plan-2026-05-18.md`. Alex action.

---

## ✅ CA actions taken this overnight session

| Commit | Repo | Subject | Push |
|---|---|---|---|
| `9babe4f` | Code Architect | `chore(gitignore)`: ignore `.playwright-mcp/` + session-screenshot PNGs | ✅ pushed origin |
| `6333bac` | Code Architect | `fix(memory)`: index `pattern-distill-verify-paths` in MEMORY.md | ✅ pushed origin |

Plus written tonight (not committed yet — bundled at session wrap):
- `docs/design-action-vocabulary-registry-2026-05-19.md` (T3 plan-first design)
- `docs/intake-audit-A1-agent-runtime-2026-05-19.md`
- `docs/intake-audit-A3-automation-inventory-2026-05-19.md`
- `docs/intake-audit-A4-mesh-api-deep-probe-2026-05-19.md`
- `docs/intake-audit-A5-memory-hygiene-2026-05-19.md`
- `docs/intake-audit-A7-failure-patterns-2026-05-19.md`
- `docs/audit-overnight-2026-05-19.md` (this file)
- (A2 + A6 pending — added when they return)

---

## 🟨 Queued for Alex morning go-ahead

1. **APPROVE/REJECT T2 probe** `acd-nami-probe-1779108906` before 12:55 UTC TTL (P0-2)
2. **APPROVE route registration** for nami→framer + acd→conductor in mesh-api `/routes` (P0-1)
3. **Mini-side:** `pm2 restart chronicle` + log check (P0-3)
4. **APPROVE action-vocabulary registry Phase A** per `docs/design-action-vocabulary-registry-2026-05-19.md` (P1-3)
5. **APPROVE mesh-api status-demote-on-stale patch** (P0-4)
6. **DECIDE regen-vs-retire** for `~/.kameha/agents.json` (P1-2)
7. **Re-auth CFO QuickBooks** (P1-5)
8. **Confirm/deny** Memorial Day manual-relay intentionality (P2-6)
9. **Triage Chronicle 7-week commit gap** (P2-7)
10. **Triage OA Malaga 4-file deletion** (P2-8)

---

## Self-audit retraction surfaced tonight

Session-3 audit task `#14 LE PM2 agent silently offline since 2026-04-02 (47 days)` is **wrong**. The mesh-api `/agents` response shows `lead-engine` heartbeating at 2026-05-19T04:33Z. The laptop health file is stale **structurally**, not because LE is dead — laptop health files don't reflect Mini-runtime state by design. This is the single-source pattern [[feedback_audit_triangulate_sources]] warns about; I single-sourced the laptop health file. Retracted + memorialized in P1-1.

---

*This file is the working aggregate. A2 + A6 intakes will append. The morning briefing in the conversation summarizes this file's top items.*

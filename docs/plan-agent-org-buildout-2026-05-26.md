# Implementation Plan — Agent Org Buildout (v2)

**From:** Code Architect · **To:** Alex (via Kai work order `wo_ca_agent_org_buildout_2026-05-26`) · **Date:** 2026-05-26
**Status:** PLAN ONLY — no code, no commit, no push. For Alex's approval of the *approach* before any build.
**Classification:** T3, DA-mandatory. This document is a plan-level reasoning pass; **full DA re-enters before each implementation phase.**
**Intake:** `docs/intake-kai-agent-org-buildout-2026-05-26.md` · **Vision source:** Kai's 7 explainers (2026-05-26) + work order §1–6.

> **⚠ AMENDMENT (Alex, 2026-05-26) — folded in below:**
> 1. **Kai = Chief of Staff** (not COO). Same role (the CEO's force-multiplier who coordinates the office and ensures work ships; guardrails unchanged) — title only.
> 2. **Mira (EA) DEFERRED to Phase 2 — do NOT build this pass.** Kai wears both hats (Chief of Staff + the EA function) as a single agent. The shared-engine / two-identities split stays a fully-specified *blueprint* (see §1, now marked deferred) but is **deferred-until-triggered**: EA load competing with strategic work · need for a hard personal/business data wall · business growth. This removes the engine refactor + Mira staging from immediate scope and simplifies the first pass.
>
> All other constraints unchanged: ≤60s comms · no context loss · clean lanes · guardrails intact · Conductor audit-first · Mini deploy-drift + agents.json refresh.

---

## 0. The one insight that reorders everything

Two of the four hard requirements — **"no context lost on hand-offs"** and **"clean lanes / wall around clients"** — are *not new work*. They are the **Shared Layer** (built, hardened through 5 Codex rounds, gated on Kai's 3 cutover decisions). The org redesign **sits on top of the Shared Layer**: identities are its per-client/per-agent isolation, full-thread handoff is its typed-fact projection.

**Consequence:** the Shared Layer pilot is a *prerequisite*, not a parallel track. Mira's data lane, the client-manager cubicles, and lossless handoff all ride it. Sequencing below reflects that.

A second hard reality from the live probe: **all 18 pm2 processes run as one unix user (`kai`).** So every "wall" in this org — client cubicles, Kai/Mira lanes — is **logical + signed-integrity isolation, not OS-enforced**, until the separately-scoped "multi-user Mini" project lands. This is the *same honest posture* already accepted for the Shared Layer pilot. The plan does not claim a physical wall that does not exist.

**Multi-user Mini decision rule (Alex, 2026-05-26):** multi-user OS isolation is **deferred, not roadmap-by-default.** For one operator running all first-party, CA-audited code, OS-enforced isolation buys exactly *one* thing — containment if an agent is compromised (e.g. prompt-injection → arbitrary cross-client read) — at meaningful operational cost (per-user homes, chown choreography every deploy, pm2-as-multiple-users on a macOS box that's bad at it, per-user key/OAuth custody). Net-negative absent a real trigger. **Build it only when a trigger fires:** a client contract demanding demonstrable hard separation · an agent ingesting untrusted client input whose injection-resistance isn't trusted · an actual compromise. Design stays chown-ready so the flip is config, not re-architecture. Do not re-pitch multi-user without a named trigger.

---

## 1. Shared engine + two identities — architecture (DEFERRED to Phase 2; blueprint retained)

> **Not built this pass** (amendment). Kai is a single agent wearing both the Chief-of-Staff and EA hats for now. The design below is the kept blueprint for the eventual split, to be built only when a trigger fires (EA load vs strategic work · hard personal/business data wall · business growth). Phases 3–6 of the old sequence (engine refactor + Mira 3-step staging) move to §3-Deferred.

Kai's "one engine, two drivers" is correct. CA's packaging recommendation (the work order left this to CA):

**Monorepo, identity-as-configuration — not a code fork.**

```
kai/ (existing repo, refactored)
  core/                     # the shared engine: calendar, email, tasks, memory, mesh, scheduler
  identities/
    kai.identity.json       # Chief of Staff: persona, tools, data-lane, mesh seat, channel
    mira.identity.json      # personal EA: persona, tools, data-lane, mesh seat, channel
  bin/agent.js              # single entrypoint; boots core with IDENTITY=<id>
```

Two pm2 processes launch the **same** entrypoint with `IDENTITY=kai` / `IDENTITY=mira`. Build once, maintain once, **no drift** — yet two genuinely separate runtime processes, memories, and mesh seats.

**Identity contract** (the "thin layer"):
```
{ agent_id, display_name, persona, tool_allowlist,
  data_lane: { calendar_account, email_account/scope, task_store, memory_dir },
  channel: { telegram_bot_token → separate chat },
  guardrails: <shared baseline, identity-scoped> }
```

- **Data isolation ("clean cubicles"):** separate `memory_dir`, separate calendar/email accounts per identity. Logical on the single-user Mini (see §0); chown-ready for the multi-user project.
- **Mira's channel:** her own Telegram bot (separate chat) — CA concurs with Kai's recommendation; Alex always knows who he's addressing.
- **Why not clone (Kai's rejection holds):** two codebases drift and double every fix. **Why not an npm-package split:** versioning overhead with no payoff for one host / one maintainer; config-overlay is simpler and equally isolated at runtime.

**The hard part (Kai's RISK 01 — calendar/email):** who owns a given event/thread. CA approach: **separate underlying accounts** where they exist (personal Google for Mira, business for Kai) + a **deterministic ownership router** + a **reconciliation check** that flags any cross-lane collision before it double-books. Exact routing rule = `DEFERRED-TO-IMPL`, nailed in the spec phase; the **proof gate** (§3 Step 2) is "a live personal/business crossover reconciled, no double-book, no dropped context."

### 1b. The front door — resolved (Alex, 2026-05-26): NOT Telegram

The channel is *transport*, fully separable from identity (which lives on the backend: own memory, data lane, mesh seat). Alex's actual interface today is **VS Code terminal sessions** (this Claude Code session is one). The intended unified door is the **dashboard** (`kai-dashboard` already runs on the Mini) — where Kai and Mira are identity panes/toggles, not separate phone bots. **Telegram-bot-per-identity is dropped.**

- **Power-user door (now):** terminal sessions — stays.
- **Unified door (target):** the dashboard, Kai/Mira as toggled identities in one UI. No app Alex dislikes.
- **Hypothesis (Alex's, plausible, to be verified — see Phase 8):** the dashboard "never worked" because the *infrastructure underneath it* (reliable agent sync + mesh delivery) wasn't there — a cockpit built before the wiring. The Shared Layer + sync work in this plan is precisely that wiring, so dashboard viability is a **downstream payoff** of the org/sync build, not a separate project. CA will *verify* the root cause (infra vs dashboard code) rather than assume it.

---

## 2. ≤60s inter-agent comms — the solution

**⚠ CORRECTION (verified in code 2026-05-26) — the ≤60s "problem" is mostly a misread.** The `300–600s` figures in `/health` (`poll_interval_seconds`) are each agent's **heartbeat** cadence, **not** its message-poll cadence. In code, `cfo-agent.js:38`, `conductor-agent.js:45`, `nami-mesh-poller.js:42` all set `MESH_POLL_INTERVAL = 30s` for the actual mesh inbox; the 300–600s constants are `HEARTBEAT_INTERVAL`/registry pulses. **So every agent already picks up mesh messages within ~30s — single-hop latency already meets ≤60s.**

Implications:
- **Poll-tightening is largely unnecessary** — agents are already at 30s for messages. (The `/health` 60s for kai/nami-bridge is just their heartbeat cadence, not a speed advantage.)
- **Push-nudge is now a nice-to-have, not an emergency:** its value is (a) multi-hop chains (A→B→C at 30s/hop ≈ 90s — push makes it near-instant) and (b) snappiness. DA-gated mesh-contract change; build only if multi-hop latency proves to matter.
- **The real comms pain is reliability, not speed** — empty/unknown-action failures, the two-channel split, the visibility gap (the comms-fix thread, `docs/impl-action-validation-2026-05-26.md`). That is where effort should go.

CA recommends: **drop poll-tightening from Phase 0** (fixes a non-problem); prioritize the **reliability fix**; treat push-nudge as an optional later improvement gated on a real multi-hop latency complaint.

---

## 3. Staged rollout with proof gates

Kai's 3-step Mira staging is preserved verbatim and slotted into the larger sequence. **Every step = Alex go-ahead; every step pre-check / post-check / rollback.**

**Active sequence (this pass — Mira/engine removed):**

| Phase | What | Proof gate | Risk |
|---|---|---|---|
| **0 — Clear the deck** | Await 7TB Dropbox migration; confirm OAuth stable. *(Nearly empty by design: drift overstated, kmg unbuilt, poll-tighten unnecessary — agents already poll messages at 30s. See §2 + §7.)* | Fires clear; OAuth green 48h. | Low — **no live writes required.** |
| **1 — Shared Layer live** | The existing gated pilot: `kameha-mesh.db` → enroll → DAG/NAMI split. *(Kai's 3 cutover decisions first.)* | Receivers re-audited: facts projected, acked, isolated. | Med — already scoped + hardened. |
| **2 — Conductor audit + re-home** | Read-only functional audit; document every function + all readers of `conductor.db`; then re-home as the Chief of Staff's tracking system (infra), function intact. *(Audit can run parallel to 0–1.)* | Audit doc complete; every consumer mapped; re-home with no lost function. | Low→Med. |
| **3 — KMG + client managers** | **Build KMG first** (designed in memory — boundaries v3 + impl kickoff + content inventory — but *unbuilt*: no code/manifest/daemon, only a reserved mesh seat). Then template **DAG + Dental Boutique** managers in KMG's image, riding the Shared Layer wall. Matrix lines wired (solid→Kai/Chief of Staff, diagonal→ACD, functional→working agents). | KMG boots + registers; each client manager scoped to its cubicle, ≤60s, no cross-client read. | Med→High — KMG is net-new build, not an elevation. |
| **4 — Dashboard revival** | Diagnose why `kai-dashboard` doesn't work (infra vs its own code — verify, don't assume), then make it the unified front door over the now-synced state. | Dashboard shows live, correct agent/mesh state; Alex can drive from one UI. | Med — depends on 1–3 (the sync substrate). |

**Deferred — Phase 2 / until-triggered (blueprint kept, NOT built this pass):**

| Phase | What | Trigger to build |
|---|---|---|
| **D1 — Engine refactor** | Extract Kai's engine → `core/` + `kai.identity`. Kai stays sole identity; pure refactor; prove byte-identical. *(High risk — the prerequisite for any split.)* | When the Mira split is greenlit. |
| **D2 — Stand Mira up** | Additive: `mira.identity`, 2nd process, mesh seat, her own front-door (per §1b — not Telegram). | EA load competes with strategic work · hard personal/business wall needed · business growth. |
| **D3 — Prove Mira → Kai sheds EA** | Mira runs personal lane ~1wk in parallel (RISK 01 lands here), then Kai → pure Chief of Staff. | Follows D2. |

---

## 4. Conductor — audit-first approach

**Decision (adopted):** Conductor → the Chief of Staff's tracking system (infrastructure under Kai), **not** a seat in the org.

**Audit before any change** (Conductor is load-bearing — `conductor.db` is the active shared SQLite; note its **3.6 MB WAL** suggests a missing/overdue checkpoint, a health item in itself):
1. **Document every function** — read poller + entry + schema: stage tracking, budgets, overdue/stalled flags, morning/weekly reports.
2. **Map every consumer** — who reads Conductor's flags/db (do NOT sever its mesh seat until readers are repointed).
3. **Surface better logic** — what's outdated vs what's load-bearing.
4. **Re-home** — keep function intact; reframe as infra under the Chief of Staff. Audit-first, change-second, nothing lost.

---

## 5. Client account-manager build spec

- **Pattern:** each client manager is an **identity** on a shared account-manager engine (same config-overlay model as Kai/Mira), **templated from KMG** (elevate the existing brand agent into the canonical template — not a new agent).
- **Isolation:** each manager scoped to its client's **cubicle** = the Shared Layer per-client projection (logical today; chown-ready). DAG → its lane, Dental → its lane; no cross-client read.
- **Matrix reporting:** solid line → Kai (Chief of Staff); diagonal → ACD (creative, per project); functional → each working agent (NAMI/Framer/Enso/etc.).
- **First two:** DAG + Dental Boutique (these are exactly the clients the Shared Layer wall was designed around).
- **Dependency:** Phase 7 requires Phases 1 (Shared Layer) + 3 (engine) done.

---

## 6. Risk register

*(Post-amendment: R01, R03, R06 now attach to the **deferred** D-phases, not this pass — listed for when the split is built.)*

**Kai's (carried verbatim):**
- **R01 · Calendar/email split** (HIGHEST · deferred) — one calendar, one work identity. Mitigation: separate accounts + deterministic ownership router + reconciliation gate (Phase 5 proof).
- **R02 · Don't operate mid-fire** — 24h OAuth outage, deploy drift, 7TB migration in flight. Mitigation: Phase 0 gating; no surgery until the deck is clear.
- **R03 · Mira starts memory-blank** — accepted; she builds her own personal memory.
- **R04 · More reach → guardrails matter more** — guardrails UNCHANGED; Chief of Staff = coordination authority, not autonomy; no auto-chaining (already a CA hard boundary).
- **R05 · Recursion** — CA builds the org including CA's own control-room seat. Noted; not a blocker.

**CA-added (engineering):**
- **R06 · Engine-refactor regression** (HIGH) — extracting `core/` could break Kai. Mitigation: refactor with Kai as the *sole* identity first; prove byte-identical before Mira (Phase 3 gate).
- **R07 · Logical-only isolation** — all procs run as `kai`; cubicles/lanes are logical + signed, not OS-enforced, until the multi-user-Mini project. Stated honestly; not overclaimed.
- **R08 · Push-comms is a mesh-contract change** (DA-gated) — blast radius across all agents. Mitigation: phase B behind the interval-tighten floor (A).
- **R09 · Conductor is load-bearing** — `conductor.db` active + shared; 3.6 MB WAL needs checkpoint. Mitigation: map all readers before re-home; don't sever its seat early.
- **R10 · New external channel (Mira's Telegram bot)** — token custody + the "no external send without approval" guardrail apply; treat bot-token custody like the Shared Layer key-custody decision.

---

## 7. Triangulation note (re-verified against live state)

Per CA practice (senders are unreliable narrators about infrastructure), the work order's §5 claims were checked against the Mini:
- ❌ **"`scripts/mesh/sync-agents-json.js` missing on Mini"** — **FALSE.** It is present at `/Users/kai/kai/scripts/mesh/sync-agents-json.js` (4195 b, identical to repo). This drift example is stale.
- ✅ **"`agents.json` Mini=12 missing kmg, seed=13"** — **CONFIRMED.** Mini `~/.kameha/agents.json` lists 12 (`acd, cfo, chronicle, conductor, enso, framer, kai, lead-engine, nami, nami-bridge, offer-architect, pitch-deck`); mesh `/health` reports 13 (adds `kmg`, inactive).
- ⚠️ **Mini repo lineage** is hourly auto-backup commits diverged from the laptop's feature lineage — but on the **same remote**, and the **Mini *contains* the laptop's feature commits** (verified: Mini has `3fa4b72c`). So "deploy drift" is **largely overstated**: not a stale deployment missing features, just diverged auto-backup state. No big sync needed. *(Retraction of the earlier "Phase 0 must re-scope a real diff" framing — measured 2026-05-26, drift is minor.)*
- ❌ **"agents.json Mini=12 vs mesh=13, add kmg + bring active"** — **misframed.** `kmg` has **no code, no manifest, no pm2 process** on either laptop or Mini — only a *reserved mesh registration* (the phantom 13th). It was extensively **designed** (memory: kmg boundaries v3, impl kickoff, content inventory) but **never built**. Adding it to `agents.json` would register a dead entry. Correct treatment: KMG is a net-new build folded into Phase 3 (client-manager template), or the reserved seat is left/cleaned — *not* a Phase-0 file reconcile.

---

## 8. What CA needs from Alex before building

1. **Approve the architecture** (push-nudge comms; audit-first Conductor → Chief-of-Staff infra; client managers as KMG-templated managers; dashboard as front door). *(Shared-engine/Mira architecture noted but deferred — no approval needed this pass.)*
2. **Sequencing call:** confirm the active Phase 0 → 4 order, and that nothing past Phase 0 starts until the fires (Dropbox migration, OAuth) are clear.
3. **Phase 0 needs no live writes** — agents already poll messages at 30s (≤60s met); drift overstated; kmg unbuilt. The Conductor audit is done (`docs/audit-conductor-2026-05-26.md`); re-home is a safe reframe (no migration). So nothing to green-light for Phase 0 except *waiting out the fires*.
4. **Reprioritize:** the comms work that matters is **reliability** (the action-validation fix, `docs/impl-action-validation-2026-05-26.md`), not latency. Push-nudge is an optional later improvement for multi-hop snappiness.
5. **Note the dependency:** the Shared Layer pilot (Kai's 3 cutover decisions) gates Phases 3–4; and **Phase 3 = build KMG** (designed, unbuilt) before templating DAG/Dental.

---

## DA verdict
**Plan-level pass complete.** Architecture is sound and honest about the single-user isolation posture. **Full CA-internal DA is mandatory before each implementation phase** (Phases 1, 3, 7 and the comms Phase B each touch DA-gate criteria: mesh contracts, identity/isolation, multi-repo, >100 LOC). No code is authorized by this document.

## Run ledger
No state-changing step taken — read-only recon + two doc writes to CA's own repo. Run-ledger entry deferred to first implementation step (run-ledger.js is W4; pre-W4 this rule is policy). This plan is the audit artifact for the planning run.

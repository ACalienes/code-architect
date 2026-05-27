# NEXT SESSION — pickup prompt

_Last updated: 2026-05-27 (end of session 8). Paste/skim this to resume._

## ► START HERE — the main build
**Implement the Board consumption layer (acknowledgement + action)** per **`docs/plan-board-consumption-layer-2026-05-27.md`**.
- **Phase 1 first (acknowledgement, lower risk):** delivery gets an `acked` step; build a reusable consumer (`board-consume.js`) that reads an agent's inbox → logs to its memory → acks; **wire Kai first** end-to-end; upgrade `board-ledger` to show delivered → read → ✓ acknowledged. CA (single-shot) consumes its inbox at session start.
- **Phase 2 (action):** per-type handlers through each agent's action-gate (claim → approval → act; no auto-chaining). Roll out agent-by-agent.
- **Before coding:** Codex-review the design (contract change, touches every agent); CA-internal DA per phase. Honor single-writer discipline (don't reintroduce "database is locked").

## Live infrastructure (Mac Mini, all pm2-saved — survive reboot)
- `board-drainer` — delivers Board facts to every subscribed agent's `~/.kameha/board-inbox/<agent>.ndjson`
- `board-sync` — Conductor→Board auto-emit (posts real project changes; **the first emit hook**, proven live)
- `board-ledger` — live plain-English ledger at **http://100.64.114.13:3350** (Tailscale)
- `kmg` — Kameha Media Group brand agent, deployed + answering brand queries
- The Board DB: `~/.kameha/kameha-mesh.db` (node:sqlite). Mesh routing DB: `/Users/kai/kai/logs/mesh.db` (better-sqlite3, single-owner mesh-api; mutate routes via `PATCH /routes`, actor∈alex/kai/system). Conductor: `~/.kameha/conductor.db` (use its native lib `conductor-db.js` for cycles).
- **14 agents on the Board.** Fact types: client_feedback, creative_brief, decision, status_update, work_order, **objective, question, task**. Publish path: `prototype/shared-layer/board-publish.js`.
- **CA↔Kai mesh loop is OPEN** (kai→code-architect + code-architect→kai, both Tier 2). CA delivers to Kai via mesh now (no pasting). **CA has no listener daemon** → CA must pull `GET /inbox/code-architect` + its board-inbox at **session start** to receive.

## Open items (need Alex or a decision)
1. **GitHub Actions billing** — blocked fleet-wide (account payments); auto-deploy broken, hand-deploy over Tailscale until fixed. → `reference_github_actions_billing_blocked`.
2. **OA pricing** — `kai→offer-architect` queued Tier-2, awaiting Alex approval (`pending_tier2`).
3. **Decide:** flip `code-architect→kai` to Tier 1 (frictionless CA→Kai reports) vs keep Tier 2.
4. **Commit the CA repo** — large uncommitted set (this session's explainers + `prototype/shared-layer/*` scripts + docs). On a **branch** (we're on `main`). **Drop the 2 macOS dupes** (`docs/plan-agent-org-buildout-2026-05-26 2.md`, `explainers/agent-org-buildout-plan-2026-05-26 2.html`).
5. **JMM Law** — no `retainer_template` in Conductor → June cycle empty. Define its monthly deliverables.
6. **Gort Productions** — PAST-DUE 2026-05-04, stage 10/10 (done-not-closed). Close out / invoice.
7. **Conductor freshness** — statuses are stale (I did not fabricate "done"); durable fix = Conductor maintaining its own cycles/statuses (the "Conductor re-home" item).
8. **Per-agent emit hooks** — Conductor done (board-sync); CFO/ACD/NAMI/etc. still emit nothing → wire incrementally (pairs naturally with the consumption layer).

## Key context
- Project spine: `[[project_agent_org_buildout]]`. The Board = Shared Layer; live VIEW = the dashboard replacement. Governs: `[[feedback_why_dashboard_went_unused]]`.
- Chronicle = personal health agent — **kept OFF** the agency board. nami-bridge = transport, skipped.
- Specs: `docs/spec-board-consumption-contract-2026-05-27.md`, intake `docs/intake-kai-ca-board-fact-types-2026-05-27.md`.
- This session (8) full log: auto-memory `session-2026-05-27.md`.

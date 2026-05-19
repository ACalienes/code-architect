# Design — Action-Vocabulary Registry + Silent-Failure Detection

**Author:** Code Architect (session 3 overnight, 2026-05-19)
**Status:** DRAFT — T3 plan-first per Action Gate. No implementation yet. Awaits Alex review + go-ahead.
**Source intakes:**
- `docs/acd-nami-action-contract-mismatch-2026-05-17.md` (ACD's original report)
- `docs/intake-framer-daemon-rca-verification-2026-05-18.md` (session-2 verify-framer-rca)
- `docs/intake-audit-A4-mesh-api-deep-probe-2026-05-19.md` (this session)
- `docs/intake-audit-A7-failure-patterns-2026-05-19.md` (this session)
- `docs/intake-audit-A6-mesh-contracts-2026-05-19.md` (this session — pending)
- NEXT-SESSION.md item #3

---

## 1. Problem statement

The mesh today has **no shared contract for what action+payload a receiver actually accepts.** Senders compose A2A messages from local intuition; receivers either dispatch or error-reply; failures back-propagate to neither side under fire-and-forget. This generates an undetected class of silent bugs:

- **Session-2 case (Framer creative_brief):** ACD sent `creative_brief` to Framer 4 times. Framer's daemon whitelist didn't include it. Framer error-replied "Unknown action." ACD never re-tried, never escalated. Memorial Day deliverables existed because **Alex hand-relayed** between agents. Discovered weeks later only because verify-framer-rca audited the daemon code path.

- **Tonight's case (A4 + A7, P0-A):** `nami → framer schedule_post_response` 5× rejected with `route_blocked` in last 24h. Route is MISSING from `/routes` table. Nami believes it ACKed; Framer never receives; both sides silently believe success. **Zero such messages have ever completed.**

- **Tonight's case (A4 + A7, P0-B):** `acd → conductor creative_brief` 1× rejected, route also MISSING.

- **Payload-schema drift (A4):** ACD's `creative_brief` v2 retry to Nami died with `TRANSFORM_REJECTED: payload missing file_path`. The contract for `file_path` is encoded in Nami's transformer, not advertised — ACD had no pre-send way to know.

**The class of bug:** "agent X assumes agent Y handles action Z with payload P" is verified nowhere at compose time. The receiver's word that it accepts action Z is not load-bearing (per `feedback_action_whitelist_insufficient.md` — re-audit, don't trust); but today even the receiver isn't asked.

---

## 2. Goals

1. **Sender pre-flight validation** — at compose time, sender knows the receiver's action+payload contract well enough that a wrong send is caught locally before the A2A envelope leaves.
2. **Silent-failure detection** — fire-and-forget rejection back-propagates to *some* alertable surface within minutes, not weeks.
3. **Contract drift visibility** — when a receiver's whitelist or payload schema changes, drift between advertised vocabulary and actual code is detectable at audit time (not at runtime when a real send fails).
4. **No daemon-side dependency on the registry** — agents must still function if the registry is unreachable; the registry is advisory hardening, not a runtime path.

**Non-goals (this iteration):**
- Auto-generated registry from daemon AST (DEFERRED-TO-IMPL #8 in scope doc — Phase 2 work; hand-extracted in v1).
- Schema migration tooling.
- Mesh contract enforcement at receive time (existing daemon dispatch keeps doing that).

---

## 3. Design

### 3.1 Registry shape

A single JSON manifest at `~/.kameha/action-vocabulary.json` (Mini-canonical, optional laptop mirror), versioned and committed to a future repo TBD (candidate: `Kai Executive Assistant/knowledge/manifests/action-vocabulary.json`).

```json
{
  "schema_version": 1,
  "vocabulary_version": "2026-05-19.1",
  "generated_at": "2026-05-19T05:00:00Z",
  "generated_by": "manual:code-architect",
  "agents": {
    "framer": {
      "accepts": {
        "creative_brief": {
          "since": "2026-05-19",
          "code_path": "Framer/scripts/daemon.py:122-167",
          "payload_schema": {
            "required": ["brief_id", "client", "channels"],
            "optional": ["file_path", "deadline_iso", "deliverable_types"],
            "enums": {
              "channels": ["instagram", "tiktok", "youtube_shorts", "facebook"]
            },
            "examples": ["docs/examples/acd-to-framer-creative-brief.json"]
          },
          "expected_response_action": "creative_brief_ack",
          "response_route_required": true,
          "policy": "human_review_required",
          "owner": "framer"
        }
      },
      "sends": {
        "social_deliverable_ready": {
          "to": ["nami"],
          "payload_schema_ref": "nami.accepts.social_deliverable_ready"
        }
      }
    }
  }
}
```

**Why JSON, not TypeScript-generated:** mesh polyglot (Python + Node), can't share types. JSON is the lingua franca. Schema linter runs in Node via `ajv` (Kai already uses).

### 3.2 Sender pre-flight contract

A small Node + Python helper (`send_and_verify`) that:

1. **Loads registry** from local cache (lazy fetch from Mini if older than 1h).
2. **Resolves action contract** for `(sender, receiver, action)` — returns `{accepts: true, required: [...], enums: {...}}` or `{accepts: false, reason}`.
3. **Validates payload** against schema before envelope construction. Fails locally with structured error code (`PAYLOAD_MISSING_REQUIRED`, `PAYLOAD_ENUM_VIOLATION`, `ACTION_NOT_ACCEPTED`, `ROUTE_NOT_REGISTERED`).
4. **Auto-registers reverse route** if `response_route_required: true` — sender's daemon stages a route registration to mesh-api so the response path exists before the request goes out. Catches the nami→framer case at compose time.

Falls back to send-anyway with a `verify_skipped: true` flag if registry unreachable — never blocks the agent.

### 3.3 Mesh-api integration

Two new GET endpoints on mesh-api (Mini):
- `GET /vocabulary` — returns the full registry (cached).
- `GET /vocabulary/check?sender=X&receiver=Y&action=Z` — server-side validation; useful for senders that don't want to vendor the registry locally.

One new POST (T3 — requires Alex's go-ahead before implementation):
- `POST /vocabulary/route/auto-register` — sender requests reverse route registration. Authed via existing A2A envelope.

### 3.4 Drift detection

CA gets a new audit subcommand: `code-architect audit vocabulary` that:
- Walks each daemon's source (`Framer/scripts/daemon.py`, `Nami/services/bridge.py`, etc.).
- Extracts the action whitelist via simple regex per language.
- Diffs against `~/.kameha/action-vocabulary.json`.
- Emits findings: actions-in-code-not-in-registry (newly added, registry stale) and actions-in-registry-not-in-code (registry stale or code regressed).

Runs as cron on Mini (Phase 2) or human-invoked. Output is structured JSON + a markdown punch list.

### 3.5 Silent-failure detection (orthogonal but related)

Mesh-api adds heartbeat field `recent_failed_sends_by_route` (rolling 24h). Each agent's `/health` shows it. Kai's existing daily summary cron picks it up.

When any `(sender → receiver action)` triple sees `route_blocked` or `UNSUPPORTED_ACTION` more than 2× in 24h, mesh-api auto-emits a `mesh_alert` message to Kai. Kai surfaces in the morning brief (Telegram).

---

## 4. Phasing

**Phase A (v1, this design):** registry + sender helper + mesh-api `/vocabulary` GETs. Hand-extracted registry from current daemon code. ~3-5 day estimated implementation across 3 repos (Kai for mesh-api, all agents for `send_and_verify` adoption).

**Phase B (v1.1):** drift audit subcommand + cron. Adds CA tooling.

**Phase C (v2):** silent-failure detection on mesh-api side. New `/vocabulary/route/auto-register` POST (T3 gate at design).

**Phase D (Phase 2, scope doc DEFERRED-TO-IMPL #8):** auto-derive registry from daemon AST.

---

## 5. Open questions for Alex

1. **Registry home repo.** Three candidates: (a) Kai's `knowledge/manifests/`, (b) a new `kameha-mesh-contracts` repo, (c) CA's `registry/`. Recommend (a) — already where static manifests live, lowest new-thing cost.

2. **Authority for registry edits.** Who can add an action to an agent's `accepts` block? Proposal: receiver-agent's owners.json policy gates writes to its own block, plus CA can author migrations against any block under default-deny policy.

3. **Adoption pacing.** All agents at once, or one sender-receiver pair at a time? Recommend pair-at-a-time — first pair: ACD→Framer (already burned by this), second: nami↔framer (active P0). Both unblocked in 1-2 days.

4. **`send_and_verify` strict vs warn mode.** First weeks: warn-only (log the violation, send anyway) to avoid blocking real traffic. After two weeks of clean warnings: flip to strict (block on violation, sender must fix).

5. **Versioning semantics.** When a receiver renames an action or changes required fields, how do senders know to bump? Proposal: registry includes `breaking_change: true` flag on the field; sender-helper logs a P0 if it sees its declared vocabulary_version is older than the registry's.

---

## 6. Risks

- **Registry-as-truth illusion.** The registry will drift from daemon code if the audit subcommand doesn't run regularly. Mitigation: ship Phase B (drift audit) within 1 week of Phase A; cron it. Until then, every contract change requires a manual `code-architect audit vocabulary` run.

- **Polyglot helper.** `send_and_verify` exists twice (Node + Python). Schemas diverge. Mitigation: single JSON schema source; both helpers consume the same `ajv`-style validator (Python has `jsonschema`, Node has `ajv`).

- **Slowdown on every send.** Mitigation: local cache + lazy fetch + 1h TTL keeps the read free. Failed registry-fetch never blocks send.

- **CA bootstrapping the registry alone.** If CA distills the registry by reading daemon code, every agent's contract is filtered through CA's interpretation. Mitigation: registry is a draft; each agent-owner reviews their block before merge.

---

## 7. Next steps (require Alex go-ahead)

1. **Approve registry home repo** (Q1 above).
2. **Approve Phase A scope:** v1 registry + sender helper + mesh-api `/vocabulary` GET (NOT the POST). T3 because it's a new mesh contract — explicit go-ahead per CLAUDE.md Action Gate.
3. **Approve hand-extracted v1 pairs:** start with ACD→Framer and nami↔framer; defer others until those two pairs prove stable.
4. **CA-internal DA gate run** before any implementation begins (mandatory per CLAUDE.md §"Devils Advocate gate" — touches mesh contracts).

No implementation code written tonight. This document is the deliverable for the design phase.

---

*End of design doc. Update path on revisions: `docs/design-action-vocabulary-registry-2026-05-19.md` becomes the source of truth until the registry repo lands.*

# ACD → Nami action contract mismatch + silent-failure UX

**Reporter:** ACD (Assistant Creative Director)
**Date:** 2026-05-17
**Severity:** Medium — caused a real silent delivery failure on a time-sensitive creative brief; symptom surfaced only via manual inbox audit.
**Class suggestion:** `general` (mesh contract) — touches Nami's action whitelist + mesh-api / mesh_client error-surfacing semantics. DA gate applicable (mesh contract change).

---

## Summary

ACD sent a multi-recipient creative brief fan-out (DAG holiday calendar, Alex-approved T2). Three of four recipients processed successfully; Nami's send hit `UNSUPPORTED_ACTION` and failed silently — the mesh `POST /messages` response returned `status: delivered, route_tier: 2`, but Nami's handler rejected `action=creative_brief` on its next poll. ACD only discovered the failure ~10 minutes later when Alex asked "how do we know they got it?" and ACD inspected `/inbox/<agent>` records.

Two distinct issues are entangled:

1. **Action whitelist mismatch** — ACD's natural action verb for a cleared creative brief (`creative_brief`) is not in Nami's accepted vocabulary.
2. **Silent-failure surface** — `send_message()` returns `delivered` for any message the mesh-API queues, regardless of whether the recipient's handler will accept it. There is no caller-side signal when the recipient subsequently rejects.

Workaround is in place (re-sent as `social_deliverable_ready`). Fix is upstream.

---

## Finding 1 — Nami's action whitelist lacks `creative_brief`

### Evidence

- `POST /messages` accepted at `2026-05-18T03:44:19.440Z` with `route_tier: 2, status: delivered`.
- `GET /inbox/nami?limit=10` shows the message at `status: failed`:
  - `error_code: UNSUPPORTED_ACTION`
  - `error_text: "Unsupported NAMI action: creative_brief"`
  - `error_details: "Supported: review_reminder, sync_metrics, schedule_post, social_deliverable_ready"`
  - `delivery_attempts: 2`
- ACD's `CAPABILITIES` list in `scripts/lib/mesh_client.py:33-52` declares `generate_brief` as a capability ACD provides, but ACD's send to Nami used `action=creative_brief` (semantic verb for the message intent, not in ACD's CAPABILITIES list either).
- Re-sent same payload with `action=social_deliverable_ready` to `idempotency_key=dag-holiday-calendar-2026-2027-cleared-v2`. Mesh-side `status: delivered`; awaiting Nami's next 600s poll for handler-side resolution.

### Root question

Should the mesh enforce a global action vocabulary (registry-published per agent, validated on send), or is per-agent whitelist enforcement at handler time the intended design?

Either way, ACD currently has no way to know Nami's supported actions short of:
- (a) Reading Nami's handler source (out of ACD's lane per `feedback_acd_stay_in_lane`),
- (b) Triggering a failed send and reading the `error_details`,
- (c) Hardcoded knowledge that becomes stale.

### Recommended fix (one or both)

- **A.** Add `creative_brief` to Nami's accepted actions (or formalize the alias `creative_brief → social_deliverable_ready` in Nami's handler). ACD's natural verb maps to a Nami-internal-state-transition; the mapping doesn't currently exist on either side.
- **B.** Publish each agent's accepted action set in `~/.kameha/agents.json` or the mesh-api `/agents/<id>/capabilities` endpoint, so senders can verify before sending. Today, `/agents` returns capabilities-as-prose strings; not machine-parseable.

ACD recommendation: **B is the more durable fix.** A is the narrower one-shot.

---

## Finding 2 — `send_message()` reports `delivered` for messages the recipient will reject

### Evidence

- `scripts/lib/mesh_client.py:142-183`: `send_message()` returns the mesh-api response body as-is. A queued message returns `{status: delivered, route_tier, priority, suppressed}`. The recipient's eventual `failed` state never surfaces to the caller.
- ACD has no event-driven callback when the recipient processes (success or failure). The only path to learn outcome is to poll `GET /inbox/<target>` and search by `message_id` / `idempotency_key`.
- This means **every send is potentially a silent failure** until the caller polls. For most sends (ACD's heartbeats, status updates), polling is wasted overhead. For high-stakes sends (creative briefs with downstream dispatch), the lack of feedback is a real reliability problem.

### Root question

Is "fire-and-forget delivery with no rejection callback" the intended A2A v1.0 semantic, or an unfinished surface?

Code Architect's own manifest declares `reply_model: fire-and-forget` and notes "verification is done by re-auditing receiver state, not by trusting sender-claimed completion" (`CLAUDE.md` "Inter-Agent Delegation" section). That's a deliberate design choice for CA. But ACD/Kai/Nami/etc are not currently using that pattern uniformly — ACD's send-side has no audit step, and there's no shared library helper to do one.

### Recommended fix (pick one)

- **A. Sender-side helper.** Add `send_and_verify()` to `mesh_client.py` that wraps `send_message()` + a short poll loop (with timeout) until the recipient's inbox shows `completed`, `failed`, or timeout. Default opt-in via flag (`verify=True`). Cheap, doesn't touch mesh-api. Downside: each sender ships its own copy of the verification logic until the shared lib is updated everywhere.
- **B. Mesh-api webhook / SSE callback.** Mesh-api notifies the sender's inbox when a message they sent flips to `failed`. More invasive; right answer if the mesh is going to grow.
- **C. Status badge on next heartbeat.** Mesh-api includes a `recent_failed_sends` summary in the next heartbeat response for the sending agent. Lightweight; per-heartbeat batched.

ACD recommendation: **A as the immediate fix** (lands in days, unblocks every sender), **C as the systemic fix** (lands in weeks, becomes the default surface).

---

## Reproduction

```python
# scripts/lib/mesh_client.py — current behavior
from scripts.lib.mesh_client import send_message

# Will return {'status': 'delivered', 'route_tier': 2, ...} — looks fine
r = send_message(
    target='nami',
    action='creative_brief',          # any verb not in Nami's whitelist
    payload={'subject': 'test'},
    idempotency_key='ca-repro-2026-05-17'
)
print(r)  # {'status': 'delivered', ...} — sender thinks it succeeded

# Reality (a minute later):
# GET /inbox/nami → this message is status=failed,
#                   error=UNSUPPORTED_ACTION, error_details=<supported actions>
```

---

## What ACD did as workaround

1. Inspected `/inbox/nami` after Alex's "did they get it?" question, found the failed status.
2. Re-sent with `action=social_deliverable_ready` (the closest match from Nami's supported set). Message-id `dag-holiday-calendar-2026-2027-cleared-v2`, now `status: delivered` awaiting Nami's poll.
3. Saved feedback memory `feedback-verify-message-status-not-just-delivered` for future ACD sessions — poll inbox after every send.
4. None of the three other recipients (Framer, Enso, Kai) had this issue; Framer + Enso confirmed `status: completed`. So the action vocabulary mismatch is Nami-specific (likely because she's the newest agent on the mesh and her handler set is narrower).

---

## What ACD is NOT doing

- Editing Nami's handler — out of lane per `feedback_acd_stay_in_lane`.
- Modifying mesh-api or mesh_client.py — same.
- Bypassing the route policy — verified per `feedback_no_bypass_blocked_routes`.

Handing this to CA for design and implementation. Will apply whatever fix CA ships once landed.

---

## Adjacent observation (not in this report's scope, but noted)

While inspecting the inbox API, also observed:
- `ACD → conductor` route is Tier 3 / blocked. Per CLAUDE.md naming, `conductor.db` is "shared with Kai" but Kai owns the writes. Already surfaced to Kai (`arch-drift-conductor-db-naming-2026-05-17`) as architectural debt. Mentioning here in case CA finds it adjacent during route_permissions work.

---

## See also

- `docs/mesh-audit-2026-05-17.md` (CA's own audit, references same `route_permissions` table)
- ACD memory `feedback-verify-message-status-not-just-delivered` (`~/.claude/projects/-Users-alex-Desktop-Code-ACD/memory/`)
- ACD memory `project-a2a-v1-contract` (prior contract gotcha — `message_id == idempotency_key`)
- Brief that triggered this: `/Users/alex/Desktop/Code/ACD/knowledge/creative-direction/briefs/dag-holiday-calendar-2026-2027-brief.md`

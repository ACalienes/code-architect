# Intake — Verification of Framer-authored ACD→NAMI RCA (creative_brief landing claim)

**Date received:** 2026-05-18
**Originator:** CA verify-framer-rca agent (read-only triangulation pass)
**Intake source:** CA session 2 verification dispatch
**Topic:** Did ACD's `creative_brief` work orders to Framer on 2026-05-18 actually land + get processed by Framer's daemon, or did the daemon error-reply?
**Disposition:** Verdict reached. RCA premise refuted. Implications for the NAMI `creative_brief` endpoint and for cross-agent intake trust are recorded below.

---

## Verification question

The Framer-authored RCA claimed: "ACD bypassed NAMI entirely and sent the Memorial Day brief direct to Framer (`dag-memorial-day-2025-dispatch-2026-05-18 → action=creative_brief`). Framer's daemon accepts arbitrary action types so it landed."

But `/Users/alex/Desktop/Code/Framer/scripts/daemon.py:122-170` maintains an explicit 15-entry `handlers` dict whitelist; `creative_brief` is NOT in it; unknown actions trigger an `error` reply with payload `{"original_action": ..., "error": "Unknown action: ..."}` (line 165-169).

Three hypotheses tested:
- **(a)** Daemon error-replied; the "workaround worked" narrative is wrong.
- **(b)** Brief arrived nested inside a whitelisted handler's payload (e.g., wrapped as `generate_graphic`).
- **(c)** Daemon was a different (more permissive) version when the incident happened.

---

## Sources checked

### Source 1 — Framer daemon source + git history (test hypothesis c)

- `scripts/daemon.py:122-170` — explicit 15-entry `handlers` dict; no `creative_brief`; unknown-action branch sends back `{"action": "error", "payload": {"original_action": ..., "error": "Unknown action: ..."}}` and calls `mesh.acknowledge(msg_id)`.
- `git log --oneline -20 -- scripts/daemon.py` — most recent change is `93905c1 feat(mesh): cluster B step 2 — work-heartbeat sender for Framer (Python)`. NO commits to daemon.py since 2026-05-17 (`git log --since="2026-05-17"` returns empty). The code path that error-replies on `creative_brief` was already live during all four ACD send attempts on 2026-05-18.
- **Hypothesis (c) eliminated.**

### Source 2 — ACD activity log (`/Users/alex/Desktop/Code/ACD/logs/acd-activity.jsonl`)

ACD's own runtime log records the chronology cleanly. Relevant entries (session_id `573d851c-09a6-4541-b6c5-fd87251986e4`):

| Timestamp (UTC) | Action |
|---|---|
| 03:43:57 | ACD writes the brief md file |
| 03:44:19 | ACD sends to NAMI as `creative_brief` — fails (UNSUPPORTED_ACTION, per orig RCA) |
| 03:45:43 | ACD pivots, sends to Framer as `creative_brief` (this is the "workaround" send) |
| 03:46:14 | (See source 3) Framer mesh returns error message to ACD |
| 03:53:30 | ACD retries to NAMI as `social_deliverable_ready` — fails (payload missing `file_path`) |
| 16:41:46 | ACD re-dispatches Memorial Day brief to Framer as `creative_brief` (msg `dag-memorial-day-2025-dispatch-2026-05-18`) |
| 22:03:00 | ACD queries `http://100.64.114.13:3341/inbox/framer?limit=30` to check Framer-side delivery status |
| 22:03:11 | ACD then checks `/Users/alex/Desktop/Code/Framer/outputs/dagdc/memorial-day-2026/` for actual deliverables |
| 22:38:05 | ACD sends Framer another `creative_brief` (msg `dag-memorial-day-render-v1-call-2026-05-18`) thanking Framer for contact sheet + giving #05 + dusk-grade direction |
| 23:21:57 | ACD queries its own inbox for messages from Framer to read responses |
| 23:23:46 | ACD sends Framer another `creative_brief` (msg `dag-memorial-day-render-final-call-2026-05-18`) authorizing render of A1 |

The pattern in the log: ACD sends `creative_brief` -> ACD then verifies by (a) querying mesh inboxes and (b) checking files on disk. ACD was not reading its own inbox for error replies until 23:21. The 03:46 error reply from Framer's mesh client sat unread in ACD's inbox for ~20 hours.

### Source 3 — Mesh-api live query (Mac Mini, `http://100.64.114.13:3341`)

Laptop mesh.db copies are stale (`/Users/alex/.kameha/mesh.db` is 0 bytes mtime 2026-05-10; `/Users/alex/.kameha/mesh/mesh.db` is 80 KB mtime 2026-03-26). Authoritative state is Mac Mini. Live HTTP query results:

**Framer's inbox** (filtered to relevant message IDs):
```
dag-holiday-calendar-2026-2027-framer-heads-up   action=creative_brief  status=completed attempts=1  from=acd  created=2026-05-18T03:45:42Z
dag-memorial-day-2025-dispatch-2026-05-18        action=creative_brief  status=completed attempts=1  from=acd  created=2026-05-18T16:41:46Z
dag-memorial-day-render-v1-call-2026-05-18       action=creative_brief  status=completed attempts=1  from=acd  created=2026-05-18T22:37:55Z
dag-memorial-day-render-final-call-2026-05-18    action=creative_brief  status=completed attempts=1  from=acd  created=2026-05-18T23:23:38Z
```

All four show `status=completed, attempts=1, last_error=None`. **This is what fooled the RCA.** "Completed" here means the receiver called `mesh.acknowledge(msg_id)`, NOT that the action handler ran successfully. Daemon.py:163 + :170 both call `mesh.acknowledge(msg_id)` — once in the success branch AND once in the unknown-action branch right after sending the error reply.

**ACD's inbox, from=framer:**
```
2026-05-18T03:46:14Z  action=error  payload.original_action=creative_brief  error="Unknown action: creative_brief. Available: ['generate_derivatives', ...]"
2026-05-18T16:42:45Z  action=error  payload.original_action=creative_brief  error="Unknown action: creative_brief. Available: ['generate_derivatives', ...]"
2026-05-18T22:38:51Z  action=error  payload.original_action=creative_brief  error="Unknown action: creative_brief. Available: ['generate_derivatives', ...]"
2026-05-18T23:23:44Z  action=error  payload.original_action=creative_brief  error="Unknown action: creative_brief. Available: ['generate_derivatives', ...]"
```

Exact 1:1 mapping: every `creative_brief` ACD sent triggered an `error` reply from Framer's daemon within ~60 seconds. The reply payload's `Available:` list matches today's handlers dict — confirming the same code path that exists now ran then. **Hypothesis (a) confirmed.**

For completeness, hypothesis (b) is also eliminated: the live `messages/dag-memorial-day-2025-dispatch-2026-05-18` payload shows `action: "creative_brief"` at the top level, not nested inside a whitelisted handler. The payload is a flat brief document (subject, what_to_make, avoid, operating_rules) with no `generate_graphic`-shaped wrapper.

### Source 4 — Actual deliverable evidence (`/Users/alex/Desktop/Code/Framer/outputs/dagdc/memorial-day-2026/`)

Files DO exist and ARE recent:

```
contact-sheet.jpg                          2026-05-18 13:52
v1.jpg, v1-alt-warm.jpg                   2026-05-18 18:47
review-sheet.jpg                          2026-05-18 18:58
candidate-A-facade.jpg, candidate-B...    2026-05-18 18:40
review-A-messaging.jpg                    2026-05-18 19:07
review-A-copy-options.jpg                 2026-05-18 19:57
review-A-creative-directions.jpg          2026-05-18 20:15
review-A-typography-only.jpg              2026-05-18 20:36
review-A-backgrounds.jpg                  2026-05-18 20:42
review-A-stock-backgrounds.jpg            2026-05-18 21:21
review-A-meaningful-backgrounds.jpg       2026-05-18 21:40
_panels/{BG,T,SF,MD}*.jpg                 2026-05-18 20:36–21:40
```

So Memorial Day work IS happening on the Framer side. But the daemon did not start it — the daemon error-replied to every `creative_brief`. This means the work is being produced by a non-daemon path: either a human-operated Framer Claude Code session reading the brief manually, or Alex driving renders directly. Corroborating evidence: ACD's inbox contains a 2026-05-18T23:10:43Z reply from Framer with `action=creative_brief_clarification`, `msg_id=framer-acd-memorial-day-messaging-guidance-2026-05-18`, `correlation_id=dag-memorial-day-render-v1-call-2026-05-18`. The daemon does not emit `creative_brief_clarification` (not in the handlers dict, not in the error branch); this reply has to be human/Claude-Code authored and sent via `mesh.send_message` from a Framer-side terminal session.

### Source 5 — Mesh.db direct query

Skipped as redundant. The live mesh-api in Source 3 reads from the same canonical mesh.db on the Mini. Laptop mesh.db files are confirmed stale (0 bytes / 7 weeks old).

---

## Verdict

**Hypothesis (a) is correct, with high confidence.**

The RCA's claim "Framer's daemon accepts arbitrary action types so it landed" is **false**. Every one of the four `creative_brief` messages ACD sent to Framer on 2026-05-18 triggered a daemon `Unknown action` error reply within ~60 seconds. The "status=completed" indicator in Framer's mesh inbox is misleading — it reflects `mesh.acknowledge()` being called after the error reply, NOT successful action dispatch.

Evidence weight:
1. **Source 3 (live mesh-api) — definitive.** Four error replies in ACD's inbox, exact 1:1 with the four creative_brief sends, naming `original_action=creative_brief` and listing the current handlers dict.
2. **Source 1 (daemon code + git history) — corroborates.** Daemon code that error-replies on `creative_brief` was already live before all four sends.
3. **Source 4 (actual deliverables) — qualifies.** Memorial Day work IS happening, but through a non-daemon path (likely human/Claude-Code operator on Framer side). The daemon is not the channel doing the work; it's a parallel rejected channel.

---

## Implications

### For the NAMI `creative_brief` endpoint we're queued to ship

We thought we were unblocking a working pattern (ACD→Framer creative_brief landing OK; just NAMI broken). Reality: **the entire `creative_brief` action verb is not wired into ANY agent's daemon.** Framer's daemon rejects it the same way NAMI's poller does — different rejection mechanism (handler lookup miss vs. transform-whitelist miss), same outcome.

This changes the scope of the queued Option 1 fix:
- The NAMI fix as-specified (add `transformCreativeBrief`, register on NAMI Render service) is still the right shape.
- But we should also add `creative_brief` to Framer's daemon `handlers` dict (or define what Framer SHOULD do with a `creative_brief` — store as a project brief? route to a planner? trigger a confirmation reply?).
- The action-vocabulary registry (the companion item from session 1 queue) is now urgent, not nice-to-have. We have two agents silently rejecting the same action verb because there is no contract definition for it. The registry would have flagged "no receiver registered for action `creative_brief`" before the first ACD send.

### For Memorial Day work status

**Memorial Day work IS moving** — Framer has produced contact sheet, candidates A/B, multiple review sheets, and panel variants between 13:52 and 21:40 on 2026-05-18. But:
- The mesh daemon dispatched none of it.
- The execution path is human/Claude-Code operator on Framer's side reading the brief manually from somewhere (likely Alex pasting or a Framer Claude Code session inspecting mesh inbox / brief md file).
- This is fragile: if Alex stops manually relaying, Memorial Day stalls. The 11-post holiday calendar referenced in the larger brief depends on this same broken channel.

### For trust in cross-agent intake reports going forward

**Significant trust hit on Framer-authored RCAs.** The RCA was confident, specific (named file:line citations on NAMI side), and on the central failure mode it described (NAMI rejection) it was accurate. But on the part it was authoritatively reporting from its own vantage point (whether Framer's daemon accepted the message), it was wrong. Framer asserted daemon behavior without checking the daemon's actual behavior — they observed "ACD's send returned success" / "mesh inbox status=completed" and inferred "daemon processed it," skipping the receiver-side reality check.

This is exactly the failure mode codified in `feedback_action_whitelist_insufficient.md`: the sender's word is not load-bearing; reality is what re-audit shows. The RCA self-applied this principle to NAMI (correctly identified NAMI's rejection) but not to itself (Framer's own daemon also rejecting).

Going forward, treat agent-authored RCAs the same way we treat any sender claim: triangulate before acting. CA's verification pass here is the template — three independent sources, weight evidence by directness to the question.

---

## Recommended follow-up actions

1. **Update intake doc** `docs/intake-framer-acd-nami-rca-2026-05-18.md` with a "Verified false — see verification report" header pointing to this file. The Option 1 scope estimate (~30 LOC across 3 files) understated the work: add Framer daemon handler too.

2. **Tell Alex** Memorial Day work is happening on manual/human-operator power, not on daemon dispatch. If Alex thought this was running headless from ACD direction, that's wrong; he is in the loop whether he knows it or not. Schedule a 5-min sync to clarify what's actually relaying.

3. **Promote action-vocabulary registry to W5/W6 same-PR-as-NAMI-fix.** Co-shipping prevents the next contract drift from being discovered post-mortem. The registry should fail-closed: senders verify receiver-side action support before dispatch; receivers without `creative_brief` should be flagged at registration time, not at first send.

4. **Add `creative_brief` handler to Framer's daemon** as part of the same change set. Even a stub that stores the brief and replies `creative_brief_acknowledged` is better than `Unknown action`. Spec: probably persist to `framer.db`, optionally route to a planner, return ack with brief_id. Coordinate with Framer owner on what semantically belongs there.

5. **Audit other agents for silent `Unknown action` patterns.** Check Enso, Conductor, Lead-Engine daemons for the same handler-dict pattern, and cross-reference with mesh-api's `acd→*` and `*→*` route whitelist. Any receiver that's whitelisted to receive an action it has no handler for is a silent-failure waiting point.

6. **CA-side: codify this verification pattern as a memory card** ("verify-agent-rcas-via-triangulation") so future intake processing defaults to receiver-side re-audit, not sender-claim acceptance. The pattern: read claim → identify which agent's behavior is being asserted → query THAT agent's runtime state directly (mesh inbox, daemon log, deliverable on disk), not the asserter's.

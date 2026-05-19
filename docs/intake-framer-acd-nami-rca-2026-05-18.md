# Intake — Framer-authored ACD→NAMI delivery RCA

**Date received:** 2026-05-18
**Originator:** Framer (authored from Framer's vantage point — Framer was the workaround destination when ACD bypassed NAMI)
**Intake source:** Alex paste during CA session 2
**Topic:** Root-cause analysis of the ACD→NAMI mesh delivery failure first reported on 2026-05-17 (commits `6157720`, `89375fd`)
**Disposition:** Queued (priority #6 in `NEXT-SESSION.md`). Implementation blocked on Kai `.kameha/owners.json` bootstrap (queue item #2) because the fix touches `~/kai/scripts/nami-mesh-poller.js` and `~/kai/scripts/mesh/mesh-api.js`.

---

## Original content (verbatim paste)

> Got the full picture from mesh failure logs + NAMI poller source. Here's what's broken and how to fix it.
>
> ### Root cause
>
> NAMI's mesh-poller (`~/kai/scripts/nami-mesh-poller.js` on the Mini) is a publish-asset bridge, not a general agent channel. It only knows four actions, and each one has a strict payload contract that assumes a finished asset is attached:
>
> | Action | What it's for | Required payload |
> |---|---|---|
> | `review_reminder` | Ping Dan about pending reviews | — |
> | `sync_metrics` | Pull post performance | — |
> | `schedule_post` | Framer hands off carousel/static with files | `slides_dir` (abs path on Mini), `client` |
> | `social_deliverable_ready` | Enso hands off rendered video with file | `file_path` (abs path), `client` |
>
> What ACD is trying to do: deliver a creative-direction brief — a decision matrix, copy spec, batch calendar — so NAMI can dispatch downstream WOs from it. That's not a "publish this asset" message. It doesn't fit either transform: there's no finished file to attach.
>
> ### Evidence — three failed sends today
>
> 1. **`dag-holiday-calendar-2026-2027-cleared`** (03:44 UTC) — ACD sent `action=creative_brief`. NAMI poller checks against its action whitelist → `UNSUPPORTED_ACTION`. Failed after 3 attempts.
>    > Unsupported NAMI action: `creative_brief`. Supported: `review_reminder`, `sync_metrics`, `schedule_post`, `social_deliverable_ready`
>
> 2. **`dag-holiday-calendar-2026-2027-cleared-v2`** (03:53 UTC, ~9 min later) — ACD retried with `action=social_deliverable_ready` (a valid action), same brief in payload. Passed the action gate. Failed at the payload transform:
>    > Transform `social_deliverable` rejected payload — `social_deliverable_ready` payload missing `file_path`
>
>    Transform code at `nami-mesh-poller.js:283`: `if (!filePath) return { error: 'social_deliverable_ready payload missing file_path' };`. Brief data has no file to attach because briefs aren't deliverables.
>
> 3. **`acd-nami-probe-1779108906`** (12:55 UTC) — ACD probe still queued, 0 attempts. Payload is `{subject, client, probe}` only — will fail the same way (no `file_path`) when the poller next claims it.
>
> ### Why ACD pivoted to dispatching Framer direct
>
> After both attempts failed, ACD bypassed NAMI entirely and sent the Memorial Day brief direct to Framer (`dag-memorial-day-2025-dispatch-2026-05-18 → action=creative_brief`). Framer's daemon accepts arbitrary action types so it landed. That's how we got the Memorial Day work moving — but it means **NAMI is out of the loop for cadence/dispatch right now**. Every holiday in the calendar will require ACD-direct-to-Framer dispatch until the channel is fixed.
>
> ### Fix options
>
> **Option 1 — Add a `creative_brief` action to NAMI's poller** (recommended).
> This is the right long-term fix. Three small changes:
> - **NAMI Render service**: expose `POST /intents/creative_brief` (or similar) that accepts a JSON brief payload (no multipart, no files). Stores/forwards to NAMI's cadence engine.
> - **`~/kai/scripts/nami-mesh-poller.js`**: add a `transformCreativeBrief(payload)` that produces a JSON-only intent (no asset list), register it in the `TRANSFORMS` and action-mapping tables (`nami-mesh-poller.js:328`, `:392`).
> - **`~/kai/scripts/mesh/mesh-api.js`**: add `acd → nami` route for `creative_brief` to the whitelist (line ~232).
>
> Estimated ~30 LOC across the three files.
>
> **Option 2 — Filesystem inbox for ACD→NAMI briefs.**
> Mirror Framer's `~/.kameha/delegations/nami/<wo_id>.json` pattern: ACD writes briefs to a shared dir, NAMI polls it alongside mesh. Sidesteps the schema problem but creates a parallel channel. Quicker to ship; messier long-term.
>
> **Option 3 — ACD never sends strategy briefs over mesh.**
> Brief lives in shared knowledge (ACD's `project_dag_holiday_calendar_2026_2027` memory or a checked-in brief markdown). NAMI reads the brief from a known path when dispatching per-post WOs. Simplest but couples NAMI to ACD's memory layout.
>
> ### My recommendation
>
> Option 1. Mesh is the canonical inter-agent contract; "ACD hands NAMI a brief NAMI dispatches from" is a legit and recurring use case (every holiday batch, every campaign). Investing in the schema once beats workarounds at every dispatch. The change is small and touches only the bridge layer — no NAMI engine changes.
>
> **Owner:** Kai (mesh + poller code) plus whoever owns the NAMI Render service (Enso/dev). I can ping Kai via mesh if you want this on his next pickup.

---

## CA assessment

**Diagnosis quality — high.** Concrete evidence (3 failed sends with timestamps), specific file:line citations, distinguishes two distinct failure modes correctly (`UNSUPPORTED_ACTION` action-whitelist reject vs. payload-shape validation reject inside a valid action). Cost estimate is reasonable for the surface area described.

**Agree with Option 1 recommendation.** Mesh is the canonical contract; the brief-then-dispatch flow is recurring (every holiday batch, every campaign). One caveat the analysis underplays: it requires a **new endpoint on the NAMI Render service** (separate codebase + separate owner) in addition to the poller + mesh-api changes. So it's a 2-team coordination, not a Kai-only change.

**Owner re-attribution (per Alex):** the "Kai owns mesh + poller code" line was the pre-CA assumption. Reality:
- Mesh + poller code lives in Kai's repo (`~/Desktop/Code/Kai Executive Assistant/scripts/`). So Kai's repo IS the edit target.
- **CA authors the edits** under HB#2 once Kai's `.kameha/owners.json` exists. The Kai bootstrap (queue item #2) is the precondition.
- NAMI Render service is a separate codebase — needs its owner to author the new endpoint (or CA, if NAMI Render also has owners.json).

**Connection to existing queue:** this is the implementation half of session-1 queue item "ACD-Nami fix (W5/W6 scope)" from `docs/acd-nami-action-contract-mismatch-2026-05-17.md`. The companion item — "build action-vocabulary registry so senders can verify recipient acceptance pre-send" — would have caught this exact mismatch at send time instead of after 3 failed attempts. The two items should ship together so the next contract drift is caught proactively, not by post-mortem.

## Next-action when unblocked

1. Kai `.kameha/owners.json` lands (queue item #2).
2. CA reads `nami-mesh-poller.js` end-to-end, confirms the cited line numbers, drafts the `transformCreativeBrief` + TRANSFORMS/action-mapping registration.
3. CA drafts the `acd → nami creative_brief` route addition to `mesh-api.js`.
4. CA opens a draft PR for the NAMI Render service endpoint (or hands a spec to its owner).
5. CA ships the action-vocabulary registry alongside so this class of mismatch is self-detecting from then on.

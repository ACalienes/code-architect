# Comms-fix v1 — wiring patches, DA, Codex prompt

**Author:** Code Architect · 2026-05-26 · **Status:** DRAFT, staged for Alex's apply-approval. No Kai-repo edits made (deploy gate).
**Bundle:** `action-vocabulary.js` (validator) + `action-vocabulary.json` (registry v1) + the wiring below.
**Authority:** validator/registry → Kai `scripts/lib/` + `knowledge/manifests/` (CA helper lane, DA-gated). The call-site patches (`cfo-agent.js`, `mesh-api.js`) are **outside** CA's lane → apply only on Alex's go-ahead. `mesh.db*` untouched.

---

## The two real gaps (corrected from the original spec)

- **Gap A — unknown action on the mesh** (Framer `creative_brief`, nami→framer): a valid-envelope message whose action the receiver doesn't support. Fix = send-side registry check.
- **Gap B — the legacy filesystem-drop channel** (the 2026-05-26 CFO `""` case): a work-order *file* dropped straight into an agent's legacy inbox (`pollLegacyInbox`), bypassing every mint guard, with its failure landing in a dead inbox no live process surfaces.

`createWorkOrder` is NOT a gap (already throws on empty) — and validating there would false-reject legitimate free-text read delegation. The earlier "wire into createWorkOrder" idea is dropped.

---

## Patch 1 — Gap B, receiver-side guard (DRAFT for `scripts/cfo-agent.js`, ~line 798)

Today:
```js
const action = workOrder.action || workOrder.payload?.action || '';
const result = await processMessage(action, payload, { sourceId: woId });
```
Draft (v2 — **fall-through, not `continue`**, per Codex Finding 5):
```js
const action = workOrder.action || workOrder.payload?.action || '';
let result;
const v = require('./lib/action-vocabulary').validateDispatchAction(AGENT_ID, action);
if (!v.ok) {
  // Loud + SURFACED on the live mesh — not just a dead inbox response.
  console.error(`[cfo] REJECT legacy work order ${woId}: ${v.code} (action=${JSON.stringify(action)})`);
  try {
    await meshSend('kai', 'work_order_rejected', 'notification',
      { work_order_id: woId, reason: v.code, action, known: v.known || null });
  } catch (_) { /* fire-and-forget */ }
  result = { status: 'rejected', error: v.code };
} else {
  if (v.warn) console.warn(`[cfo] legacy WO ${woId} action ${v.warn} (known: ${(v.known||[]).join(', ')})`);
  result = await processMessage(action, payload, { sourceId: woId });
}
// NO `continue` — fall through to the EXISTING response-write + archive path (line ~843).
// `result.status:'rejected'` flows through unchanged (`status: result.status || 'complete'`,
// `errors: result.error ? [result.error] : []`), so the rejected file is archived exactly like
// a processed one and is NEVER reprocessed → no rejection-notification storm.
```
Effect: an empty/malformed dropped file is rejected loudly, raises a `work_order_rejected` mesh notification (surfaces on the live mesh, not a dead inbox), **and is archived through the existing path** so it can't loop. Template for every agent's `pollLegacyInbox`.

## Patch 2 — Gap A, send-side check (DRAFT for `scripts/mesh/mesh-api.js`, POST `/messages`, after the existing field checks ~line 810)

**v2 (per Codex Finding 1):** validate the **top-level `body.action`** — that is the field receivers dispatch on first (CFO `cfo-agent.js:481`, NAMI `nami-mesh-poller.js:508`, Framer `daemon.py:117`, Conductor, OA all read top-level `action` first, `payload.action` only as fallback). Validating `payload.action` first risked false-blocking valid traffic. `body.action` is already non-empty-guarded at line 810, so ACTION_EMPTY can't fire here — Patch 2's job is purely **Gap A (unknown action), warn-mode**; the empty case is Patch 1's legacy channel.

```js
// after: if (!body.from || !body.to || !body.message_type || !body.action || body.payload == null) ...
const v = require('../lib/action-vocabulary').validateDispatchAction(body.to, body.action);
// warn-mode: surface ANY coverage signal (unknown action OR unregistered receiver), deliver regardless.
if (v.warn && v.warn !== 'REGISTRY_UNAVAILABLE') {
  console.warn(`[mesh] ${body.from}->${body.to} action "${body.action}": ${v.warn}` +
    (v.known ? ` (known: ${v.known.join(', ')})` : ''));
}
// Strict-flip later (per-agent, post-clean-window): `if (!v.ok) return res.status(400).json({ error: v.code, known: v.known });`
```
Effect: validates the field receivers actually dispatch on. Surfaces both `ACTION_UNRECOGNIZED` (e.g. ACD→Framer unknown — now that Framer is registered) **and** `AGENT_NOT_REGISTERED` (a coverage gap to close), addressing Codex Finding 2. Warn-mode: zero behavior change beyond a surfaced log.

## Patch 3 — durable fix (RECOMMENDATION, not v1 code)
Retire the legacy filesystem-drop channel (`pollLegacyInbox` + direct `~/.kameha/delegations/<agent>/` writes) onto the validated mesh + Shared Layer. That removes Gap B at the root and closes the visibility gap (failures live on the mesh, surfaceable to the dashboard). Sequence under org-plan Phase 1.

---

## DA verdict (CA-internal, mesh-contract mandatory)
**PASS — warn-mode, conditional.**
- **Fail-open + empty-only hard block** → cannot wedge live traffic; the one block (empty action) is unambiguously a bug with zero false positives. ✔
- **Validates the dispatched field** (`payload.action`) — fixes the real fragmentation, not a decoy. ✔
- **Warn-mode = no behavior change** beyond surfaced logs; strict-flip is separately gated and reversible. ✔
- **Receiver-side reject raises a mesh notification** → failures surface live, addressing the visibility gap, not just the dispatch gap. ✔
- **Conditions:** (1) strict-flip per agent only after its resolver is faithfully encoded in the registry + a clean warn window; (2) Codex review before any strict-flip; (3) confirm each agent's `LEGACY_INBOX_DIR` path at apply time.

## Codex review prompt (per standing practice — paste with the bundle open)
> Review `drafts/comms-fix/action-vocabulary.{js,json}` + Patches 1–2 as a mesh-contract change for ~16 agents on one Mac Mini. Adversarial focus: (a) can the validator EVER block legitimate traffic (false positive) given fail-open + empty-only block? (b) is `payload.action || action` the correct dispatched field for receivers other than CFO — find a receiver where it's wrong; (c) does the keyword_map faithfully mirror CFO `resolveCapability` (false OK / false WARN cases); (d) the receiver-side reject path — any way it double-responds or loses the sender's poll resolution; (e) is warn-mode truly behavior-neutral. Verdict: safe-to-apply (warn-mode) vs REVISE.

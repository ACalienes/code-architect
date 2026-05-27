# Implementation Spec — Send-time dispatch-action validation (both channels)

**Author:** Code Architect · **Date:** 2026-05-26 · **Status:** DRAFT — staged for Alex's apply-approval. No live edits yet.
**Green-light:** Alex 2026-05-26 ("build it, both channels").
**Builds on:** `docs/design-action-vocabulary-registry-2026-05-19.md` (Phase A).
**DA:** mandatory (mesh contract) — verdict in §6.
**Authority:** Kai repo `owners.json` — `scripts/lib/**` is CA's `auto_merge_after:ca_internal_da` lane (CA may author, DA-gated). `scripts/mesh/mesh-api.js`, `scripts/cfo-agent.js`, `scripts/routes/**` are **not** in CA's lane → draft-for-approval, applied with Alex go-ahead. `mesh.db*` = hands-off.

---

## 1. Corrected root cause (verified in code today)

The dispatch action — the field a receiver switches on — is **(a)** guarded against *empty* inconsistently across paths, and **(b)** validated against the receiver's *capability set* (the "unknown action" class) **nowhere**. Worse, there are **two parallel comms channels**, only one validated:

| Path | File:line | Reads dispatch action from | Empty guard? | Unknown-action guard? |
|---|---|---|---|---|
| Mesh send | `mesh-api.js:810` | envelope `body.action` | ✅ `!body.action` | ❌ none |
| Work-order mint | `delegation-manager.js:118` | `action` arg → `payload.action` | ✅ `!action` throw | ❌ none |
| delegate route | `ecosystem.js:485` | `body.action` | ✅ | ❌ |
| CFO mesh intake | `cfo-agent.js:481` | `msg.action` (envelope) | n/a (mesh guarantees) | ❌ → `resolveCapability`→null→fail |
| **CFO legacy intake** | `cfo-agent.js:798` | `workOrder.action \|\| workOrder.payload?.action \|\| ''` | ❌ **none** | ❌ |

**The 2026-05-26 CFO `""` failure came through `pollLegacyInbox` (cfo-agent.js:777-805)** — a work-order *file* dropped into CFO's filesystem inbox with no action. This is the "filesystem-drop interim mailman" channel; it bypasses every guard the mesh has. Confirmed: the failure artifact is a `work_order_response` (the shape emitted only by `pollLegacyInbox`).

---

## 2. Fix architecture

A single shared validator, sourced from a capability registry, called at every dispatch-action choke point. Warn-mode first; flip to strict after a clean window.

### 2.1 Registry (`knowledge/manifests/action-vocabulary.json` — Kai repo; draft-for-approval)
Hand-extracted per the design. **v1 populates the agents whose dispatch vocabulary is cleanly readable** (CFO complete below); others are absent → validator **warns, never blocks** (fail-open by design, §2.3).

```json
{
  "schema_version": 1,
  "vocabulary_version": "2026-05-26.1",
  "generated_by": "manual:code-architect",
  "agents": {
    "cfo": {
      "accepts": ["cash_summary","margin_data","invoice_status","financial_snapshot",
        "ar_ap_report","burn_rate","runway","pnl","forecast","tax_estimate",
        "cash_position","expense_anomalies","balance_sheet","mark_estimate_declined",
        "draft_invoice","draft_invoice_created"],
      "code_path": "scripts/cfo-agent.js:267-289 (KEYWORD_MAP + ALL_CAPABILITY_NAMES)",
      "note": "Exact-name match is the only path to write capabilities; read caps also keyword-matchable."
    }
  }
}
```
(Source of truth stays the agent's code; registry is the advertised mirror, drift-audited per design §3.4. Other agents extracted pair-at-a-time per design Q3.)

### 2.2 Shared validator — `scripts/lib/action-vocabulary.js` (CA's lane — CA authors, DA-gated)
```js
// Load + cache the registry; resolve (to, action) → {ok, reason, mode}
// - empty/whitespace action            → { ok:false, code:'ACTION_EMPTY' }
// - agent not in registry              → { ok:true,  warn:'AGENT_NOT_REGISTERED' }  (fail-open)
// - action not in agent.accepts        → { ok:false, code:'ACTION_NOT_ACCEPTED', known:[...] }
// - else                               → { ok:true }
// Never throws on a missing/unreadable registry → returns { ok:true, warn:'REGISTRY_UNAVAILABLE' }.
```

### 2.3 Wiring (3 points)
1. **`delegation-manager.js:118` (CA's lane — apply with DA):** replace the bare `!action` throw with `validateDispatchAction(to, action)`; on `ok:false` throw a structured error naming the receiver's known actions. **Covers every work-order mint** (routes + kai-tools + any programmatic caller) at one chokepoint.
2. **`mesh-api.js` POST `/messages` (draft-for-approval):** after the existing envelope checks (line ~810), if `to` is a registered agent, validate `body.action` against its `accepts`; on miss return `400 {error:'ACTION_NOT_ACCEPTED', known:[...]}`. Warn-log only until strict-flip.
3. **`cfo-agent.js:798` `pollLegacyInbox` (draft-for-approval):** the legacy channel's missing empty-guard — validate the resolved action; on empty/unknown, fail-reply loudly (it already fail-replies, but should never have dispatched `''`). **Strategic:** this path should be *deprecated* onto the mesh (see §4); the guard is the bridge until then.

**Mode:** `warn` (log + send) for the first window, per design Q4; flip to `strict` (block at send) after a clean run. Controlled by one env/flag.

---

## 3. What this fixes
- Empty action → caught at the mint chokepoint and at the legacy intake (the actual CFO bug).
- **Unknown action** (the larger silent class — Framer `creative_brief`, nami→framer, acd→conductor) → caught at send/mint against the receiver's real vocabulary, with the known-actions list returned to the sender. Loud + immediate, not weeks-later + scattered.

## 4. What it does NOT fix (honest scope)
- The **two-channel split itself.** True convergence — retiring `pollLegacyInbox`/filesystem drops onto the validated mesh + Shared Layer — is the durable fix and belongs to the org-plan Phase 1 (Shared Layer) + dashboard/single-source work. This spec hardens both channels in place; it doesn't merge them.
- Receiver-side dispatch behavior (already loud for CFO/Enso/Nami; permissive for PDE/OA per `pattern_silent_failure_class_fleetwide`) — separate hardening.

## 5. Rollout (each gated)
1. CA authors `scripts/lib/action-vocabulary.js` + `action-vocabulary.json` v1 (CFO) — DA-gated, CA's lane.
2. Wire `delegation-manager.js` (CA's lane, DA) — warn-mode.
3. Draft mesh-api + cfo-agent patches → Alex/Kai apply — warn-mode.
4. Observe warnings ~1 week → extract more agents pair-at-a-time → flip to strict.

## 6. DA verdict (CA-internal, mesh-contract mandatory)
**PASS (warn-mode), conditional.** Reasoning:
- **Fail-open is correct:** validator never blocks on a missing/unreadable registry or unregistered agent → cannot wedge live traffic. ✔
- **Chokepoint over whack-a-mole:** wiring at `createWorkOrder` (not each route) covers all mint callers; the registry mirror is drift-audited, not authoritative, so it can't silently diverge into a false block. ✔
- **Blast radius:** warn-mode ships zero behavior change (log only) — strict-flip is the gated, reversible second step. ✔
- **Condition:** strict-flip requires (a) the receiver's vocabulary extracted + reviewed by its owner, and (b) a clean warn window. Do not flip an agent to strict before both. Codex review recommended before strict-flip (mesh contract), per `pattern_solicit_codex_review_on_substantive_work`.

## 7. Needs Alex
- Go-ahead to apply the **CA-lane** parts now (lib validator + delegation-manager wiring + registry v1), warn-mode.
- Approval to hand the **mesh-api + cfo-agent** draft patches to Kai (or apply with explicit go-ahead).

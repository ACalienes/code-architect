# Codex review — Comms-fix v1 (dispatch-action validation)

**How to run:** open the `Code Architect` repo in VS Code with the Codex plugin, ensure `drafts/comms-fix/` is in context, and paste everything below the line.

---

You are reviewing a **mesh-contract change** for a cross-agent system: ~16 autonomous agents on one Mac Mini that talk over a shared mesh-api (`POST /messages`, store-and-poll; agents poll their inbox ~30s) PLUS a legacy filesystem-drop channel (work-order JSON files written into `~/.kameha/delegations/<agent>/`, read by each agent's `pollLegacyInbox`). Review adversarially as a SYSTEM.

**The problem being fixed:** the dispatch action — the field a receiver switches on — is validated inconsistently. The mesh guards the *envelope* `action` but the receiver often dispatches on `payload.action`; the legacy filesystem-drop channel has NO validation at all. On 2026-05-26 a work-order file with `action:""` was dropped into CFO's legacy inbox, dispatched, and failed silently into a filesystem inbox no live process surfaces. Unknown-but-non-empty actions (e.g. ACD→Framer `creative_brief`) also die at receivers with no sender-side signal.

**The change under review (all in `drafts/comms-fix/`):**
- `action-vocabulary.js` — shared validator. Design contract: FAIL-OPEN (missing/unreadable registry or unregistered agent never blocks); the ONLY hard block is empty/whitespace action; "unrecognized but non-empty" is a WARN, not a block, in v1 (because reads are keyword-matchable — e.g. CFO maps "give me cash summary" → cash_summary); strict-block is opt-in per agent/action.
- `action-vocabulary.json` — registry v1; only CFO extracted (from `scripts/cfo-agent.js`), others fail-open to warn.
- `PATCHES-and-DA.md` — Patch 1 (CFO `pollLegacyInbox` receiver-side reject + a `work_order_rejected` mesh notification to surface failures), Patch 2 (mesh-api `POST /messages` validates `payload.action || action`, warn-mode).

**Adversarial focus — find the failure, don't rubber-stamp:**
(a) Can the validator EVER block legitimate traffic (false positive), given fail-open + empty-only block? Try to construct one.
(b) Is `payload.action || action` the correct "dispatched field" for receivers OTHER than CFO? Find a receiver where that's the wrong field (envelope vs payload vs nested work-order action).
(c) Does `keyword_map` + `_resolves()` faithfully mirror CFO `resolveCapability` (`scripts/cfo-agent.js`)? Find false-OK or false-WARN cases (token semantics, multi-word keywords like "balance sheet"/"cash position", substring vs token).
(d) Patch 1's reject path — can it double-respond, lose the sender's poll resolution, or loop?
(e) Is warn-mode genuinely behavior-neutral (no new blocking, no exceptions thrown on bad registry, cache mtime logic sound)?
(f) Any way the registry-load cache (`_cache`/`_cacheMtime`) serves stale or wrong data across agents/paths?

**Verdict:** `SAFE-TO-APPLY (warn-mode)` or `REVISE`, with each finding tagged Must-Fix / Should-Fix / Nit and the file:line.

# B — First real link (CFO→Kai) + comms-fix apply — DRAFT for approval

**Author:** Code Architect · 2026-05-26 · **Status:** DRAFT for Alex's go-ahead. A (production `kameha-mesh.db` + 13 enrolled identities) is **done, live on the Mini**.
**Goal:** the first real cross-repo event flowing 24/7 with no terminal — step 5 of the path-to-operational — plus the reliability layer so it can't silently drop.

---

## Design choice: ride the adapter — no CFO/Kai surgery for the first link

The Shared Layer already ships the two pieces that make this low-touch:
- **`adapter-mesh.js`** — translates an existing mesh envelope → a *signed* Shared Layer fact (signed as `mesh-adapter`, original sender kept in provenance `_via_mesh_from`). Built precisely so a live loop can ride the Shared Layer **without changing the agents.**
- **`runner.js` (`createDrainer`)** — the always-on ~60s per-agent loop that peeks an agent's inbox, handles each fact, acks only on success (at-least-once; poison → dead_letter). This is the persistent presence on the Mini.

So the first link needs **zero edits to CFO or Kai code** — it bridges CFO's existing outbound mesh signal and drains it for Kai.

## Part 1 — Reliability first (apply comms-fix v2, warn-mode)
So a real fact can't die silently (the bug class you kept hitting). All Codex-REVISE findings closed (`codex-review-2026-05-26-response.md`); validator 9/9 green.
1. Deploy `action-vocabulary.js` → Kai `scripts/lib/`; `action-vocabulary.json` → `knowledge/manifests/`; sync a copy to `~/.kameha/` (runtime path the validator reads).
2. Apply **Patch 1** (`cfo-agent.js` `pollLegacyInbox` reject + surface) and **Patch 2** (`mesh-api.js` validate top-level `body.action`, warn-mode).
   - *Authority:* `scripts/lib` is CA's lane (DA-gated); `cfo-agent.js` + `mesh-api.js` are outside it → applied by Kai or by CA **on your explicit go-ahead**.

## Part 2 — The first link: CFO → Kai (status_update), end to end
1. **Subscription (additive to the central db — I can do on go):** `kai ← status_update '*'` and `kai ← decision '*'`. (Chief-of-Staff sees the hum.)
2. **Bridge (deploy):** feed CFO's existing outbound mesh signal (it already does `meshSend('kai','daily_snapshot_ready',…)`, `cfo-agent.js:619`) through `adapter.ingestEnvelope` → a signed `status_update` fact, provenance `cfo`. (Tap = mesh-api hands a copy to the adapter, or a thin bridge proc.)
3. **Drain (deploy):** run `createDrainer` for `kai` as a pm2 process on the Mini, with a handler that **surfaces** the fact (log + a Kai notification). This is Kai's persistent presence on the Shared Layer.
4. **Proof:** trigger/await one real CFO event → re-audit that the **signed fact landed in Kai's Shared-Layer inbox and was drained + surfaced — no terminal, no manual relay.** That's step 5: operational for one link.

## Part 3 — What needs your go-ahead
| Action | Authority | Reversible? |
|---|---|---|
| Set `kai` subscriptions in `kameha-mesh.db` | additive config — CA can do now | yes (delete rows) |
| Apply comms-fix to `scripts/lib` + registry | CA lane (DA-gated) | yes (revert) |
| Apply Patch 1/2 to `cfo-agent.js` + `mesh-api.js` | **outside CA lane → your go-ahead** | yes (revert, warn-mode) |
| Deploy adapter-bridge + `kai` drainer as pm2 procs | **live Mini daemons → your go-ahead** | yes (pm2 delete) |

## After the link proves out → widen (steps 6–8)
- Bring CFO + Enso onto their own drainers (they're already daemons) → the **live trio** chatters for real.
- Give the non-daemon repos a presence: thin **CA inbox-runner**, **build KMG**, **build the DAGDC client-manager** (org-plan builds).
- Retire the legacy filesystem-drop channel (comms-fix Patch 3); dashboard surfaces the live hum.

## Recommendation
Approve **Part 1 + Part 2** as one unit. I'll set the subscription (additive), apply the comms-fix (reliability), and stand up the bridge + Kai drainer — then show you a real CFO event arriving at Kai with nobody at a keyboard.

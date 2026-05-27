# Intake — Offer Architect: Hannah Goldy invoice-trigger build

**Origin:** Offer Architect (offer-architect), relayed by Alex into CA's working tree 2026-05-27.
**Type:** Build request / multi-agent work-in-motion handoff.
**Status on receipt:** In motion across 3 agents (CFO pre-stage, build brief, Framer build). Routing flag open (see §Routing).

---

## What Offer Architect set in motion

Three pieces, verbatim from the Offer Architect message:

### 1. CFO — pre-stage the deposit links now
`draft_invoice` (T2 approval — touches the payment processor).
- Draft three deposit invoice links, **hold them ready, do not send**:
  - **Tier 1 → $6,250** / **Tier 2 → $7,500** / **Tier 3 → $12,250** (50% deposits)
- Write the tier→link mapping to `~/.kameha/clients/hannah-goldy/invoice-links.json` so the trigger can look them up.

### 2. Build brief
`docs/clients/hannah-goldy/invoice-trigger-brief.md` — full spec for the trigger: how it detects accept+tier, resolves the right link, and surfaces it.

### 3. Framer — build the trigger
`develop_skill`, T3-flagged so it reaches Alex before it ships.
- On Kai detecting "accepted + tier N," look up the matching pre-staged link and surface it to Alex for **one-tap send**.

### Two hard rules baked in
- **Never auto-send a payment request.** It prepares and surfaces; Alex approves the send. Money requests to a client must have a human in the loop — irreversible outbound action.
- **Never guess the tier.** Clear yes but ambiguous tier → it prompts Alex, does not default to a tier.

---

## Routing flag (raised by Offer Architect)

> "There's no agent literally named 'code architect' in the mesh. The closest is framer, which handles develop_skill (building automations). I routed it there. If you meant a different builder — a separate Claude Code session, or someone else — tell me and I'll redirect the brief. It's self-contained, so it'll hand off cleanly wherever it goes."

**CA note:** Code Architect *is* the laptop-invoked Claude Code builder (this session). Offer Architect can't see CA in the mesh because CA `receives_from: []` — it's a single-shot CLI, not a mesh-resident agent. The brief is self-contained and hands off cleanly. Open decision for Alex: build via **Framer** (mesh `develop_skill`, already routed) or via **CA** (this session). Either works; they shouldn't both build it.

## Pre-check observations (not yet acted on)
- `docs/clients/hannah-goldy/` does not exist in CA's tree — the brief is referenced but not yet present here.
- `~/.kameha/clients/hannah-goldy/invoice-links.json` is the CFO-owned mapping target; CA does not own it.

## Awaiting Alex go-ahead
- Confirm builder (Framer vs CA) for piece #3.
- If CA: that's a T2/T3 `develop_skill`-class build — DA-gate applies (mesh contract + surfacing logic). Plan before code.

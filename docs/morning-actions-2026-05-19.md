# Morning Actions — paste-ready, 2026-05-19

The 8 commands below in priority order. The first one is time-pressured (TTL 12:55 UTC ≈ 7:55 AM ET).

---

## 1. T2 probe — APPROVE or REJECT before 12:55 UTC

Pure probe (`probe: true` payload). Nami's whitelist already includes `social_deliverable_ready`. Recommendation: APPROVE.

**First — confirm the endpoint shape** (exact path depends on Kai's mesh-api auth scheme; A4 didn't probe POST endpoints to avoid mutating):

```bash
# Inspect the approve route in mesh-api source
grep -n "approve\|tier.*2" "/Users/alex/Desktop/Code/Kai Executive Assistant/scripts/mesh/mesh-api.js" | head -20
```

**Then — approve** (replace endpoint if grep shows a different path):

```bash
curl -X POST "http://100.64.114.13:3341/messages/acd-nami-probe-1779108906/approve" \
  -H "Content-Type: application/json" \
  -d '{"approver": "alex", "approved_at": "'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'"}' \
  -w "\nHTTP %{http_code}\n"
```

**Or — let it TTL** (no action; document the no-signal outcome in next-session notes).

**Verify the result either way:**

```bash
curl -sS "http://100.64.114.13:3341/messages/acd-nami-probe-1779108906" | python3 -m json.tool
```

---

## 2. Chronicle — unlock git + commit 27 entries + restart daemon

Three sub-steps; all on the laptop except step 2c.

### 2a. Remove the dead-PID git lock

```bash
cd "/Users/alex/Desktop/Code/Chronicle"
ls -la .git/refs/heads/main.lock    # confirm it exists with 2026-03-28 mtime
rm .git/refs/heads/main.lock
git fsck --no-progress              # verify repo integrity
git status --short | head -40       # see the 27 uncommitted /log entries
```

### 2b. Commit the 27 entries (suggest splitting into 3-5 logical commits)

```bash
# Quick triage — group by directory or feature
git status --short | awk '{print $2}' | xargs -I {} dirname {} | sort -u | head
# Then commit in logical chunks; example pattern:
# git add app/log/components/* && git commit -m "feat(log): UI components"
# git add app/api/log/* && git commit -m "feat(log): API routes"
# git add app/log/page.tsx && git commit -m "feat(log): main page wiring"
```

### 2c. Restart Chronicle daemon on Mini

```bash
# From laptop, via Tailscale SSH (replace user as needed)
ssh kai@10.0.0.79 "pm2 restart chronicle && pm2 logs chronicle --lines 40 --nostream"
# Then verify it's heartbeating again
curl -sS "http://100.64.114.13:3341/agents" | python3 -c "import json, sys; print([a for a in json.load(sys.stdin)['agents'] if a['agent_id']=='chronicle'][0])"
```

---

## 3. Action-vocabulary registry — read + decide Phase A

```bash
open "/Users/alex/Desktop/Code/Code Architect/docs/design-action-vocabulary-registry-2026-05-19.md"
# 5 open questions in §5 — answer them and tell CA in next session.
```

---

## 4. Owners.json gitignore-policy proposal — approve y/n

```bash
open "/Users/alex/Desktop/Code/Code Architect/docs/proposal-owners-policy-gitignore-2026-05-19.md"
# 1-page proposal. y unblocks fleet-wide .gitignore hygiene. n keeps default-deny.
```

---

## 5. Two missing mesh routes — add or redesign

Three options surfaced in audit doc §"P0-1 refinement":
- (a) Add reverse routes (`nami → framer`, `acd → conductor`) to mesh-api routes table
- (b) Auto-route `message_type: "response"` by `correlation_id` regardless of routes table
- (c) Stop senders from sending these — use different completion-notification

```bash
# Inspect the routes seed file to pick (a):
grep -rn "routes\|route_blocked\|approved_count" "/Users/alex/Desktop/Code/Kai Executive Assistant/scripts/mesh/mesh-api.js" | head -30
# Or read the audit doc P0-1 section for full analysis
open "/Users/alex/Desktop/Code/Code Architect/docs/audit-overnight-2026-05-19.md"
```

---

## 6. PDE silent build_update — bootstrap owners.json + author handler

Two-step. Bootstrap is mechanical (owners-bootstrap exemption); handler is design.

```bash
# Step 1: in next CA session, ask CA to draft Pitch Deck Engine owners.json
# Step 2: in same session, author the build_update handler in
#         /Users/alex/Desktop/Code/Kameha Pitch Deck Engine/scripts/pde-daemon.js
# Reference the build_addendum handler (line 684+) for the pattern.
```

---

## 7. KMG owners.json bootstrap

Last of the 3 genuinely-missing repos (Chronicle, KMG, PDE). KMG W2 daemon hasn't shipped yet on Mini per CA manifest, so the bootstrap is just policy plumbing for when it does.

```bash
# Ask CA in next session: "draft KMG owners.json — mirror Kai pattern."
```

---

## 8. Memorial Day manual-relay confirmation (still pending from session 2)

```bash
open "/Users/alex/Desktop/Code/Code Architect/docs/intake-framer-daemon-rca-verification-2026-05-18.md"
# Read the verify-framer-rca finding.
# Decide: intentional human-in-loop, or accidental gap?
# Answer drives priority on Framer creative_brief fuller automation vs leaving as-is.
```

---

## Optional — verify CA's overnight work landed cleanly

```bash
cd "/Users/alex/Desktop/Code/Code Architect"
git log --oneline 0d9adcf..b9d40f8  # 8 commits this overnight session
git fetch && git status              # confirm clean working tree, in sync with origin
```

---

**If anything in here is wrong or unclear, re-invoke CA and point at the section.** Every action above traces back to evidence in `docs/audit-overnight-2026-05-19.md` and the 7 `intake-audit-A*-2026-05-19.md` files.

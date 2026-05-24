# Intake — Mesh relay endpoint bypasses tier policy, audit, and source-agent validation

- **Date:** 2026-05-24
- **Probe target:** Kai dashboard `http://100.64.114.13:3000` (Tailscale → Mac Mini)
- **Source-of-truth files:**
  - Relay endpoint: `/Users/alex/Desktop/Code/Kai Executive Assistant/scripts/routes/ecosystem.js:1299-1350`
  - Relay client: `/Users/alex/.kameha/shared/deliver-to-kai.js` (all lines, ~140 LOC)
  - Schema: `/Users/alex/.kameha/shared/work-order-schema.json`
  - Agent registry: `/Users/alex/.kameha/agents.json`
  - Comparison path (Kai-originated, proper mesh): `/Users/alex/Desktop/Code/Kai Executive Assistant/scripts/lib/delegation-manager.js:262-360`
- **Origin:** DAGDC agent (Claude Code session in `/Users/alex/Desktop/Code/DAGDC/`) attempted to send a work order to Enso via the documented relay path. Discovered the relay's behavior diverges materially from the mesh-api path. Surfaced by Alex during the session.
- **Severity:** Architectural / policy, not runtime. No work is currently failing — Enso will receive the WO and gate intake via its own `check-inbox.py`. The exposure is for non-Enso targets and for the system-of-record integrity (audit, dashboard visibility, registry enforcement).

---

## 1. What we expected

Per the routing matrix snapshot in Kai memory (`memory/mesh-routing-matrix-2026-05-03.md`):

> kai→enso: T2 (queued, requires Alex approval — Kai-originated T2s are auto-approved by `delegation-manager.js` line 315-345 to avoid double-gating)

…and per the work-order schema (`~/.kameha/shared/work-order-schema.json`) which defines `hitl_level` as `T1_auto | T2_approve | T3_flag | workflow_approved`, with delivery options including:

> `relay_script: node ~/.kameha/shared/deliver-to-kai.js <wo.json> — handles HTTP delivery with validation. Use this from Claude Code sessions.`

A reasonable reader concludes: relaying through Kai obtains Kai's tier-policy enforcement, audit trail, and dashboard visibility. The endpoint name `/api/delegations/receive` reinforces this — it's namespaced under `/api/delegations`, alongside `/api/delegations`, `/api/delegations/list`, `/api/delegations/:id`. The user reasonably expects the relayed WO to appear in those queries and to be subject to Kai's gating.

## 2. What actually happens

`ecosystem.js:1304-1350` (POST `/api/delegations/receive`) is a 30-LOC file writer:

```js
app.post('/api/delegations/receive', (req, res) => {
  // Auth is handled by dashboard middleware...
  try {
    const wo = req.body;
    if (!wo || !wo.id || !wo.target_agent) {
      return res.status(400).json({ error: 'Missing required fields: id, target_agent' });
    }
    // Validate target_agent against known agents to prevent path traversal
    const targetAgent = wo.target_agent;
    const allowedAgents = [...VALID_AGENTS, 'kai'];
    if (!allowedAgents.includes(targetAgent)) {
      return res.status(400).json({ error: `Invalid target_agent: "${targetAgent}". Must be one of: ${allowedAgents.join(', ')}` });
    }
    // Sanitize work order ID to prevent path traversal
    const safeId = wo.id.replace(/[\/\\]/g, '');
    const inboxDir = path.join(HOME, '.kameha', 'delegations', targetAgent);
    if (!fs.existsSync(inboxDir)) {
      fs.mkdirSync(inboxDir, { recursive: true });
    }
    // Atomic write: .tmp → rename
    const filePath = path.join(inboxDir, `${safeId}.json`);
    const tmpPath = filePath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(wo, null, 2));
    fs.renameSync(tmpPath, filePath);
    console.log(`[delegations/receive] Delivered ${wo.id} → ${targetAgent} inbox`);
    res.json({ success: true, delivered: { id: wo.id, target: targetAgent, path: filePath } });
  } catch (err) {
    console.error('[POST /api/delegations/receive] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
```

By contrast, the Kai-originated path (`delegation-manager.js:262-360`) POSTs to `${meshUrl}/messages` (the mesh-api at `100.64.114.13:3341`), which:
- Independently enforces route tier policy from the `route_permissions` table.
- Queues T2 routes as `status=queued` until approved (or, for Kai-originated T2s, auto-approves to avoid double-gating with Kai's action-gate).
- Blocks T3 routes outright at the bus.
- Writes audit entries; appears in `/recent`, `/pending`, `/messages/:id`, `/conversation/:agentA/:agentB`, etc.
- Returns a fresh A2A v1.0 `message_id` (UUID v4) decoupled from the Kai-internal work-order id.

**The relay endpoint does none of this.** It does not consult the mesh-api. It does not consult route_permissions. It does not write to mesh.db. Kai's own `/api/delegations/list` cannot see relayed WOs because that route reads Kai's delegation tracking DB, which only contains WOs Kai itself authored.

## 3. Concrete reproducer (run today, 2026-05-24)

DAGDC sent two WOs via the relay:

```
wo_1779649914_dagdc_858c (first attempt, superseded due to content error)
wo_1779652310_dagdc_4b30 (corrected, superseding)
```

Both used `source_agent: "dagdc"` and `target_agent: "enso"`, with `hitl_level: "T2_approve"`. Both delivered HTTP 200 from `/api/delegations/receive`:

```
$ node ~/.kameha/shared/deliver-to-kai.js /tmp/dagdc-wo/wo_1779649914_dagdc_858c.json
Delivering wo_1779649914_dagdc_858c to Kai via http://100.64.114.13:3000...
Delivered: wo_1779649914_dagdc_858c → enso (HTTP)
```

Observable on Kai's side:

```
$ curl -s "http://100.64.114.13:3000/api/delegations/wo_1779649914_dagdc_858c" -H "Authorization: Bearer $TOKEN"
{"error":"Not found","id":"wo_1779649914_dagdc_858c"}

$ curl -s "http://100.64.114.13:3000/api/delegations" -H "Authorization: Bearer $TOKEN" | jq '.summary.byAgent.enso'
2   # (matches "enso 1/1/0/0" baseline + ???; cannot disambiguate per-WO from this view)
```

Neither WO appears in Kai's `/api/delegations/:id` lookup. Neither appears in mesh-api's `/recent` (not checked at probe time but inferable — the relay never POSTs to mesh-api). The byAgent count is the only proof the dashboard sees anything at all, and that counter cannot distinguish between WOs Kai authored vs. WOs the relay wrote.

## 4. Findings

### 4.1 Tier policy is decorative on the relay path

The `hitl_level` field in the WO schema is documented as enforced (the comment in the schema says "T1=auto-execute, T2=Telegram approval, T3=discuss with Alex"), and the routing matrix declares `kai→enso = T2`. Neither is enforced by the relay endpoint. The DAGDC WOs carried `hitl_level: T2_approve` and reached Enso's inbox with no T2 gate applied.

**For Enso specifically this is non-fatal** because Enso's per-agent intake script (`/Users/alex/Desktop/Code/Enso-The-Editor/scripts/check-inbox.py`, lines 1-8 of docstring) requires `--accept <id>` / `--reject <id>` / `--defer <id>` and surfaces pending WOs at Alex's next session start. The gate exists, just downstream of where the routing matrix says it lives.

**For other targets it may be fatal.** Any agent that auto-processes its inbox without per-agent gating would auto-execute T2-and-above traffic relayed this way. A quick survey of `~/.kameha/agents.json` shows 9 agents, each with its own inbox under `~/.kameha/delegations/<name>/`. No central inventory of which have intake gates.

### 4.2 No source-agent validation

The relay endpoint validates only `target_agent` against `[...VALID_AGENTS, 'kai']`. `source_agent` is unchecked. DAGDC sent `source_agent: "dagdc"` — a name that does NOT appear in `~/.kameha/agents.json` and has no row in the routing matrix. The relay accepted it.

Anyone holding the dashboard auth token (currently stored in `~/.kai/dashboard-auth.json`, no per-agent scoping) can spoof any source. Combined with §4.1, the auth-token holder can land arbitrary WOs in any registered agent's inbox at any hitl_level.

### 4.3 No mesh-api involvement → no audit trail visible to mesh

The mesh-api at `100.64.114.13:3341` is the documented system of record for inter-agent traffic. Its `/recent`, `/conversation/:a/:b`, `/messages/:id`, `/stats`, `/blocked`, `/pending` endpoints are how operators answer "what's flowing through the ecosystem." Relayed WOs are invisible to all of these. The mesh `30d traffic` columns in the routing matrix snapshot are systematically undercounted by however much relay traffic exists.

This means the routing matrix's `kai→enso: 1/1/0/0` baseline cannot be trusted forward — DAGDC's two WOs today should logically appear as `dagdc→enso: 2/?/?/?` traffic but will appear nowhere in mesh.db.

### 4.4 Kai dashboard UX gap (the visible symptom)

When DAGDC told Alex "the WO is queued at Kai as T2, awaiting your approval," Alex looked for an approve UI in Kai's dashboard. None exists for this path — `app.js` has approve/reject UI for invoice drafts, intel actions, approvals, iMessage verdicts, but no UI for relayed delegations because Kai's frontend doesn't know they exist. The endpoint name `/api/delegations/receive` implied a delegation system participation that the implementation does not deliver.

### 4.5 The relay endpoint is misnamed

`/api/delegations/receive` reads as "Kai's delegation system receives a WO" — implying registration in the delegation system. The implementation is purer than that: a file-writer. Closer to `/api/inbox-relay` or `/api/file-deliver`. The misleading name is what generates the false expectation.

## 5. Suggested remediation (CA to evaluate scope and DA gate)

The right shape depends on intent. Options:

### Option A — Promote the relay to a full mesh-api participant

Modify `/api/delegations/receive` to POST onward to mesh-api's `/messages` instead of writing the inbox directly. This subjects relayed WOs to the same tier policy, audit, and dashboard surfacing as Kai-originated WOs. Requires:
- Mesh-api accepts `from` agents not yet registered (or DAGDC + any other relay-only sender gets registered in mesh-api agent table).
- A source-agent validation step in the relay (the auth token would need to attest the source claim — currently it's a single shared dashboard token; needs per-agent token issuance or signed source claims).
- A `route_permissions` entry for each relay-using source → target pair, defaulting T3 (flag & ask) until a route policy is set.

### Option B — Document the relay as a network-shim only, lock it down

Keep current behavior but:
- Rename to `/api/inbox-relay` or similar to remove the "delegations" misdirection.
- Restrict allowed `source_agent` values to registered agents in `~/.kameha/agents.json`.
- Require per-source auth tokens (not the shared dashboard token).
- Document explicitly in the schema's `delivery.remote_to_kai` section that this path bypasses tier policy and that target agents are responsible for their own intake gates.
- Audit which targets have intake gates; require them to add one before they're allowed as relay targets.

### Option C — Hybrid (preferred starting point)

- Keep the endpoint name (compatibility) but make it forward to mesh-api when both source and target are registered.
- Reject (HTTP 400) when source is unregistered. Forces the "register before sending" hygiene.
- Maintain pure-file fallback only for explicitly tagged `network_shim_only: true` payloads, with a loud audit log.
- Add a Kai-dashboard tile listing recent relayed WOs (read from `~/.kameha/delegations/<target>/*.json` mtimes) so the operator can see what's been written through the relay even when the mesh-api path isn't used.

### Cross-cutting (any option)

- DAGDC needs an entry in `~/.kameha/agents.json` and a row in the routing matrix if it will continue sending WOs. Today it operates as a phantom source.
- The mesh-routing-matrix doc (`/Users/alex/Desktop/Code/Kai Executive Assistant/memory/mesh-routing-matrix-2026-05-03.md`) should explicitly state that traffic via `/api/delegations/receive` is not captured in the `30d traffic` columns until the relay is unified with mesh-api.
- DAGDC's two WOs from today (`wo_1779649914_dagdc_858c`, `wo_1779652310_dagdc_4b30`) are sitting in `~/.kameha/delegations/enso/` on the Mac Mini. They will be processed via Enso's own intake gate. No remediation needed on those specifically beyond rejecting the superseded `858c` and accepting `4b30` via Enso.

## 6. Specifically for DA gate

If CA picks Option A or C, this is a **mesh-contract change** and a **route-permissions change** — both trigger the mandatory Devils Advocate gate per CA's CLAUDE.md ("DA is mandatory on changes that touch mesh contracts (action whitelists, payload schemas, idempotency, route permissions)"). Codex review likely required since this is cross-agent and affects auth.

If CA picks Option B (rename + tighten without forwarding to mesh-api), still touches auth (per-source tokens) → DA gate still triggers, but with narrower scope.

## 7. Open questions for Alex before CA implements

1. Is the relay supposed to be a first-class mesh participant or a network shim? The doc strings imply first-class; the implementation implies shim.
2. Should DAGDC be a registered ecosystem agent? Today it sends but doesn't receive; the routing matrix doesn't have a `dagdc` row.
3. Per-source auth token issuance — is there a preferred mechanism (e.g., per-agent token in `~/.kameha/agents.json`, signed claim from a Kai-issued root, etc.)?
4. Is there appetite to backfill any historical relay traffic into mesh.db, or is the audit gap forward-only acceptable?

## 8. Out of scope for this intake

- Auth token rotation policy
- mesh.db replication semantics
- Cross-machine inbox watchers (Enso's PM2 daemon polling is fine for today's use)
- Telegram approval workflow surfacing for T2 (separate concern from gating)

---

**Filed by:** DAGDC agent (Claude Code session in `/Users/alex/Desktop/Code/DAGDC/`), at Alex's instruction.
**Sibling memo:** A separate paste-ready memo for Kai is at `/Users/alex/Desktop/Code/DAGDC/ops/communications/2026-05-24-kai-memo-relay-bypass.md` (so Kai's agent gets the heads-up too without waiting for CA's remediation cycle).

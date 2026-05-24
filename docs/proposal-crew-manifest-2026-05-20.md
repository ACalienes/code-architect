# Proposal — `crew_manifest`: first concrete typed deliverable in the action-vocabulary registry

**Author:** Code Architect (session 4, 2026-05-20)
**Status:** DRAFT — proposal only, no code changes. Awaits Alex review + answers to inline questions before implementation gate.
**Authority model:** W3 draft-and-stage. Each implementation phase requires explicit go-ahead.
**Triggering incident:** Baptist 5/21 shoot — Sebas AM-only constraint logged at scoping; PM 2nd-camera slot never converted into action. **Alex caught the unstaffed slot at T-2 days.** System tolerated a passive "logged but unactioned" state from confirmation through almost shoot day.

**Source intakes:**
- `docs/intake-kai-crew-manifest-design-2026-05-19.md` (Kai's framing + 8-section ask)
- `docs/design-action-vocabulary-registry-2026-05-19.md` (parent design; this is the first concrete instance)
- `docs/intake-framer-acd-nami-rca-2026-05-18.md` (precedent: action-contract drift from session 2)

---

## Plain-English summary (read this part if nothing else)

Today, ACD writes a "production strategy" — a free-text document that *mentions* who should shoot what, but doesn't track it. Kai has no way to ask "is the Baptist shoot fully staffed?" without reading prose. So the Baptist 2nd-camera slot sat unfilled, visible to no automation, until you noticed.

The fix is a small new structured record called a `crew_manifest`: a list of role-slots per shoot, each marked confirmed or unfilled. ACD produces it as a sibling to the strategy doc. Conductor (the SQLite DB inside Kai) stores it. Kai's morning briefing reads it and warns you 7 days out, 3 days out, and 24 hours out if any slot is unfilled.

The harder design question isn't the manifest itself — it's that **this is the first time the mesh has a typed deliverable contract that crosses three repos.** How that contract is published, versioned, and validated sets the pattern for every typed deliverable that follows. So the 5 open questions from the parent action-vocab design get answered here against a real case rather than in the abstract.

**What I'm asking you to decide:** 8 questions inline (sections 1-8) + 5 strawman answers in section 9 (action-vocab questions). Most are y/n or pick-an-option. Read top to bottom; everything is ordered by how much it costs to change later.

---

## 1. `crew_manifest` schema

### 1.1 Data shape (one manifest per shoot date)

```json
{
  "schema_version": 1,
  "manifest_version": "2026-05-20.1",
  "manifest_id": "cm_<uuid>",
  "project_id": "baptist_health_dental_2026q2",
  "shoot_date": "2026-05-21",
  "shoot_window": {
    "start_iso": "2026-05-21T08:00:00-04:00",
    "end_iso":   "2026-05-21T17:00:00-04:00",
    "timezone":  "America/New_York"
  },
  "location": "Dr. van der Ven office, FL",
  "deliverable_context": "Maria Diaz patient testimonial",
  "roles": [
    {
      "role_id": "cm_role_001",
      "role": "director_of_photography",
      "required_window": { "start_iso": "...", "end_iso": "..." },
      "status": "confirmed",
      "confirmed_by": "Sebas Calienes",
      "confirmed_at": "2026-05-15T14:22:00-04:00",
      "notes": "AM-only — hard out at 12:30"
    },
    {
      "role_id": "cm_role_002",
      "role": "second_camera",
      "required_window": { "start_iso": "2026-05-21T12:30:00-04:00", "end_iso": "2026-05-21T17:00:00-04:00" },
      "status": "unfilled",
      "confirmed_by": null,
      "confirmed_at": null,
      "notes": "PM coverage after Sebas hard out"
    }
  ],
  "validation_warnings": [],
  "generated_by": "acd",
  "generated_at": "2026-05-19T22:00:00-04:00"
}
```

### 1.2 Role status enum

`required` → `tentative` → `confirmed` → `cancelled` (terminal)
`unfilled` (synonym for `required` with no candidate)
`backfill_needed` (was confirmed, fell through, urgent)

### 1.3 Storage decision — JSON blob vs normalized table

**Recommendation: normalized table `crew_assignments`.** One row per role per shoot.

**Why not JSON blob on `retainer_cycles`** (which is how `shoot_dates` is stored today): the entire point of this structure is queryability — "what's unfilled in the next 7 days across all projects" is a `WHERE status='unfilled' AND shoot_date BETWEEN ...` query. A blob requires walking every row of every project's JSON. T-7 alerts run daily; this query runs daily. JSON-blob storage forces a JSON walk every morning at 5:30 AM.

**Why not a separate `shoots` table first** (cleaner long-term — shoots become first-class, crew references shoot_id): conductor today has no shoots table; shoots are JSON arrays inside `retainer_cycles.shoot_dates`. Extracting that is a substantial migration affecting retainer_cycle reads across the briefing pipeline. **Per Karpathy #2 (simplicity first), key `crew_assignments` on the tuple `(project_id, shoot_date)` for v1; defer shoots-table extraction to Phase 2 when other typed records (weather_report, location_scout, talent_release per ACD's deliverable taxonomy) demand it.**

**Tradeoff cost of the tuple-key choice:** shoot_date string is the join key. If a shoot is rescheduled (date change), every crew_assignment row for the old date orphans. Migration script handles it: `UPDATE crew_assignments SET shoot_date = NEW WHERE project_id=X AND shoot_date=OLD`. Document the reschedule procedure.

**❓ Q1: Approve normalized `crew_assignments` table keyed on `(project_id, shoot_date)`, defer shoots-table extraction to Phase 2?** (Recommended yes — minimum viable change, query-friendly.)

---

## 2. ACD output schema delta

### 2.1 What changes in ACD

ACD's `_handle_production_strategy()` at `scripts/daemon.py:464-482` currently returns the production_strategy dict (`scripts/lib/production_strategy.py:213-251`). Delta:

- **Add a new library function** `scripts/lib/crew_manifest.py` that composes a `crew_manifest` dict from the same payload that drives `production_strategy`. Same Claude Sonnet 4.5 path; same payload context (which already contains crew references in prose); structured-output extraction.
- **Extend `_handle_production_strategy()`** to call `crew_manifest.run(payload)` after `production_strategy.run(payload)` returns. Emit BOTH:
  - Existing: `production_strategy_result` reply to requester (Kai). Unchanged.
  - New: `crew_manifest` mesh message to **conductor** (not Kai) — see §3 for routing rationale.

### 2.2 Files touched in ACD

| Path | Change | owners.json policy |
|------|--------|---------------------|
| `scripts/lib/crew_manifest.py` (NEW) | Compose manifest from payload | `auto_merge_after:ca_internal_da`, bypass eligible |
| `scripts/lib/production_strategy.py` | No edit (intentional — separation of concerns) | DA-gated, but no edit needed |
| `scripts/daemon.py` | 1 new branch in `_handle_production_strategy()` for the sibling emission | **`human_review_required` — Alex hands** |
| `scripts/lib/mesh_client.py` | No edit (envelope structure already supports new action) | human_review_required, but no edit needed |
| `tests/test_crew_manifest.py` (NEW) | Unit tests for crew_manifest composer | DA-gated, bypass eligible |
| `docs/examples/crew-manifest-baptist.json` (NEW) | Reference example for consumers | DA-gated, bypass eligible |

**Most of the delta is CA-writable.** Only the daemon.py edit needs your hands — and it's a 4-5 line change (call new library, send new mesh message).

### 2.3 Failure mode if crew_manifest composer can't extract

If the payload context has no parseable crew info (e.g., new client where roles aren't named yet), `crew_manifest.run()` returns:

```json
{ "status": "insufficient_context",
  "manifest_id": null,
  "validation_warnings": ["No crew references found in payload context"] }
```

ACD then does NOT emit a `crew_manifest` mesh message. Production_strategy reply still goes out. **The absence of a manifest for a shoot becomes the T-7 violation** (see §5). Don't fail the whole production_strategy because crew couldn't be extracted — that would block strategy emission for under-specified projects.

### 2.4 Mesh-send-failure mode — silent-loss risk (added after Codex review)

ACD's `mesh_client.py` `send_message()` currently logs errors and returns `None` on send failure (verified at `/Users/alex/Desktop/Code/ACD/scripts/lib/mesh_client.py:180-183`). There is no outbox / retry queue. ACD's CLAUDE.md mentions one (line 107) but it isn't implemented.

This means: if mesh-api is briefly down (restart, network blip) when ACD tries to emit a crew_manifest, **the manifest is silently lost**. Production_strategy reply may still succeed via the synchronous HTTP path (port 3342), but conductor never receives the manifest. The T-7 audit later flags the shoot as "no manifest" — which is correct as a backstop, but means we re-discovered the absence days later instead of catching it on the failed send.

Two paths to address:

1. **(short-term, ships with this proposal)** ACD's daemon writes a fallback JSON copy of the manifest to `~/.kameha/shared/pending-manifests/<project_id>-<shoot_date>.json` if the mesh send fails. A cron in conductor (5-min cadence) drains the dir into the DB on next attempt. **Cheap, additive, no daemon-state changes.**
2. **(longer-term, separate proposal)** Implement the outbox pattern in `mesh_client.py` as promised by ACD's CLAUDE.md. Out of scope here — it's a cross-cutting infrastructure change touching every agent that uses mesh_client. Track it.

This proposal goes with (1).

**❓ Q2: Approve "insufficient_context" graceful-degrade — production_strategy still emits, manifest skipped, T-7 audit catches it later?** (Recommended yes — blocking strategy on crew is the wrong tradeoff.)

---

## 3. Kai consumer contract (mesh route + briefing)

### 3.1 New mesh route

**`acd → conductor`**, tier 1 (auto-deliver). Adding this route allows ACD to send `crew_manifest` to conductor.

**⚠️ Important scoping caveat (added after Codex review):** mesh-api's `route_permissions` table is keyed only by `(from_agent, to_agent)` — there is **no action column** (verified at `scripts/mesh/mesh-api.js:117-126`). Granting tier 1 for `acd → conductor` authorizes **every** ACD action to conductor, not just `crew_manifest`. Today this means future ACD-to-conductor actions land tier 1 by default until a more specific route policy is added.

Three options for handling this:

1. **(recommended for v1)** Accept route-wide tier 1. ACD has no other actions targeting conductor today, and conductor's CAPABILITY_HANDLERS will simply reject unknown actions. Low-risk in practice. Re-evaluate when ACD adds a second action targeting conductor.
2. **Receiver-side gating.** Conductor's handler whitelist is the effective enforcement — only `crew_manifest` reaches a handler; everything else falls through to error response. This is the current behavior.
3. **Defer until action-scoped routes ship.** A future mesh-api migration could add an optional `action` column to `route_permissions`. Out of scope for this proposal but worth tracking. Note: this is a real action-vocab-registry design problem — exactly the silent-failure class the parent design doc is meant to address.

This proposal goes with option (1) + (2) combined: route-wide tier 1 with receiver-side handler whitelist as the actual gate.

Why conductor, not Kai? Three reasons:

1. **Storage owner ≠ briefing owner.** Conductor owns the DB. Kai's briefing reads from conductor DB already (lines 68+ of morning-briefing.js query active projects). Sending the manifest to Kai would mean Kai has to forward to conductor — two hops where one suffices.
2. **Existing pattern.** ACD already writes `~/.kameha/shared/acd-production-briefing.json` for Kai to ingest. Moving to mesh+DB is a strict upgrade of that file-drop pattern. Conductor is the natural destination for structured project state.
3. **Briefing consumes from DB.** The T-7/T-3/T-24h queries run against `crew_assignments` directly during briefing composition. Kai never needs to receive the manifest message — it queries the DB.

### 3.2 Conductor's new capability handler

Add to `CAPABILITY_HANDLERS` at `scripts/conductor-agent.js:286-294`:

```javascript
crew_manifest: handleCrewManifest,
```

`handleCrewManifest(payload)` validates the manifest, upserts rows in `crew_assignments` (one row per role), returns ack.

**⚠️ Dispatch-order prerequisite (corrected after Codex review):** The current conductor flow calls `processActionableWorkOrder()` at line 398 BEFORE `CAPABILITY_HANDLERS[action]` is checked at line 423. If `processActionableWorkOrder` returns non-null for an unrecognized action (which it likely does — it returns a `needs_manual_action` response object for non-fix actions), the handler at line 423 is bypassed entirely. **A bare `CAPABILITY_HANDLERS['crew_manifest'] = handleCrewManifest` addition is insufficient.**

The fix is one of two paths:
1. **(preferred)** Insert an exact `CAPABILITY_HANDLERS[action]` check BEFORE the call to `processActionableWorkOrder` in `processMessage()` — so registered handlers always win over the work-order classifier.
2. **(alternative)** Modify `processActionableWorkOrder` to return null for actions present in `CAPABILITY_HANDLERS`, falling through to the handler.

This proposal requires path (1) as a hard prerequisite. The dispatch-order change is a single-file edit in `scripts/conductor-agent.js` and lands in the same PR as the new handler.

**⚠️ Fuzzy-fallback risk (same NEXT-SESSION #10 finding):** Conductor's substring-match dispatcher (`scripts/conductor-agent.js:422-440`) would match `crew_manifest_v2` → `crew_manifest`. **This proposal also requires the fuzzy-fallback fix to land in the same change.** Otherwise a versioned message in the future silently routes to v1.

### 3.3 Briefing pipeline — T-7 / T-3 / T-24h alert ladder

Single SQL query, run inside `morning-briefing.js`:

```sql
SELECT project_id, shoot_date, role, status, notes,
       julianday(shoot_date) - julianday('now') AS days_to_shoot
FROM crew_assignments
WHERE status IN ('unfilled', 'tentative', 'backfill_needed')
  AND julianday(shoot_date) - julianday('now') BETWEEN 0 AND 7
ORDER BY days_to_shoot, project_id;
```

Render bucket logic in the briefing composer:

- `days_to_shoot >= 5`: **Info** — "3 unfilled roles for Baptist 5/27 shoot — 7 days out"
- `days_to_shoot 2-4`: **Warning** — "URGENT: Baptist 5/22 still has 1 unfilled DP slot — 3 days out"
- `days_to_shoot 0-1`: **Red** — "T-24h: Baptist 5/21 PM 2nd-camera UNFILLED. Sebas has hard out 12:30."

### 3.4 Telegram surface

If any role is `days_to_shoot <= 3` and `status='unfilled'`, the briefing additionally fires a Telegram push outside the morning email window. Reuses existing Telegram dispatch in Kai's bot.

### 3.5 Files touched in Kai

| Path | Change | owners.json policy |
|------|--------|---------------------|
| `scripts/conductor-agent.js` | Add `crew_manifest` handler to CAPABILITY_HANDLERS | **`human_review_required`** |
| `scripts/lib/conductor-db.js` | Add `CREATE TABLE crew_assignments` + upsert helpers | **`human_review_required`** |
| `scripts/lib/morning-briefing.js` | Add crew-unfilled query + render bucket | **`human_review_required`** |
| `scripts/mesh/mesh-api.js` | Add `acd → conductor` route entry to `seedRoutePermissions()` | **`human_review_required`** |
| `knowledge/manifests/crew-manifest.schema.json` (NEW) | JSON schema source of truth | DA-gated (depends on subdir policy — verify before merge) |
| `tests/conductor/crew_manifest.test.js` (NEW) | Unit tests | DA-gated, bypass eligible |

**All four edits require your hands.** This is the right policy for new mesh contracts.

**❓ Q3: Approve `acd → conductor` direct route (skipping Kai-as-relay)?** (Recommended yes — fewer hops, matches existing file-drop pattern direction.)

**❓ Q4: Require conductor fuzzy-fallback fix as hard prerequisite (lands first or in same PR)?** (Recommended yes — otherwise `crew_manifest_v2` future risk is real.)

---

## 4. Conductor DB schema delta

### 4.1 New table

```sql
CREATE TABLE IF NOT EXISTS crew_assignments (
  role_id            TEXT PRIMARY KEY,
  manifest_id        TEXT NOT NULL,
  project_id         TEXT NOT NULL,
  shoot_date         TEXT NOT NULL,  -- ISO 8601 date
  role               TEXT NOT NULL,
  required_start_iso TEXT,
  required_end_iso   TEXT,
  status             TEXT NOT NULL CHECK (status IN
                       ('required', 'tentative', 'confirmed',
                        'unfilled', 'backfill_needed', 'cancelled')),
  confirmed_by       TEXT,
  confirmed_at       TEXT,
  notes              TEXT,
  source_message_id  TEXT,           -- A2A message_id that delivered this manifest
  schema_version     INTEGER NOT NULL DEFAULT 1,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_crew_assignments_lookup
  ON crew_assignments(project_id, shoot_date);

CREATE INDEX IF NOT EXISTS idx_crew_assignments_unfilled
  ON crew_assignments(status, shoot_date)
  WHERE status IN ('unfilled', 'tentative', 'backfill_needed');
```

### 4.2 Migration

Add to `scripts/lib/conductor-db.js` between line 163 (end of existing CREATE TABLEs) and the helper function block:

```javascript
const CREW_ASSIGNMENTS_SCHEMA = `<above SQL>`;
db.exec(CREW_ASSIGNMENTS_SCHEMA);
```

Idempotent (`IF NOT EXISTS`). No data-loss risk on re-run.

### 4.3 Upsert semantics

When ACD re-emits a manifest for the same `(project_id, shoot_date)` — e.g., a role flipped from `unfilled` → `confirmed`:

```sql
BEGIN IMMEDIATE TRANSACTION;
  -- Freshness guard: refuse if incoming generated_at is older than what we have
  -- OR if source_message_id has already been processed (idempotency)
  -- ... checks against current rows ...
  DELETE FROM crew_assignments
    WHERE project_id = :project AND shoot_date = :date;
  INSERT INTO crew_assignments (...) VALUES (...);  -- one INSERT per role
COMMIT;
```

**Why a transaction (added after Codex review):** without `BEGIN IMMEDIATE`, the delete-then-insert window exposes briefing-pipeline reads to an empty manifest (table has zero rows for ~ms while INSERT runs). A briefing cron firing in that window would incorrectly flag the shoot as "no manifest." Transaction wrap closes the window.

**Why freshness + idempotency guards:** if two ACD emissions overlap (e.g., a retry of an earlier message arrives after the newer manifest), the older one would clobber the newer. Guards: refuse INSERT if `incoming.generated_at < current.generated_at`, OR if `source_message_id` has already been processed (idempotency via `INSERT ON CONFLICT(source_message_id) DO NOTHING` on a tracking row).

**Why delete-then-insert vs row-level upsert:** the manifest is authored as a whole document by ACD. Partial diffs invite ambiguity ("did ACD intentionally drop this role or forget?"). Whole-document replace is simpler and matches how ACD will compose: regenerate from scratch each time.

**❓ Q5: Approve delete-then-insert upsert semantics (whole-document replace per emission)?** (Recommended yes — simpler invariant.)

### 4.4 ON DELETE CASCADE on projects

If a project is deleted, all its crew_assignments go with it. Matches how `milestones`, `tasks`, etc. relate to projects (cascading FK is the conductor pattern).

---

## 5. Validation invariant (intake item #5)

### 5.1 The invariant

> **A confirmed shoot date within the next 7 days that has no associated `crew_manifest` (zero rows in `crew_assignments`) is a policy violation.**

### 5.2 Where it enforces — three options considered

| Option | Where | Pros | Cons |
|--------|-------|------|------|
| (a) Receiver-side block in conductor | `confirm_shoot` handler refuses to confirm without manifest | Hard guarantee | Breaks existing flow — many shoots today have no manifest |
| (b) Producer-side block in ACD | `production_strategy` refuses to emit without manifest | Tight coupling | Sometimes shoot is confirmed before crew solved — false positive |
| (c) Audit-time detection (T-7 alert IS the enforcement) | Morning briefing flags any confirmed shoot ≤7 days out with no manifest | Soft, observable, doesn't break flow | Relies on briefing running daily |

**Recommendation: (c).** The T-7 alert ladder in §3.3 already flags unfilled roles. Extend it to flag missing-manifest entirely:

```sql
-- Detect confirmed shoots with NO manifest at all
SELECT rc.project_id, sd.shoot_date
FROM retainer_cycles rc, json_each(rc.shoot_dates) sd
WHERE julianday(sd.value) - julianday('now') BETWEEN 0 AND 7
  AND NOT EXISTS (
    SELECT 1 FROM crew_assignments ca
    WHERE ca.project_id = rc.project_id AND ca.shoot_date = sd.value
  );
```

Briefing renders these as a separate top-bucket alert: **"CONFIRMED SHOOT, NO CREW MANIFEST: Baptist 5/21 — ACD never emitted a manifest. T-1 day. Manual triage required."**

### 5.3 Why not all three

(a) and (b) are receiver/producer-coupled enforcement. They look attractive but break early-stage projects where the manifest can't yet be composed (talent not booked, location TBD). (c) is the right mechanism because it's **observable without blocking** — exactly the pattern of the action-vocab design's §3.5 silent-failure detection.

**❓ Q6: Approve audit-time enforcement (option c) over hard block at confirm-time?** (Recommended yes — observable beats brittle.)

---

## 6. Owners.json scope check

### 6.1 Repos in scope

| Repo | Has owners.json? | What this proposal touches | Policy verdict |
|------|------------------|----------------------------|----------------|
| ACD | ✅ | `scripts/lib/crew_manifest.py` (new), `tests/*`, `docs/examples/*` | DA-gated, bypass eligible — **CA drafts, DA passes, auto-merge** |
| ACD | ✅ | `scripts/daemon.py` (1 branch added) | **human_review_required — Alex hands** |
| Kai | ✅ | `scripts/conductor-agent.js`, `scripts/lib/conductor-db.js`, `scripts/lib/morning-briefing.js`, `scripts/mesh/mesh-api.js` | **All human_review_required — Alex hands** |
| Kai | ✅ | `knowledge/manifests/crew-manifest.schema.json` (new), `tests/*` | Verify subdir policy at PR time |
| KMG | ❌ | Not touched — KMG is out of scope for this proposal | N/A |

### 6.2 Net authority assessment

CA can fully author:
- ACD's new library code (`crew_manifest.py`), tests, example docs
- Kai's tests and schema JSON (pending subdir verification)

CA cannot author without your hands:
- The 4 daemon/db/briefing/mesh-api edits in Kai
- The daemon.py branch in ACD

**Practical workflow:** CA opens a PR with the CA-authored portions (library code + tests + schema + example). You review and add the daemon-side edits yourself, or hand back the 4-5 line patches for me to draft as suggested diffs for your hands to apply. Either way, no surprise mesh contract changes land without explicit per-change approval.

**❓ Q7: Approve the split — CA opens PRs for library/tests/schema; you apply daemon-side edits manually with my drafted diffs as input?** (Recommended yes — matches HB#1 and owners.json policy.)

---

## 7. Rollback plan

### 7.1 Per-component reversal

| Component | How to roll back | Data loss? |
|-----------|------------------|------------|
| Conductor DB table | `DROP TABLE crew_assignments` | All manifest data lost — but it's derivable from ACD by re-emitting |
| ACD library `crew_manifest.py` | `git revert` of the library + daemon.py edit | None — pure deletion |
| ACD daemon emission | Feature-flag the emission with env var `ACD_EMIT_CREW_MANIFEST=true` (default off in v1, flip on after proving) | None — flag controls behavior |
| Kai briefing query | `git revert` of the morning-briefing.js section | None — additive |
| Mesh route | Remove route from `seedRoutePermissions()` + restart mesh-api | In-flight messages may queue; no data loss |
| Schema JSON file | `git rm` | None |

### 7.2 Phased rollout to make rollback cheap

**Phase 1** (CA-drafts, you approve, then staged): Library code + tests + schema + example docs in ACD and Kai. No runtime behavior changes (no daemon edit yet). **Corrected after Codex review:** CA does NOT auto-merge. Per CLAUDE.md HB#1 every state-changing change requires explicit per-change go-ahead. CA opens PRs as drafts; you review and approve each before merge. The DA-gated owners.json policy controls *who can author* the code, not whether it auto-merges.

**Phase 2** (Alex hands, mid risk): Conductor DB table created. Mesh route registered. **Read path inert** — no consumer queries yet, no producer emits yet. Verify table exists, route accepts test message.

**Phase 3** (Alex hands, behavioral): ACD daemon.py adds `crew_manifest` emission behind feature flag, default OFF. Manual test send to conductor. Verify rows land.

**Phase 4** (flag flip, observable): `ACD_EMIT_CREW_MANIFEST=true`. Next production_strategy run also emits manifest. Briefing query starts surfacing data.

**Phase 5** (audit-time invariant): Briefing renders the "no manifest, but confirmed shoot" alert. Validates §5 invariant works.

**Each phase is independently reversible.** Rollback cost is one `git revert` or one env-var flip away.

**❓ Q8: Approve 5-phase rollout with feature flag for ACD emission?** (Recommended yes — incremental observability.)

---

## 8. (was unnumbered in intake — implied) Validation reiteration

Section 5 covers this. The intake's missing #5 maps to "confirmed shoot without crew_manifest = violation," which is the T-7 audit invariant.

---

## 9. Answers to 5 open questions from action-vocab design (intake item #8)

Strawmen against the concrete crew_manifest case. You answer; I update.

### Q1 (registry home repo): Kai's `knowledge/manifests/`

**Strawman: yes, place `crew-manifest.schema.json` at `knowledge/manifests/crew-manifest.schema.json`** in Kai. Concrete reasons specific to crew_manifest:

- Conductor (which validates incoming manifests) is in Kai. Schema-validator code reads schema from same repo — no cross-repo fetch at runtime.
- Static manifests directory already exists (per agent registry memory). Established pattern.
- ACD also needs the schema (for composing). Can read via `knowledge/manifests/` symlink, package version, or HTTP fetch from Kai. Recommend: ACD vendors a copy at composer time, with CA audit-time checking they don't drift (per action-vocab §3.4).

**Open sub-question:** schema lives in Kai but is owned by the receiver (conductor). Does ACD have read-only access? Recommend: yes via `knowledge/` being world-readable in the manifests/ subdir; CA's audit subcommand catches drift.

### Q2 (authority for registry edits): Receiver-agent's owners.json gates writes

**Strawman: yes.** For crew_manifest specifically:

- Conductor is the receiver → Kai's `scripts/mesh/**` policy (`human_review_required`) gates additions to conductor's `accepts` block.
- ACD's `sends` block is gated by ACD's `scripts/lib/**` policy (DA-gated, bypass eligible).
- **Asymmetry intentional:** receivers are the load-bearing side of a contract. Senders can be more freely modified.

CA always drafts; Alex always reviews. No mechanical bypass on contract changes.

### Q3 (adoption pacing): ACD → conductor crew_manifest is the FIRST pair

**Strawman: yes, replace the design doc's "ACD→Framer creative_brief" recommended first pair with ACD→conductor crew_manifest.** Reasons:

- ACD→Framer creative_brief is no longer urgent — route exists, daemon accepts it (per session 2 verify-framer-rca closure).
- Crew_manifest is greenfield — no legacy traffic, no breakage risk from first-pair experimentation.
- Alex personally cares about this one (Baptist incident). Validation feedback loop is short.

Second pair: still nami↔framer schedule_post_response (P0-A in overnight audit).

### Q4 (strict vs warn): Warn on conductor side, strict on ACD side

**Strawman: split posture per role.** For crew_manifest:

- **Conductor (receiver):** warn mode. Stores even partially-valid manifests with `validation_warnings` populated. Receiver-side strictness blocks data ingestion — too brittle for v1.
- **ACD (sender):** strict mode. ACD's `crew_manifest.py` composer validates against the schema before emitting; refuses to emit a malformed message. Sender-side strictness is cheap (no contract trust required — local check).

Flip both to mutual strict after 2 weeks clean.

### Q5 (versioning semantics): `crew_manifest_version` field, support last 2 versions

**Strawman:** envelope includes `manifest_version` (date-versioned: `2026-05-20.1`). Conductor handler supports current + prior version concurrently. Hard cutoff after 1 year (handler removes prior-version branch).

For crew_manifest specifically: v1 is what this proposal defines. Future v2 (e.g., add `multi_location` field) bumps the version. ACD emits both during a transition window OR conductor handles both — recommend conductor handles both, ACD emits latest only.

---

## 10. DA self-pass (CA-internal)

**Mandatory per CLAUDE.md DA gate** — this proposal touches mesh contracts, cross-repo, and DB migrations. DA verdict for the design itself:

### Concerns surfaced (and how this proposal addresses them)

| Concern | Risk | Mitigation in this proposal |
|---------|------|------------------------------|
| Conductor fuzzy-fallback would silently route `crew_manifest_v2` → `crew_manifest` | High — versioning breaks silently | Hard prerequisite: fuzzy-fallback fix lands first or in same PR (§3.2) |
| Manifest could go stale relative to actual crew bookings | Med — out-of-band confirmations not captured | Q5 versioning + delete-then-insert upsert ensures whole-document refresh |
| Audit-time enforcement (§5) means a confirmed shoot 1 day out with no manifest goes 24h before the briefing catches it | Med — repeats the Baptist class of failure (just narrower window) | Phase 4: briefing fires Telegram outside email window when `days_to_shoot <= 3` (§3.4) |
| ACD's "insufficient_context" graceful-degrade means projects with sparse context never get manifests | Low — but compounds with audit-time enforcement | §5 audit-time SQL specifically queries "no manifest at all" not just "unfilled roles" — caught |
| KMG could one day need crew_manifests (KMG produces internal shoots too) | Low — KMG is out of scope but extensible | Schema is project-agnostic; KMG joins later by being added as a sender |
| Single ACD daemon edit is highest-risk single change in the proposal | Med — daemon.py human-review required | Phase 3 feature flag with default off; manual smoke test before flip (§7.2) |
| Conductor's existing `human_review_required` on scripts/lib/conductor-db.js means every schema migration needs Alex hands | Low — accepted cost | This is the right policy; no bypass requested |

### Concerns NOT mitigated (deferred / accepted)

- **Conductor handler is single-threaded** — concurrent crew_manifest emissions from ACD could race the delete-then-insert. SQLite WAL helps but doesn't guarantee. Phase 2 work: add SQLite transaction wrapping. Accept risk for v1 because ACD only emits one manifest per project per call.
- **No backfill for past shoots.** This proposal doesn't backfill the Baptist incident. The point is going forward. Past shoots stay as-is.
- **Schema validation is in Python (ACD) and JS (conductor) — two implementations.** Action-vocab design §6 calls this out. Both sides must consume the same `crew-manifest.schema.json` via `jsonschema` (Python) and `ajv` (Node). Drift detection is the CA audit subcommand (action-vocab §3.4).

### Verdict

**PASSED with prerequisites.** Implementation gate requires:
1. Conductor fuzzy-fallback fix lands first or same PR (§3.2)
2. Phased rollout per §7.2
3. Alex answers Q1-Q8 before any code lands

---

## 11. Files this proposal recommends creating/editing

### ACD repo

- **NEW** `scripts/lib/crew_manifest.py` — composer
- **NEW** `tests/test_crew_manifest.py` — unit tests
- **NEW** `docs/examples/crew-manifest-baptist.json` — reference example
- **EDIT** `scripts/daemon.py:464-482` — add sibling emission branch (~5 lines)

### Kai repo

- **EDIT** `scripts/conductor-agent.js:286-294` — add `crew_manifest` handler
- **EDIT** `scripts/conductor-agent.js:422-440` — fix fuzzy-fallback (NEXT-SESSION.md #10 — prerequisite)
- **EDIT** `scripts/lib/conductor-db.js:163` — add CREATE TABLE crew_assignments + upsert helpers
- **EDIT** `scripts/lib/morning-briefing.js` — add T-7/T-3/T-24h query + render bucket
- **EDIT** `scripts/mesh/mesh-api.js:187-251` — add `acd → conductor` route to `seedRoutePermissions()`
- **NEW** `knowledge/manifests/crew-manifest.schema.json` — JSON schema source of truth
- **NEW** `tests/conductor/crew_manifest.test.js` — unit + integration tests

### Code Architect repo

- **NEW** `docs/examples/crew-manifest-v1.example.json` — copy of ACD's reference
- **Future** `code-architect audit vocabulary` subcommand (action-vocab design Phase B — not part of this proposal)

---

## 12. The 8 inline questions consolidated

| # | Question | Recommendation |
|---|----------|----------------|
| Q1 | Normalized `crew_assignments` table keyed on `(project_id, shoot_date)`, defer shoots-table to Phase 2? | Yes |
| Q2 | "insufficient_context" graceful-degrade — strategy emits even when crew can't be extracted? | Yes |
| Q3 | `acd → conductor` direct route (not via Kai)? | Yes |
| Q4 | Require conductor fuzzy-fallback fix as hard prerequisite? | Yes |
| Q5 | Delete-then-insert upsert semantics (whole-document replace)? | Yes |
| Q6 | Audit-time enforcement (T-7 briefing alert) over hard block at confirm-time? | Yes |
| Q7 | CA opens PR for library/tests/schema; you apply daemon-side edits with my drafted diffs? | Yes |
| Q8 | 5-phase rollout with feature flag for ACD emission? | Yes |

Plus 5 strawman answers in §9 for the action-vocab open questions — same yes/no/modify format.

---

## 13. Next steps (require Alex go-ahead per question)

1. **Read** §1-7 (the substance) and §9 (action-vocab strawmen).
2. **Answer** Q1-Q8 inline (any "no" or "modified" forks the proposal).
3. **Decide** which phases to authorize implementation for:
   - Phase 1 (CA-authored): library code, tests, schema, examples — CA-internal DA → auto-merge
   - Phase 2 (your hands): DB migration, mesh route — explicit go-ahead per change
   - Phases 3-5: behavioral rollout — explicit go-ahead per change
4. **Confirm** conductor fuzzy-fallback fix as the gating prerequisite.

No code changes in this session. This document is the deliverable.

---

*End of proposal. Source-of-truth path: `docs/proposal-crew-manifest-2026-05-20.md`. On revision, increment manifest_version date and append a changelog block at the bottom.*

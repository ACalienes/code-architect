# Plan — Board emit-hook coverage (the whole fleet)

**Status:** MAP v2 — **Codex round 2 = REVISE (8 findings), all folded in §"v2 fold" below.** Build next. Date: 2026-05-27. Built on the live Mini survey of each agent's real output.
**Goal:** every agent's *meaningful work* auto-appears on the Board — the realization of "the Board is the source of truth, what-needs-you" ([[feedback_why_dashboard_went_unused]]). Signal, not noise (the CFO lesson: emit semantic output, never raw tool-calls).
**Approach:** NOT 8 bespoke scripts. **2–3 reusable emitters + per-agent config**, all Mini-side, posting through the gateway loopback (`BOARD_URL=http://127.0.0.1:3351`) so the door becomes the single Board write owner (DA-d consolidation).

---

## Coverage table (verified sources)
| Agent | Semantic source (on Mini) | Fact type | Granularity | Emitter | Status |
|---|---|---|---|---|---|
| **Conductor** | `conductor.db` project/cycle changes | status_update | per change | `board-sync` | ✅ live |
| **CFO** | outbox alerts + `logs/drafts` | status_update | per alert-state / per draft | `board-emit-cfo` | ✅ live (+gateway mode) |
| **Offer Architect** | `docs/shared/outbox-pitch.json` | status_update / decision | per message | **`board-emit-outbox`** | build |
| **Pitch Deck** | `docs/shared/outbox-pitch.json` | status_update | per message | **`board-emit-outbox`** | build |
| **Framer** | `outputs/<client>/<project>/<ver>/` renders | status_update | **per build/version dir** (NOT per png) | **`board-emit-artifacts`** | build |
| **ACD** | `knowledge/brand-audits/*.md` | creative_brief / status_update | per file | **`board-emit-artifacts`** | build |
| **KMG** | `memory/drafts/`, `references/…` | status_update | per meaningful doc | **`board-emit-artifacts`** | build |
| **Kai** | `logs/tasks-archive.json` | task / decision | per new/closed task | `board-emit-kai` (json-list) | build |
| **Enso** | video output is **off-repo** — no artifact | — | — | needs Enso-side job log | **deferred** |
| **NAMI** | scheduled posts not on Mini (sheet?) | — | — | needs source location | **deferred** |
| **Lead Engine** | no leads store / reports on Mini | — | — | wire when it produces | **deferred** |
| **DAG / Dental mgrs** | no manager daemon on Mini | — | — | covered via Conductor + CFO | **deferred** |

## The reusable emitters (build spec)
1. **`board-emit-outbox.js`** — generalizes the proven CFO outbox path. Reads `docs/shared/outbox-<agent>.json`, emits each NEW message (keyed by timestamp) as a fact: `fact_type` from `message.type` if it maps to a known type, else `status_update`; `detail` = `summary`/`content`-head. Per-message idempotency key `<agent>:outbox:<ts>`. Modes: local / `BOARD_URL`. **Config:** `AGENT`, `OUTBOX_PATH`, optional severity filter. One process can serve OA + Pitch Deck (+ migrate CFO alerts here later).
2. **`board-emit-artifacts.js`** — watches a configured directory; emits "produced X" when a new artifact appears at the configured granularity. **Granularity is the key knob:** `file` (ACD audits, KMG docs) vs `dir@depthN` (Framer = one post per project/version dir, not per slide). Diff against a saved seen-set. Idempotency key `<agent>:artifact:<relpath>`. **Config:** `AGENT`, `WATCH_DIR`, `GRANULARITY`, `SUBJECT`, `FACT_TYPE`, `DETAIL_TEMPLATE`, ignore globs. Serves Framer + ACD + KMG.
3. **`board-emit-kai.js`** (or a generic json-list emitter) — reads `logs/tasks-archive.json`, emits new/closed tasks as `task` facts (status open→done). Highest-value because Kai is chief-of-staff; but confirm the archive's shape first.

## Run model
- All Mini-side (these agents + their output live on the Mini), `pm2`, posting via **gateway loopback** (consolidation → single write owner; idempotent; survives the multi-writer concern, DA-d). Per-agent gateway tokens via `gateway-enroll.js` (0600).
- Keep pm2 tidy: the two generic emitters each run as ONE process iterating a small config list, rather than one process per agent.

## Noise controls (the CFO lesson, applied)
- Framer: per-build, never per-asset (a carousel = 1 post, not 10).
- Outbox: dedupe repeating daily alerts to current-state-on-change (as CFO does).
- Artifacts: ignore-globs for temp/intermediate files; first run = silent baseline.

## Order to build (value × ease)
1. **`board-emit-outbox`** → OA + Pitch Deck (cheapest; reuses proven logic; 2 agents).
2. **`board-emit-artifacts`** → Framer (highest client-visible value: real deliverables), then ACD, then KMG.
3. **Kai task emitter** (confirm `tasks-archive.json` shape first).
4. Investigate the deferred three: Enso job log, NAMI post source, LE output.
5. Consolidation: migrate `board-sync` + `board-emit-cfo` to post via the gateway loopback too (one write owner).

## Gates
Each emitter is read-only on the agent (no cross-repo edits, HB#2 safe) — like board-sync/board-emit-cfo. New emitters touching the Board write path are minor; DA per the consolidation step. Deploy gated (per-agent token + pm2), proven by re-auditing the ledger.

---

## v2 fold — Codex round 2 (2026-05-27), all 8 findings
1. **No silent event loss (HIGH).** Emitter state is **per-event settled**, not "observed": mark seen ONLY on HTTP 200 (incl idempotent 200). **Transient** failures (network/5xx/429) stay PENDING → retried next tick. **Permanent** (400/401/403/409/422) → write to `~/.kameha/board-emit-quarantine.ndjson` (raw source pointer + error) and mark seen. **Already fixed in the reference `board-emit-cfo.js`** (settle/quarantine/mergeSeen); the generics inherit it.
2. **Reach the gateway correctly (HIGH).** The gateway binds the **Tailscale IP**, not loopback — so Mini-side emitters use `BOARD_URL=http://100.64.114.13:3351` (the Mini reaches its own tailnet IP), NOT `127.0.0.1`. Each emitter **health-gates**: poll `GET /health` until `writable:true` (backoff) before emitting; idle otherwise. (`board-emit-cfo` deployed runs LOCAL mode, so unaffected today.)
3. **Framer "build complete" contract (HIGH).** Depth is exactly `outputs/<client>/<project>/<version>/` (emit per NEW version dir, never the parent project). A version dir is emittable only when **done**: v1 = conservative **quiet-period** (dir tree mtime/size stable across 2 ticks, no temp extensions, expected index/manifest present); better = Framer writes an atomic `.board-ready.json` (Framer-side, future). Never emit a mid-write build.
4. **Bounded, lifecycle-aware idempotency keys (MED).** Use `<kind>:<sha256(canonical-id)>` (avoids the gateway's 200-char key cap and rename-reposts); encode lifecycle so transitions don't collide: `task-open:<id>` vs `task-closed:<id>` (else Kai open/closed reuse one key → 409). Human paths live in `subject`/`payload`, never the key. Drop the redundant `<agent>:` prefix (gateway already keys on the token's agent).
5. **Per-config isolation (MED).** Each config entry = `{ agent, tokenFile, stateFile, sourcePath }` — a generic process serving OA+Pitch (or Framer+ACD+KMG) gives EACH its own token (gateway sets `source_agent` from the token), its own state file, and runs its tick in an independent `try/catch` + backoff so one bad config/throw can't wedge the others.
6. **Explicit fact-type mapping (MED).** No silent default to `status_update`. Per-type payload **builders** that satisfy the registry (`status_update`→`status`, `decision`→`text`, `creative_brief`→`title`). An outbox `message.type` that isn't in the config's allowlist → **quarantine**, not coerce.
7. **Single-writer invariant — narrowed wording (MED).** Post-consolidation: **the gateway is the only producer of new FACTS; the router owns deliveries creation; the drainer owns delivery-status consumption.** It is NOT literally one DB writer (drainer/router still write). Keep WAL + busy_timeout.
8. **Content minimization (LOW/MED).** Payloads carry minimal metadata only — title, relative path/source ref, status, maybe a hash — **never file bodies or long content-heads**. Add deny-globs + a light secret/PII scan before posting any excerpt. (The gateway validates shape + blocks spoofing but does NOT redact — minimization is the emitter's job.)

**Confirmed by Codex:** deferring Enso/NAMI/Lead-Engine is correct; **do NOT add heartbeat/"active" facts to the Board** — liveness belongs in the health/heartbeat tables, not the semantic ledger.

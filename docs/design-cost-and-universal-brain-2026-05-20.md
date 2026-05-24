# Design — fleet-wide API cost telemetry + effective universal brain

**Author:** Code Architect (session 4, 2026-05-20)
**Status:** DRAFT — design doc. No implementation yet. Companion to `docs/architecture-current-state-2026-05-20.md` and the §10-11 sections of `explainers/architecture-current-state-2026-05-20.html`.

**Origin:** Alex's question — "what will the universal brain cost us once we have it, and how do we make it effective without bogging anything down?" Two real things in one sentence: (1) cost visibility, (2) retrieval effectiveness. They're solved by related but different mechanisms.

**Authority:** W3 draft-and-stage. CA writes; Alex reviews and approves per phase before any code lands.

---

## 1. What we already have (do not rebuild)

### 1.1 Kai's API telemetry is mature

Live and shipping today:

| Surface | Path | What it does |
|---------|------|--------------|
| `logApiUsage()` | `scripts/lib/model-router.js:430-462` | Logs every Anthropic call Kai makes with model, queryType, source, input_tokens, output_tokens, cache_creation, cache_read, cache_ratio |
| Log sink | `logs/api-usage.jsonl` | Append-only JSONL — 1,820 entries as of probe |
| One-shot analyzer | `scripts/api-cost-audit.js` | CLI report grouping by source/model with full cost calculation |
| HTTP endpoint | `scripts/routes/finances.js:793` `GET /api/costs` | Dashboard data feed with date range + model filtering |
| Pricing table | hardcoded in audit + finances route | Sonnet $3/M in $15/M out / $3.75 cache_write / $0.30 cache_read; Haiku 4.5 **$1/$5/$1.25/$0.10** (corrected after Codex review — earlier $0.80/$4/$1/$0.08 was outdated; verified against Anthropic prompt-caching pricing). Note: `logApiUsage()` collapses model IDs to `HAIKU`/`SONNET` (`model-router.js:446`), losing version-level pricing evidence — fix forward: store full model ID in telemetry. |

Real data from Kai's `api-usage.jsonl` (corrected after Codex review — the original "$5/month" was a 7-day projection from a quiet window, which understates):

- **Last 7 days**: 23 calls, $1.18 (7-day **run-rate** ≈ $5/month — biased low by a quiet window)
- **Last 30 days** (from the same log, more representative): ~$19.69
- **All-time** (1,820 entries since logging began): ~$94.13
- Cache hit ratio 22.6% (room to improve)
- Mix: Sonnet 51%, Haiku 36%, legacy 13%

Use the **30-day figure ($19.69/mo)** as the realistic Kai baseline going forward, not the 7-day projection.

### 1.2 The Anthropic Console is the source of truth for totals

`console.anthropic.com/usage` shows per-API-key spend in real time. **If each agent has its own API key, the console gives per-agent breakdown for free.** If they share, the console only shows aggregate. We don't currently know which we have — that's step 1 of the next-steps list.

### 1.3 What's missing — fleet-wide coverage

Kai's `logApiUsage` only runs from Kai's own paths. ACD, Framer, Enso, OA, PDE, CFO, Lead Engine, Chronicle, NAMI, Conductor, and any future agents make their own Anthropic SDK calls outside Kai's router. **None of them log per-call data anywhere we can see.**

The cheap fix: promote `logApiUsage()` to a fleet-shared library. Each agent imports and calls it once around its SDK invocation. ~20 lines of code per agent. Output lands in a shared JSONL or in mesh.db.

---

## 2. Goals

1. **Cost visibility** — at any moment, we can answer "what did the fleet cost yesterday" and "which agent is responsible for the spend." Down to per-call granularity.
2. **Retrieval effectiveness** — when an agent needs a fact, it gets the right slice of shared knowledge in <50ms with minimal tokens added to its Claude prompt.
3. **No agent bog-down** — universal brain queries are nearly free in both money and latency. Vector search is cheap. SQL is free. The expensive step (Claude) is reached LAST with a tight prompt.
4. **Hard cost ceilings** — per-agent daily budgets logged and alertable. Cost surprises become structurally impossible, not just unlikely.

**Non-goals (this design):**
- Building the universal brain content itself (separate proposal — see crew_manifest as the first concrete instance).
- Renegotiating Anthropic pricing.
- Replacing existing telemetry in Kai.

---

## 3. Design — cost telemetry

### 3.1 Architecture

```
                           ┌─────────────────────────────────────┐
                           │   ~/.kameha/lib/api-telemetry.js    │
                           │   (shared, fleet-wide)              │
                           │                                     │
                           │   logApiUsage({agent, model,        │
                           │                queryType, source,   │
                           │                usage})              │
                           └────────────┬────────────────────────┘
                                        │
       ┌────────────────────────────────┼────────────────────────────────┐
       │                                │                                │
       ▼                                ▼                                ▼
   Kai's calls                  ACD's calls                  Framer's calls
   (already wired)              (new wrapper)                (new wrapper)
       │                                │                                │
       └────────────────────────────────┴────────────────────────────────┘
                                        │
                                        ▼
                              ┌──────────────────────┐
                              │ ~/.kameha/api-usage  │
                              │      .jsonl          │
                              │ (shared sink)        │
                              └──────────┬───────────┘
                                         │
                                         ▼
                              ┌──────────────────────┐
                              │  Kai dashboard       │
                              │  GET /api/costs      │
                              │  (extended)          │
                              └──────────────────────┘
```

### 3.2 The shared library

Port `logApiUsage()` from `scripts/lib/model-router.js` to a new shared module at `~/.kameha/lib/api-telemetry.js` (Node) and `~/.kameha/lib/api_telemetry.py` (Python, for ACD/Framer/Enso). Same interface, same JSON output schema.

**One field added:** `agent_id`. Kai's existing entries today don't include it (Kai is implicit). The shared schema requires it.

```js
// JSONL entry schema
{
  ts: "2026-05-20T18:42:00.123Z",
  agent_id: "acd",             // NEW — required
  model: "SONNET",
  queryType: "production_strategy",
  source: "daemon",
  input_tokens: 8421,
  output_tokens: 1532,
  cache_creation: 0,
  cache_read: 4200,
  cache_ratio: "33.3"
}
```

### 3.3 Per-agent integration

| Agent | Lang | Effort | Where the wrapper goes |
|-------|------|--------|------------------------|
| Kai | node | none — already there | logs continue to <code>~/Desktop/Code/Kai Executive Assistant/logs/api-usage.jsonl</code> AND tee to shared sink |
| ACD | python | 1 hr | wraps Claude SDK call in `scripts/lib/production_strategy.py:240` and any other call sites |
| Framer | python | 1 hr | wraps daemon's SDK calls |
| Enso | python | 1 hr | same pattern |
| OA | node | 1 hr | wraps `oa-daemon.js` Claude calls |
| PDE | node | 1 hr | wraps `pde-d` Claude calls |
| CFO | node | 1 hr | wraps `cfo-agent.js` Claude calls |
| Lead Engine | python | 1 hr | wraps APScheduler-driven calls |
| Conductor | node | 30 min | low Claude usage; mostly orchestration |
| Chronicle | node | 30 min | low Claude usage; mostly data sync |
| NAMI | python (Render) | 1.5 hr | special — Render-hosted; logs need to ship back to Mini via mesh message |
| KMG | not running | — | skip until daemon ships |

**Total effort:** ~9 hours engineering across 11 agents. Could be parallelized via CA-authored CA-internal-DA-gated wrappers for the easy ones.

### 3.4 The dashboard extension

Kai's existing `/api/costs` endpoint already groups by source. Extend it to also group by `agent_id`. Two new query params:

```
GET /api/costs?days=30&group_by=agent_id
GET /api/costs?days=7&agent=acd&model=SONNET
```

Render in the existing Kai dashboard. No new UI work needed — just a new column in the existing cost table.

### 3.5 Per-agent budgets

Add a config file at `~/.kameha/agent-budgets.json`:

```json
{
  "schema_version": 1,
  "monthly_budgets_usd": {
    "kai": 50,
    "acd": 75,
    "framer": 75,
    "enso": 30,
    "oa": 30,
    "pde": 50,
    "cfo": 20,
    "lead-engine": 30,
    "conductor": 10,
    "chronicle": 10,
    "nami": 30,
    "kmg": 10
  },
  "alert_thresholds": {
    "yellow_at_pct": 70,
    "red_at_pct": 90,
    "hard_stop_at_pct": 105
  }
}
```

A cron job (added to Kai's existing wave-based system) checks daily spend against these budgets and fires alerts via existing Telegram pipe. Hard-stop at 105% is a circuit breaker — if an agent breaches, its Anthropic API client refuses to make calls until manually re-enabled.

**Initial budget total:** $420/month — significantly higher than current spend ($5/month from Kai alone). Generous on purpose; tune down once we have 30 days of real data.

---

## 4. Design — effective universal brain (3-layer retrieval)

### 4.1 The principle

Do the expensive thing last. Free queries first.

| Layer | Storage | Latency | Cost/query | Best for |
|-------|---------|---------|------------|----------|
| 1 | SQLite (`conductor.db`) | <1ms | $0 | Schema'd facts: projects, crew, deliverables |
| 2 | JSON files (`~/.kameha/shared/`) | <1ms | $0 | Daily snapshots, briefings, status reports |
| 3 | Vector index (TBD) | 10-50ms | ~$0.001 | Narrative knowledge, voice, learnings |
| 4 | Claude API | 1-10s | $0.03-0.10 | Synthesis only — never retrieval |

**Every agent task follows the same pipeline:**

```
1. Receive task description
2. Query Layer 1 (SQL) for structured facts                [free]
3. Read Layer 2 (files) for relevant snapshots             [free]
4. Vector-search Layer 3 for narrative context             [~$0.001]
5. Compose minimal Claude prompt:
   - Cached: agent system prompt + static schemas          [90% off]
   - Fresh:  task + L1+L2+L3 results (target ≤5K tokens)
6. Claude call                                              [$0.03-0.10]
7. Write result back to L1/L2/L3 for next agent's reads
```

### 4.2 Layer 1 — Structured

**Already exists.** `~/.kameha/conductor.db` is the active SQLite (3.6 MB WAL, updated daily). Tables today: `projects`, `milestones`, `tasks`, `scope_events`, `team_members`, `retainer_cycles`.

**Expansion path:** add new tables as typed cross-agent facts emerge.
- `crew_assignments` — first new table (see `docs/proposal-crew-manifest-2026-05-20.md`).
- `decision_log` — append-only record of cross-agent decisions ("we approved option B for nami email spam"). Schema: id, decision_id, made_by_agent, on_behalf_of_alex, summary_text, full_text_md, timestamp, related_project_id.
- `client_facts` — typed facts about clients: hours available, hard constraints, voice references. Schema: id, client_slug, fact_type, fact_value, asserted_by, asserted_at, expires_at.

Each new table requires owners.json approval (Kai's `scripts/lib/conductor-db.js` is `human_review_required`). CA drafts; Alex applies.

### 4.3 Layer 2 — Semi-structured

**Already exists.** `~/.kameha/shared/` has 7 active JSON files updated daily. Pattern works; just needs formalization.

**Formalization:** add a manifest at `~/.kameha/shared/knowledge-manifest.json` describing each file's schema, writer, refresh cadence, and consumers:

```json
{
  "schema_version": 1,
  "files": {
    "acd-production-briefing.json": {
      "schema_ref": "knowledge/schemas/production-briefing.schema.json",
      "writer": "acd",
      "refresh_cron": "0 5 * * *",
      "consumers": ["kai"],
      "stale_after_hours": 36
    },
    "financial-context.json": {
      "schema_ref": "knowledge/schemas/financial-context.schema.json",
      "writer": "cfo",
      "refresh_cron": "0 6 * * *",
      "consumers": ["kai", "oa"],
      "stale_after_hours": 36
    }
  }
}
```

The manifest tells any agent: "for daily financial state, read `financial-context.json` — it's written by CFO at 06:00 and considered fresh for 36 hours." Self-describing knowledge bus.

### 4.4 Layer 3 — Vector index (the new piece)

**Doesn't exist yet.** This is the unstructured-knowledge layer that holds:
- Client backstory ("Maria Diaz survived stage 3 — her brand story is recovery, not loss")
- Voice/tone references ("Direct Builders is warm institutional, not edgy")
- Past decisions and reasoning ("we picked option B for nami email because...")
- Learnings from past sessions

**Architecture choice:** SQLite-vss extension, pgvector (Postgres), OR alternative. **Downgrade after Codex review:** SQLite-vss is a *candidate*, not a recommendation, pending validation. Per its README (https://github.com/asg017/sqlite-vss) it is "not in active development" and pre-v1 (breaking changes possible). Before committing, verify:

1. **Apple Silicon (arm64) installability.** Mini is M-series; sqlite-vss has had platform issues historically.
2. **Stability for production reads.** Pre-v1 means schema/API may break; we'd be pinning a version and accepting upgrade-cost risk.
3. **Active alternatives:** sqlite-vec (the successor, actively maintained, by the same author); pgvector (requires running Postgres separately — bigger lift); a hosted vector DB (Pinecone, Voyage's own — adds $).

If SQLite-vss installs cleanly and stays stable for our scale (≤10K vectors): use it for v1 (same-DB, same backup story, no new daemon). If not: pivot to sqlite-vec.

In either case:
- Embed at write time via OpenAI text-embedding-3-small ($0.02/M tokens — essentially free for our volume).
- Performance fine for our scale (thousands of vectors, not millions).

**Schema:**

```sql
CREATE TABLE knowledge_chunks (
  chunk_id     TEXT PRIMARY KEY,
  prefix       TEXT NOT NULL,        -- e.g., "client:dr_van_der_ven" or "voice:direct_builders"
  content      TEXT NOT NULL,
  source       TEXT NOT NULL,        -- agent that wrote it, e.g., "kai", "acd"
  source_doc   TEXT,                 -- optional ref to originating doc
  written_at   TEXT NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1
);

-- vss virtual table for fast k-nearest-neighbor search
CREATE VIRTUAL TABLE knowledge_vectors USING vss0(
  embedding(1536)  -- text-embedding-3-small dimensions
);
```

**Write path:** agent calls `shared.knowledge_write(prefix, content)` → embedding is computed → row goes into both tables.

**Read path:** agent calls `shared.knowledge_search(task_text, top_k=5)` → task embedded → vss returns top-K chunks → returned as array.

**Cost:** each search call = 1 embedding API call (~$0.0001) + SQLite query (~10ms).

### 4.5 The schema manifest tells agents WHERE to look

```json
{
  "schema_version": 1,
  "query_types": {
    "client_status": {
      "layer": 1,
      "table": "projects",
      "fields": ["id", "name", "client_slug", "status", "stage"],
      "join": "WHERE client_slug = :client"
    },
    "crew_for_shoot": {
      "layer": 1,
      "table": "crew_assignments",
      "join": "WHERE project_id = :project AND shoot_date = :date"
    },
    "morning_briefing": {
      "layer": 2,
      "file": "acd-production-briefing.json"
    },
    "client_voice": {
      "layer": 3,
      "prefix": "voice:",
      "top_k": 3
    },
    "client_backstory": {
      "layer": 3,
      "prefix": "client:",
      "top_k": 5
    }
  }
}
```

Each agent's context-composer reads this manifest at startup and uses it to plan which layers to query for which task types. **No agent has to know the schema details — the manifest is self-describing.**

### 4.6 Performance budget — hard caps

The context-composer enforces a hard ceiling: **5,000 retrieved tokens added to any Claude prompt.**

If queries return more (e.g., 12 L3 chunks @ 500 tokens = 6,000), it runs a cheap Haiku summarization pass first to compress to <5,000. **Cost remains predictable.**

### 4.7 Caching strategy

Anthropic's prompt cache has a **5-min ephemeral TTL** and a **1-hour paid TTL** option (price doubles for the cache write but reads stay at 10% of input rate). The discount is 90% on cached input tokens. To exploit:

1. **Static prompt sections** (agent identity, role description, tool schemas, knowledge-manifest snippet) — marked with `cache_control: {type: "ephemeral"}` at the top of the message stack.
2. **Sliding-window L1/L2 results** — re-fetched each call but kept after the cached static section.
3. **Task-specific L3 results** — at the end, never cached (they change per call).

**Cadence sensitivity (added after Codex review):** the 5-min TTL only helps when the same prefix recurs within 5 minutes. For long-running agent sessions (>5 min between calls), the cache expires and we pay full rate again. Two branches:

- **Default (interactive sessions):** 5-min ephemeral cache. Best for Kai's Telegram bot where conversation turns happen within minutes.
- **Long-session (cron jobs, batch work):** opt into the **1-hour paid cache** when the same prompt prefix is expected within the hour. Cache write costs 2× but reads still at 10%. Net win if reused 3+ times in the hour.

Each agent picks the right TTL per call site. Wrapper helper exposes both.

With this layout: an agent making 20 calls in 10 minutes pays full rate for ~70% of input tokens on call 1, then ~10% rate on calls 2-20 for that same content. **Effective input cost on cached-heavy workflow drops ~70% — contingent on actual identical-prefix reuse within TTL.** Long-session workloads may see lower improvement until 1h-TTL is adopted.

Kai's current cache hit ratio is 22.6%. Target after rollout: **>50% on interactive paths, lower acceptable on cron/batch paths until 1h-TTL is wired**.

---

## 5. Phasing

### Phase 0 — Telemetry baseline (this week)

1. Check `console.anthropic.com/usage` — get current fleet total + per-key breakdown. (5 minutes, Alex hands.)
2. Promote `logApiUsage` to `~/.kameha/lib/api-telemetry.js` shared library. (CA-authored.)
3. Wrap each agent's Claude SDK calls. (CA drafts wrappers; Alex applies to daemon.py files per owners.json policy.)
4. Extend `/api/costs` endpoint with `agent_id` grouping. (Kai-side edit; Alex hands.)
5. **One week of data collection** before any further design.

**Output:** real per-agent baseline. No guesses.

### Phase 1 — Easy wins on existing spend (week 2)

1. Audit each agent's prompt structure for cacheable sections.
2. Add `cache_control` markers. (CA-authored library code changes; daemon edits Alex hands.)
3. Re-measure cache hit ratio after 1 week.

**Output:** ~30-50% reduction in input token cost on cached calls. Without any architectural change.

### Phase 2 — Layer 1 expansion (week 3-4)

1. Land `crew_manifest` proposal — first new typed table in conductor.db.
2. Land `decision_log` table — append-only cross-agent decisions.
3. Land `client_facts` table — typed client constraints.

**Output:** structured shared knowledge starts replacing copy-paste.

### Phase 3 — Layer 2 formalization (week 4-5)

1. Write the knowledge-manifest at `~/.kameha/shared/knowledge-manifest.json`.
2. Schemas committed at `~/kai/knowledge/schemas/`.
3. Schema validation added to existing writes.

**Output:** the file-drop pattern becomes typed and discoverable.

### Phase 4 — Layer 3 vector pilot (week 5-6)

1. Add `knowledge_chunks` + `knowledge_vectors` tables to conductor.db.
2. Build `shared.knowledge_write` + `shared.knowledge_search` helpers (Node + Python).
3. Backfill from one agent's existing `knowledge/` dir as pilot.

**Output:** narrative knowledge becomes queryable.

### Phase 5 — Per-agent context composer (week 6-8)

1. Build the context-composer pattern in one agent (recommend ACD — already most knowledge-heavy).
2. Measure: token count reduction, cache hit ratio, latency, output quality.
3. Roll out to other agents one at a time.

**Output:** the 3-layer model in production for at least one agent.

### Phase 6 — Budgets + alerts (week 8+)

1. Land `agent-budgets.json` config.
2. Wire daily budget-check cron.
3. Telegram alerts on threshold breach.

**Output:** cost surprises become structurally impossible.

---

## 6. Cost projection — what we actually expect

These are honest estimates with their assumptions. We'll know the truth after Phase 0.

| Scenario | Current monthly | After UB rollout (smart) | After UB rollout (naive) |
|----------|----------------|--------------------------|---------------------------|
| Pessimistic (high call volume) | $400-700 | $480-840 (+20%) | $800-1400 (+100%) |
| Realistic (moderate) | $200-400 | $240-480 (+20%) | $400-800 (+100%) |
| Optimistic (Kai-like usage across fleet) | $50-100 | $60-120 (+20%) | $100-200 (+100%) |

**The smart-vs-naive delta is the architecture decision** — 2× difference for the same functional capability. The variance within each row is the call-volume unknown that Phase 0 resolves.

---

## 7. Risks + mitigations

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Per-agent wrappers break existing flows | Med | Wrapper is additive — agent makes call, then logs. If logging fails, call still succeeds. |
| Shared JSONL file gets corrupted under concurrent writes | Low-Med | Use `safe-json.js` pattern (already in Kai) — atomic append with file locking. |
| Anthropic SDK changes break wrappers | Low | Pin SDK versions; CI test against new versions. |
| Vector index becomes stale | Med | Each write re-embeds. Daily cron checks for missing embeddings, re-runs. |
| Budget hard-stop locks out a critical agent | Low | "Hard-stop" is 105% (above threshold). Telegram alert at 90% gives 2-day buffer to extend budget. |
| Manifest drifts from reality | Med | CA audit subcommand verifies manifest matches actual tables/files. Run weekly. |
| Schema migrations break consumer agents | Med | Schema version field on every record. Consumers support last 2 versions. |

---

## 8. Open questions for Alex

1. **API key arrangement.** Do agents share one Anthropic key, or does each have its own? (Check `console.anthropic.com/settings/keys`.) If shared: per-agent breakdown depends on our telemetry. If per-agent: console gives it for free.
2. **Budget tolerances.** Are the proposed monthly budgets ($420 total) reasonable, or should we be tighter / looser? Tune after Phase 0 data.
3. **Vector index choice.** SQLite-vss (recommended) vs pgvector. Pgvector needs Postgres which isn't on the Mini today. SQLite-vss reuses existing infrastructure.
4. **Embedding model.** OpenAI text-embedding-3-small ($0.02/M) recommended. Alternative: Voyage AI (Anthropic's recommended), pricier but better for code/document content. Both work.
5. **Phase 0 ownership.** I (CA) can author all the shared library code under DA gate. The agent daemon edits need your hands per owners.json. Confirm you'll apply them with my drafted diffs as input.

---

## 9. Next steps (require Alex go-ahead per question)

1. **Approve Phase 0 scope** — telemetry baseline, no architectural changes.
2. **Provide answers to §8 open questions** — most have a recommended answer.
3. **Authorize CA to draft the shared library + per-agent wrappers** — DA-gated, no commits.

No code changes in this session. This document is the deliverable.

---

*End of design doc. Source-of-truth at `docs/design-cost-and-universal-brain-2026-05-20.md`. Companion HTML sections in `explainers/architecture-current-state-2026-05-20.html` §10-11.*

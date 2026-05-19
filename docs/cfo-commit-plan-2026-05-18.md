# CFO Commit Checkpoint Plan — 2026-05-18

**Context:** CFO has 4 weeks of uncommitted feature work (10 modified + 16 untracked files, +942 / -71 LOC across modified files alone). The high-churn `logs/cfo-activity.json` was just evicted (commit `8019706`) so diffs are now legible. This plan groups the remaining work into 8 reviewable commits.

**Authoring:** Alex executes these commits (CFO is Alex's domain — CA's role is the plan, not the authorship). All 8 commits are independent and can be reordered or skipped per Alex's preference.

**Owners.json policy reminder** (from new `.kameha/owners.json`, commit `ec6da5f`):
- `scripts/alerts/**`, `scripts/calc/**`, `scripts/dashboard/**`, `scripts/nudges/**`, `scripts/launchd/**` → `human_review_required` (Alex commits, CA can draft but not auto-merge)
- `scripts/lib/**`, `scripts/tests/**`, `tests/**` → `auto_merge_after:ca_internal_da` (CA could draft + auto-merge with DA pass)
- `logs/**`, `data/**`, `knowledge/**`, `receipts/**`, `docs/shared/**` → `owner_only` (CFO daemon writes; CA never)

---

## Pre-flight decisions (settle these first)

### P1. `docs/shared/outbox-cfo.json` — owner-only, dirty (173-line diff)

Per the new owners.json, this is CFO's mesh outbox state. **CA cannot commit this.** It's the CFO daemon's job. If the daemon isn't auto-committing it, that's a daemon bug worth filing separately. For this checkpoint: leave it dirty, file a follow-up.

### P2. `logs/closes/`, `logs/drafts/`, `logs/nudges-history.jsonl` — track or gitignore?

Contents inspection:
- `logs/closes/2026-04.md` — looks like a monthly close brief output (markdown, human-readable)
- `logs/drafts/2026-05-09-direct-builders-wrap-email.md`, `logs/drafts/tdb-invoice-1-may-2026.json` — looks like draft outputs (emails, invoices)
- `logs/nudges-history.jsonl` — runtime nudge log (probably churns)

**Question for Alex:** are these (a) intentional source-of-truth records you want versioned, or (b) runtime outputs that should be gitignored like `cfo-activity.json` was? If (b), add `logs/closes/`, `logs/drafts/`, `logs/nudges-history.jsonl` to `.gitignore` before any commits below. If (a), they're part of commit G (nudges/history bundle).

### P3. `logs/cfo-learning-log.json` — silently tracked already, churning?

Not in the untracked list but worth checking — if it's tracked and growing, it has the same problem as `cfo-activity.json`. Run: `git log --oneline -5 -- logs/cfo-learning-log.json` to see commit frequency.

---

## The 8 commits (in dependency order)

### Commit A — `feat(tests): seed pytest tree + BofA statement parser`

**Files (3 new):**
- `scripts/__init__.py` (package marker)
- `scripts/lib/bofa_statement_parser.py` (parser used by tests)
- `scripts/tests/` (6 test files: BofA parser, burn rate, codex fixes, entity comparison, nudges, nudges API)

**Why first:** Tests are independent of any feature; landing them first means subsequent commits can claim "tests still pass" as a green signal.

**Owners.json policy:** `scripts/lib/**` + `scripts/tests/**` = both `auto_merge_after:ca_internal_da` (CA could ship this with DA pass if you authorize).

---

### Commit B — `feat(alerts): financial monitor + send pipeline`

**Files (2):**
- `scripts/alerts/financial_monitor.py` (+77 NEW)
- `scripts/alerts/send_alerts.py` (+5 mod)

**Why:** Self-contained pipeline. Already running successfully this morning (7 critical, 30 warning, 9 info from QB data).

**Owners.json policy:** `scripts/alerts/**` = `human_review_required`.

---

### Commit C — `feat(calc): burn rate, tax monitor, close brief, entity comparison, tax setaside`

**Files (5):**
- `scripts/calc/burn_rate.py` (+111 mod)
- `scripts/calc/tax_threshold_monitor.py` (+90 mod)
- `scripts/calc/april_close_brief.py` (NEW)
- `scripts/calc/entity_comparison.py` (NEW)
- `scripts/calc/tax_setaside.py` (NEW)

**Why:** All calc/financial-modeling work. Tight thematic group. ~200+ LOC of accuracy-critical code.

**Owners.json policy:** `scripts/calc/**` = `human_review_required`.

**Recommendation:** read through each before committing — accuracy is load-bearing. The 4-week gap means you'll want to re-verify the burn_rate.py changes against today's QB data before shipping.

---

### Commit D — `feat(snapshot): expand daily snapshot pipeline`

**Files (1):**
- `scripts/daily_snapshot.py` (+139 mod)

**Why:** Standalone pipeline change. 139 lines is enough scope to deserve its own commit.

**Owners.json policy:** `scripts/**` catch-all = `human_review_required`.

---

### Commit E — `feat(dashboard): new UI surfaces + supporting routes`

**Files (2):**
- `scripts/dashboard/app.py` (+190 mod)
- `scripts/dashboard/templates/index.html` (+165 mod)

**Why:** Dashboard work is logically paired (Flask route + template). +355 lines is large but cohesive.

**Owners.json policy:** `scripts/dashboard/**` = `human_review_required`.

**Recommendation:** boot the dashboard locally (`flask run` or equivalent) before committing to verify the routes render. Per session-1 standing rule on UI changes.

---

### Commit F — `feat(qb): recurring invoice management + update/void + customer create extensions`

**Files (5):**
- `scripts/qb_create_customer.py` (+37 mod — existing)
- `scripts/qb_create_recurring.py` (NEW)
- `scripts/qb_delete_recurring.py` (NEW)
- `scripts/qb_update_invoice.py` (NEW)
- `scripts/qb_void_invoice.py` (NEW)

**Why:** All QB write-side scripts, logical group. Extends the existing pattern from the last commit (`2953446` invoice payment flags).

**Owners.json policy:** `scripts/**` catch-all = `human_review_required`. (No `scripts/qb/` sub-lane carved out — could add one if you want all QB scripts auto-mergeable for mechanical refactors.)

---

### Commit G — `feat(nudges): client outreach engine + history`

**Files (1 dir + maybe 1-3 logs depending on P2):**
- `scripts/nudges/__init__.py`
- `scripts/nudges/engine.py`
- (if P2 = "track them": `logs/nudges-history.jsonl`, `logs/closes/`, `logs/drafts/`)

**Why:** The nudges system you mentioned wanting to fix.

**Owners.json policy:** `scripts/nudges/**` = `human_review_required` (per draft rationale: "sends to clients; humans review every change").

**Recommendation:** highest-stakes commit. Read engine.py end-to-end before shipping — outbound client messaging.

---

### Commit H — `docs: CLAUDE.md updates + LANGUAGE.md + data-analyst pattern KB`

**Files (3):**
- `CLAUDE.md` (+26 mod)
- `LANGUAGE.md` (NEW)
- `knowledge/strategy/managed-agents-data-analyst-pattern-2026-04-28.md` (NEW)

**Why:** Docs cluster, no code dependencies. Safe to land any time.

**Owners.json policy:** `CLAUDE.md` + `LANGUAGE.md` fall to fallback = `human_review_required`. `knowledge/**` = `owner_only` — wait, that's CFO's own knowledge base. **You** writing to it is fine (you're the owner); CA wouldn't be allowed. So Alex commits this normally.

---

## Recommended commit order

**If shipping in one session:** A → B → C → D → E → F → G → H (above order).

**If shipping incrementally over multiple sessions:**
- Session 1: A, H (low-risk seed + docs)
- Session 2: B, D, F (financial-monitoring infrastructure)
- Session 3: C (accuracy review)
- Session 4: E, G (UI + client-touching code, both need careful review)

**If just need a checkpoint commit fast:** combine A+B+D+H as a single `chore: 4-week checkpoint commit` and revisit the rest. Loses logical grouping but removes the risk window.

## Open follow-ups (not part of this checkpoint)

1. **P1: `outbox-cfo.json` daemon-commit gap** — file a CFO daemon bug if the mesh outbox isn't auto-committing.
2. **`docs/shared/outbox-cfo.json`** — `owner_only` per new owners.json. CA can't touch even if you wanted us to.
3. **Cross-fleet gitignore template** — `.playwright-mcp/` is in CFO's new ignore; same pattern needed in Framer, CA, etc. NEXT-SESSION queue item #4.

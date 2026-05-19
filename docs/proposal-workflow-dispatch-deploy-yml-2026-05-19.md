# Proposal — Add `workflow_dispatch` trigger to `deploy.yml` (Kai + KMG)

**Author:** Code Architect (session 3 follow-up, 2026-05-19 ~12:35 ET)
**Status:** DRAFT — awaits Alex go-ahead per repo before commit/push. No edits applied to any working tree.
**Source intake:** `docs/intake-kai-workflow-dispatch-2026-05-19.md`
**DA verdict:** PASSED for Kai. PASSED for KMG **conditional on KMG owners.json bootstrap landing first.**

---

## 1. Problem

Tailscale auth-key rotation happened 2026-05-19T17:13Z. Two new ephemeral 90-day reusable keys are set as `TAILSCALE_AUTHKEY` secret in `ACalienes/kai-executive-assistant` and `ACalienes/kmg`. The previous key remains valid until 2026-05-22 (3-day runway), so this is not time-pressured today, but is the cleanest validation path AND closes a recurring gap:

- **No way to validate a rotated secret** without finding a real change to push to main.
- **No way to manually re-run a deploy** after a transient Mini outage.
- **Future rotations** hit the same dead-end.

`gh workflow run deploy.yml` currently returns HTTP 422 ("Workflow does not have 'workflow_dispatch' trigger") for both repos.

## 2. Proposed change

Add a `workflow_dispatch:` sibling under `on:` in each deploy.yml. Zero-body form (empty after the colon) — no manual inputs needed.

### 2.1 Kai diff

**File:** `/Users/alex/Desktop/Code/Kai Executive Assistant/.github/workflows/deploy.yml`

```diff
 name: Deploy to Mac Mini

 on:
   push:
     branches: [main]
     paths-ignore:
       - 'logs/**'
       - 'memory/**'
       - '*.md'
       - 'knowledge/directives.json'
       - 'knowledge/directives-archive.json'
       - 'knowledge/clients.md'
       - 'knowledge/personal.md'
       - 'templates/**'
       - 'data/**'
+  workflow_dispatch:

 jobs:
```

### 2.2 KMG diff

**File:** `/Users/alex/Desktop/Code/Kameha Media Group/.github/workflows/deploy.yml`

```diff
 name: Deploy KMG to Mac Mini

 # CRITICAL: NO `paths-ignore` for `*.md` or `memory/**`.
 # KMG's bible IS markdown. Boundaries v3 §11.4 explicitly forbids these path ignores.
 # See `/Users/alex/Desktop/Code/Kai Executive Assistant/memory/project_kmg_boundaries_v3_2026-05-11.md`.

 on:
   push:
     branches: [main]
+  workflow_dispatch:

 jobs:
```

**Both diffs:** 1 line added each. Trailing comments + jobs blocks unchanged.

## 3. Owners.json scope check

| Repo | Path | owners.json policy | bypass-eligible | Verdict |
|---|---|---|---|---|
| Kai | `.github/workflows/deploy.yml` | `human_review_required` | ❌ false | **Alex explicit go-ahead required per change** |
| KMG | `.github/workflows/deploy.yml` | NO owners.json | n/a | **HB#2 fail-closed: blocked until KMG owners.json bootstrap lands** |

**Prerequisite:** the KMG owners.json bootstrap (morning-actions item #7) MUST land before the KMG workflow edit can be drafted-and-committed by CA. The bootstrap is a separate task; this proposal does not include the bootstrap draft. Hand off to CA's next invocation to draft KMG owners.json first if it hasn't landed.

## 4. CA-internal DA pass

Per CLAUDE.md §"Devils Advocate gate" — DA is **mandatory** here because the change touches:
- Deploy pipelines (`sync-repos.sh` / `ecosystem.config.js` / GitHub Actions) → **YES**
- Cross-repo (>1 repo) → **YES** (Kai + KMG)

### 4.1 DA verdict per repo

**Kai: PASSED.**
- Change is purely additive. No removal, no semantic change to existing triggers.
- `workflow_dispatch:` with no `inputs:` block is GitHub Actions standard form; no syntax risk.
- Existing push trigger remains intact (no `paths-ignore` modification). Normal push-to-main deploys continue exactly as before.
- The `data/**` paths-ignore (added 2026-04-07 to stop the hourly cascade) is preserved.
- Workflow file modification itself triggers a deploy on push (workflow path is NOT in paths-ignore). Side effect: pushing the proposed commit will run a deploy — that IS the intended validation per Kai's prompt.

**KMG: PASSED conditional on KMG owners.json bootstrap.**
- Same shape of change as Kai. Additive only.
- KMG's deploy.yml is the maiden-voyage workflow — pushing this commit will trigger the first end-to-end Mini deploy for KMG. **This is the validation path Kai's prompt explicitly wants.**
- Carries maiden-deploy risk (untested deploy flow on Mini for KMG). Same risk exists for any "first push to main" on KMG; this change does not introduce new risk vs. any other content-bearing first commit.
- The "CRITICAL: NO paths-ignore" comment block is preserved (Boundaries v3 §11.4 compliance).

### 4.2 Run-ledger entry shape (conceptual — W4 not yet shipped)

Once `scripts/lib/run-ledger.js` lands (deferred per CLAUDE.md "Hard stop"), this kind of cross-repo state-change would emit a ledger entry of shape:

```json
{
  "run_id": "ca-workflow-dispatch-2026-05-19T<ts>Z",
  "schema_version": 1,
  "tool": "code-architect implement",
  "intent": "add workflow_dispatch trigger to deploy.yml (Kai + KMG)",
  "scope": ["kai", "kmg"],
  "files_touched": [
    "/Users/alex/Desktop/Code/Kai Executive Assistant/.github/workflows/deploy.yml",
    "/Users/alex/Desktop/Code/Kameha Media Group/.github/workflows/deploy.yml"
  ],
  "da_verdict": {"passed": true, "criteria_matched": ["deploy_pipeline", "multi_repo"], "agent": "ca-internal"},
  "approvals": [{"approver": "alex", "approved_at": "<iso>", "method": "explicit_go_ahead_per_change"}],
  "pre_check": {"git_status_clean_per_repo": true, "kmg_owners_json_present": true},
  "steps": [
    {"step": 1, "action": "edit kai deploy.yml", "pre": "<sha>", "post": "<sha>", "rollback": "git revert"},
    {"step": 2, "action": "edit kmg deploy.yml", "pre": "<sha>", "post": "<sha>", "rollback": "git revert"}
  ],
  "post_check": {"kai_deploy_triggered": null, "kmg_deploy_triggered": null, "tailscale_auth_validated": null},
  "final_state": "drafted_pending_approval"
}
```

Recorded conceptually in this proposal until W4 lands. For now, the audit trail lives in (a) the git commit messages on Kai + KMG, (b) this proposal doc.

## 5. Risk + rollback

**Risk per repo:**
- Kai: ~zero. Additive YAML. Worst case: a typo breaks the entire workflow → both push-triggers and manual triggers fail. Mitigation: the diff is 1 line; YAML linter catches issues; review-the-diff catches the rest.
- KMG: ~zero for the workflow_dispatch addition itself. The actual maiden-deploy on Mini is a separate risk independent of this change — it would surface on any first push to KMG main, whether driven by this commit or another.

**Rollback (per repo):** trivial. Single commit revert.

```bash
# Kai
cd "/Users/alex/Desktop/Code/Kai Executive Assistant"
git revert <commit-sha>
git push origin main

# KMG
cd "/Users/alex/Desktop/Code/Kameha Media Group"
git revert <commit-sha>
git push origin main
```

Rollback preserves all other state; only removes the workflow_dispatch trigger registration.

## 6. Validation chain after Alex approves

Per Kai's prompt:

1. **Commit + push to Kai** → triggers deploy on push (workflow file modification is in the deploy trigger path; not in paths-ignore) → confirms new Kai `TAILSCALE_AUTHKEY` works end-to-end.
2. **Commit + push to KMG** → triggers KMG's first-ever Mini deploy → confirms KMG `TAILSCALE_AUTHKEY` works AND validates the maiden-voyage flow.
3. After both green, Alex's Tailscale rotation is fully closed. Old key (valid through 2026-05-22) becomes redundant.

Optional follow-up after push validates: trigger a `gh workflow run deploy.yml` on each repo to confirm the manual trigger surface works — closes the original "no way to validate without a real change" gap.

## 7. Sequencing

Per Kai's prompt + morning-actions queue:

1. ~~Item #1 (T2 probe)~~ — TTL'd at 12:55 UTC; recorded `status: "failed"`, no action possible.
2. **Item #2 (Chronicle unlock)** — still pending; can run in parallel with this proposal.
3. **Item #7 (KMG owners.json bootstrap)** — PREREQUISITE for this proposal's KMG diff.
4. **THIS proposal** — Kai diff can ship independently; KMG diff blocks on #7.

Best path: land KMG owners.json bootstrap and THIS proposal in the same approval batch since both touch KMG.

## 8. Approval ask

**Alex, to proceed I need explicit per-change go-ahead on each of the following:**

| # | Change | Repo | Approval needed |
|---|---|---|---|
| 1 | Add `workflow_dispatch:` to `on:` | Kai | y/n |
| 2 | KMG owners.json bootstrap draft (CA-internal next step, separate proposal) | KMG | y/n (proceed with draft) |
| 3 | Add `workflow_dispatch:` to `on:` (after #2 lands) | KMG | y/n |
| 4 | Allow CA to commit + push #1 and #3 once approved (NOT auto — explicit "ship") | Kai + KMG | y/n |

A simple "ship 1" + "draft 2" + "ship 3 after 2" + "ship" sequence works. Or wholesale "draft + ship all of it" if you'd rather not micromanage. Either way, CA holds — no commits without your green light per item.

## 9. Open questions

- **Q1:** Should the workflow_dispatch entry include an `inputs:` block for future debugging hints (e.g., `dry_run: boolean`), or stay minimal? Recommend minimal v1; expand only when a real need arises.
- **Q2:** Does Alex want CA to draft the KMG owners.json in this same session, or hold for a dedicated session per the "explicit owners-bootstrap task" hard-boundary protocol? CA's read: this counts as the explicit task — the W3 authority model wraps both.
- **Q3:** After validation lands cleanly, should CA add a memory card noting the pattern (rotate-validate flow + workflow_dispatch hygiene) for future rotations?

---

*End of proposal. No working-tree edits made. Awaiting Alex's go-ahead per item above.*

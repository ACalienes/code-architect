# Intake — Kai workflow_dispatch addition to deploy.yml (Kai + KMG)

**Origin:** Kai Claude Code session, relayed by Alex via paste at ~2026-05-19 12:30 ET.
**Saved per:** [[project-intake-convention-docs-dated-files]] BEFORE CA-side analysis.
**Verbatim ask (compressed):**

> Tailscale auth-key rotation happened 2026-05-19. New ephemeral 90-day keys set as `TAILSCALE_AUTHKEY` in `ACalienes/kai-executive-assistant` (2026-05-19T17:13:37Z) and `ACalienes/kmg` (2026-05-19T17:13:38Z). Old key valid until 2026-05-22 (3-day runway). Neither repo's `deploy.yml` registers `workflow_dispatch`, so `gh workflow run deploy.yml` returns HTTP 422 ("Workflow does not have 'workflow_dispatch' trigger"). Means no way to validate a rotated secret without finding a real commit to push, no way to manually re-run a deploy after Mini outage, future rotations hit the same dead-end. Draft a surgical one-line addition (`workflow_dispatch:`) to both `on:` blocks. W3 authority model — CA drafts and proposes; Alex approves before commit/push.

**Alex's correction:** KMG path is `/Users/alex/Desktop/Code/Kameha Media Group/` (with spaces), remote `github.com/ACalienes/kmg`. Confirmed deploy.yml exists there. No owners.json yet (consistent with morning-actions #7).

---

## State verified on disk

| File | Exists | Current `on:` block |
|---|---|---|
| `/Users/alex/Desktop/Code/Kai Executive Assistant/.github/workflows/deploy.yml` | ✅ | `push: branches: [main] paths-ignore: [logs/**, memory/**, *.md, knowledge/directives*.json, knowledge/clients.md, knowledge/personal.md, templates/**, data/**]` |
| `/Users/alex/Desktop/Code/Kameha Media Group/.github/workflows/deploy.yml` | ✅ | `push: branches: [main]` (no paths-ignore — KMG bible IS markdown) |

## Policy state

| Repo | owners.json policy for `.github/workflows/**` |
|---|---|
| Kai | `human_review_required`, **not** bypass-eligible |
| KMG | **No owners.json file** → HB#2 fail-closed; CA refuses cross-repo edits except explicit owners-bootstrap or migration task pre-approved by Alex |

**Implication:** both files require Alex's explicit per-change approval before push. KMG needs an owners.json bootstrap as the prerequisite step (already item #7 in `docs/morning-actions-2026-05-19.md`).

## CA's plan (for cross-reference)

Produced two deliverables:
1. This intake doc (provenance)
2. `docs/proposal-workflow-dispatch-deploy-yml-2026-05-19.md` (the actual draft per W3 pattern, with the two YAML diffs, DA pass, risk/rollback, approval ask)

Cross-link: see [[docs/proposal-workflow-dispatch-deploy-yml-2026-05-19.md]] for full draft.

## Sequencing decision

Kai's prompt suggested folding this into the same session as item #7 (KMG owners.json bootstrap). Confirmed correct — KMG workflow edit is BLOCKED on KMG owners.json existing. Two-step:
1. Land KMG owners.json bootstrap (CA drafts; Alex ships)
2. Land workflow_dispatch addition on both repos (CA drafts; Alex ships)

Both deferred to Alex's "go" — neither auto-shipping under overnight-execution authority (DA-gate-mandatory; deploy-pipeline change).

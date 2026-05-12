# Code Architect

Engineering capacity for the Kameha mesh. Plans, implements, and audits cross-agent changes under a methodology spine and run ledger. Single-shot CLI — invoked per task, not a long-running daemon.

## Invocation (W3 scaffold; full CLI lands in Phase 2)

```bash
code-architect implement <task> --class=<sender-migration|schema-change|new-agent|refactor|hotfix|general>
code-architect map
code-architect rollback <run-id>
code-architect memory <doctor|restore|re-distill>
```

## Authority model

W3 + early Phase 2: **explicit go-ahead per change** from Alex. CA drafts and stages; Alex approves before commit/push. T2-equivalent gate.

## See also

- `manifest.json` — mesh declarations (schema v1, tier 1, sends_to nine agents)
- `methodology.md` — engineering methodology spine (≤200 lines, source-cited)
- `memory/MEMORY.md` — pattern + failure-analysis index (≤30 active cards)
- Scope doc (Kai repo): `memory/project_code_architect_scope_v3_2026-05-10.md`
- W3 design prep (Kai repo): `memory/design_ca_phase1_w3_2026-05-11.md`

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

## Manual hash regeneration (v0.1 procedure)

When `code-architect memory doctor` reports `SOURCE DRIFT`, the methodology
spine may be out of sync with the cited source files. The auto-derivation
path lands in Phase 2 W4. Until then, reconcile by hand:

1. Run `code-architect memory doctor` to list drifted paths.
2. For each drifted entry in `memory/source-hashes.json`, open the source
   file and the methodology.md sections listed in its `cited_in_sections`
   array. Edit methodology.md if the cited text is stale.
3. Recompute the sha256 for each reconciled source:
   ```bash
   shasum -a 256 "<source-path>" | awk '{print $1}'
   ```
4. Open `memory/source-hashes.json` and replace the `sha256` field for each
   updated entry with the new hex digest. Update `path` (or remove the
   entry) if the source was renamed or removed.
5. Re-run `code-architect memory doctor`. Expect `CLEAN`.

`code-architect memory re-distill` prints this procedure to stdout for
quick reference at the terminal.

## See also

- `manifest.json` — mesh declarations (schema v1, tier 1, sends_to nine agents)
- `methodology.md` — engineering methodology spine (≤200 lines, source-cited)
- `memory/MEMORY.md` — pattern + failure-analysis index (≤30 active cards)
- Scope doc (Kai repo): `memory/project_code_architect_scope_v3_2026-05-10.md`
- W3 design prep (Kai repo): `memory/design_ca_phase1_w3_2026-05-11.md`

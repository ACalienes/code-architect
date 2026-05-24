## Verdict
REVISE

## Concerns by severity

### High (blocks ship)
- Conductor capability insertion point is not actually reachable: `docs/proposal-crew-manifest-2026-05-20.md:145` says adding `crew_manifest` to `CAPABILITY_HANDLERS` is the handler path, but current conductor calls `processActionableWorkOrder()` first and that function always returns a response object for non-fix actions (`/Users/alex/Desktop/Code/Kai Executive Assistant/scripts/conductor-agent.js:351`, `:384`, `:397`). `crew_manifest` would be acknowledged as `needs_manual_action`, not stored, unless dispatch order/classifier behavior changes.
- The proposed route is not action-scoped: `docs/proposal-crew-manifest-2026-05-20.md:135` describes `acd -> conductor action=crew_manifest`, but mesh permissions are keyed only by `(from_agent, to_agent)` (`/Users/alex/Desktop/Code/Kai Executive Assistant/scripts/mesh/mesh-api.js:120`, `:126`, `:285`). Adding Tier 1 `acd -> conductor` authorizes every ACD action to conductor, not just `crew_manifest`.
- Architecture audit overstates live-probe ground truth in several P0 places: `docs/architecture-current-state-2026-05-20.md:110` lists KMG in the 600s poll cohort, but `/agents` and the seed table show KMG at 300s (`mesh-api.js:271`); `docs/architecture-current-state-2026-05-20.md:132` and `:155` cite `/by-route?days=7`, but live mesh returns `{"error":"Not found"}` there and the working endpoint is `/stats?days=7`; `docs/architecture-current-state-2026-05-20.md:59` and `:256` say `sync-repos.sh` keeps both hub checkouts in sync, but Mini `sync-repos.sh:6-17` includes `~/kai` and `~/acd`, not `~/framer`, and Mini has no `~/Desktop/Code/ACD` or `~/Desktop/Code/Framer` directory. The 22 failure counts themselves were confirmed via `/stats?days=7`.

### Med (worth fixing before merge)
- Delete-then-insert needs a real transaction plus freshness guard: `docs/proposal-crew-manifest-2026-05-20.md:246`-`:248` can expose an empty/partial manifest to briefing reads and lets an older overlapping ACD emission clobber a newer one. The self-pass notes concurrency (`:431`) but accepts it; add `BEGIN IMMEDIATE`/single transaction and reject stale `generated_at` or repeated `source_message_id`.
- Crew-manifest loss when mesh send fails is not addressed: `docs/proposal-crew-manifest-2026-05-20.md:100` and `:344` rely on ACD emitting a second mesh message, but ACD's current `send_message()` only logs and returns `None` on failure (`/Users/alex/Desktop/Code/ACD/scripts/lib/mesh_client.py:180`-`:183`). ACD's CLAUDE promises a mesh outbox (`/Users/alex/Desktop/Code/ACD/CLAUDE.md:107`), but current scripts have no outbox implementation. Direct HTTP `production_strategy` calls can therefore succeed while the manifest silently never leaves ACD.
- Cost rates are stale for current Haiku: `docs/design-cost-and-universal-brain-2026-05-20.md:24` uses Haiku `$0.80/$4/$1/$0.08`, but Kai's model constant is `claude-haiku-4-5-20251001` (`model-router.js:9`) and Anthropic's current prompt-caching pricing lists Haiku 4.5 at `$1/$5/$1.25/$0.10` per MTok: https://platform.claude.com/docs/en/build-with-claude/prompt-caching. Because `logApiUsage()` collapses model ids to `HAIKU`/`SONNET` (`model-router.js:446`), the logs also lose version-level pricing evidence.
- The "$5/month from Kai alone" baseline is under-tuned: `docs/design-cost-and-universal-brain-2026-05-20.md:26`-`:28` projects from a quiet 7-day slice, but the same 1,820-entry log computes to about `$19.69` for the last 30 days and `$94.13` all-time with the repo's own rates. `docs/design-cost-and-universal-brain-2026-05-20.md:178` should not call `$5/month` current spend without labeling it "last-7-day run-rate."
- SQLite-vss is a risky default: `docs/design-cost-and-universal-brain-2026-05-20.md:258`-`:262` recommends it as "same DB, no daemon, performance fine," but the sqlite-vss README says it is not in active development and is pre-v1/breaking-change-prone: https://github.com/asg017/sqlite-vss. Also validate Apple Silicon install before choosing it, since the Mini is arm64.
- Prompt-cache savings are cadence-dependent: `docs/design-cost-and-universal-brain-2026-05-20.md:334`-`:342` assumes 5-minute cache reuse and a >50% target. Anthropic requires exact matching and 5-minute hits unless using paid 1-hour TTL; long agent runs or timestamp/schema drift can miss the cache. Add a long-session/1h-TTL branch and make the target contingent on measured identical-prefix reuse.
- Phase sequencing conflicts with CA authority language: `docs/proposal-crew-manifest-2026-05-20.md:492` says Phase 1 ends in "CA-internal DA -> auto-merge," but `CLAUDE.md:20` and `:33`-`:35` require explicit go-ahead for state-changing work, commits/pushes, first-time mesh contracts, and cross-repo changes. This should be "draft/stage after explicit approval," not auto-merge.

### Low (nice-to-have)
- `docs/design-cost-and-universal-brain-2026-05-20.md:145` says no new UI work is needed for `/api/costs` agent grouping, but adding `group_by`, `agent`, and model filters likely needs at least small dashboard controls or the feature will be API-only.
- `docs/architecture-current-state-2026-05-20.md:20` says "5 jobs" but names more than five CFO LaunchAgent jobs. Not load-bearing, just cleanup.

## Specific corrections requested
- `docs/architecture-current-state-2026-05-20.md:110` - replace "acd, nami, framer, chronicle, kmg" with "acd, nami, framer, chronicle; KMG is inactive at 300s."
- `docs/architecture-current-state-2026-05-20.md:132` and `:155` - replace `/by-route?days=7` with `/stats?days=7` / `by_route`.
- `docs/architecture-current-state-2026-05-20.md:59` and `:256` - replace the "keeps both trees in sync" claim with the exact `sync-repos.sh` scope; note `~/framer` is not synced by that script and Desktop ACD/Framer paths were absent on Mini.
- `docs/proposal-crew-manifest-2026-05-20.md:145` - add that `processMessage()` must route exact `CAPABILITY_HANDLERS[action]` before the generic work-order classifier, otherwise `handleCrewManifest` will not run.
- `docs/proposal-crew-manifest-2026-05-20.md:135` - state that mesh route permissions are route-wide, not action-scoped, and decide whether Tier 1 route-wide ACD->Conductor is acceptable.
- `docs/design-cost-and-universal-brain-2026-05-20.md:24` - update Haiku pricing or store exact model IDs in telemetry before calculating costs.
- `docs/design-cost-and-universal-brain-2026-05-20.md:258` - downgrade SQLite-vss from recommendation to candidate pending install/stability validation.

## Questions for Alex (only if BLOCKING for review completion)
- None.

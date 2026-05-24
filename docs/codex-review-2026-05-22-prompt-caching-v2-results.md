## Verdict (v2)
PASSED

## Status of each v1 concern

| # | v1 severity | v2 status | Notes |
|---|-------------|-----------|-------|
| 1 | HIGH | FIXED | Regression test passed: markers stayed at 1 across 3 simulated tool-loop calls. The strip loop leaves string content untouched during stripping, removes every own `cache_control` property from array blocks, and treats `undefined`, `{ type: 'ephemeral' }`, or any other value the same: if the property exists, it is deleted. It then places one fresh marker on the latest prior assistant message. |
| 2 | MED | FIXED | Backward scan from `length - 2` handles consecutive user messages. User-only history returns unchanged, which is right here: there is no completed assistant prefix to cache yet. In both call sites, the latest message before an Anthropic call is always user-role: Telegram pushes the current user before mapping and tool rounds append a user tool-result; dashboard pushes `userMsg` before the loop and appends user tool-results before the next round. So starting at `length - 2` does not miss a most-recent assistant in these paths. |
| 3 | MED | FIXED | `chat.diff` places `addHistoryCachePoint(messages)` before `if (streaming)`, so it covers both `messages.stream(...)` and `messages.create(...)` in the same loop. Target anchor still matches `scripts/routes/chat.js` around line 108; Telegram anchor still matches `scripts/bot/claude-processor.js` around line 341. I did find `scripts/lib/enrichment-pipeline.js` has its own bounded tool loop, but it is a fresh one-off enrichment prompt, not the Telegram/dashboard conversation-history surface this patch targets. |
| 4 | MED | FIXED | README verification no longer treats any `cache_read > 0` as proof. It now asks for a pre-patch 7-day baseline and post-patch comparison, with success tied to cache-read growth proportional to conversation history. |
| 5 | LOW | FIXED | Rollback is now a manual removal of the two integration lines plus helper deletion, not a brittle `git checkout HEAD~1`. |
| 6 | LOW | FIXED | Cost math now includes the Sonnet cache-write premium and first-call write-before-read behavior, and tells reviewers to judge at session turn 3+. |

## New concerns (if any)

### High (block apply)
- None.

### Med (worth fixing before apply)
- None.

### Low (nice-to-have)
- The README regression test catches marker accumulation, but it does not include the consecutive-user assertion described in the review prompt. The code path is still fixed by inspection; adding a small test with `[user, assistant, user, user]` would make that regression harder to reintroduce.
- `scripts/lib/enrichment-pipeline.js` is another Anthropic tool loop (`while (toolRound++ < 5)`), but it starts from a one-off enrichment prompt and is outside the stated conversation-history/cache-spend target. Consider it separately only if the goal expands to every tool loop.
- The helper strips all message-level `cache_control` markers. Today that is safe: current Kai production markers are only on system prompt and tools, outside `messages[]`. If a future call path intentionally owns a separate message-level marker, this helper would remove it.

## Regression test output

```text
After call 1, markers: 1
After call 2 (tool round 1), markers: 1
After call 3 (tool round 2), markers: 1

✓ Single-marker invariant holds.
```

## Greenlight conditions

Apply v2 as drafted. Caveats before/after apply: re-run the same regression test after copying the helper into Kai, then verify with multi-turn Telegram/dashboard sessions at turn 3+ rather than turn 1. Performance of the strip pass is negligible versus Anthropic latency, and mutation is safe in the reviewed call sites because `messages` is request-local and not the persisted history object.

## Verdict
REVISE

## Concerns by severity

### High (block apply)
- Message-level cache markers accumulate inside tool-use loops: `/Users/alex/Desktop/Code/Code Architect/docs/patch-prompt-caching-2026-05-20/prompt-cache.js:36` and `/Users/alex/Desktop/Code/Kai Executive Assistant/scripts/bot/claude-processor.js:341` — `addHistoryCachePoint(messages)` adds a marker to the current `messages[length-2]`, but never removes the marker it added on a prior loop iteration. Trace: first request has system + tools + 1 history marker = 3. After one tool round, the next request has 2 history markers = 4 total. If Claude asks for another tool round, the third request has 3 history markers plus system/tools = 5, over Anthropic's 4-breakpoint cap, so normal multi-tool workflows can 400. I reproduced the accumulation locally with the helper: message cache marker count went `1 -> 2 -> 3` across three calls.

### Med (worth fixing before apply)
- The helper misses normal Kai histories with consecutive user entries: `/Users/alex/Desktop/Code/Code Architect/docs/patch-prompt-caching-2026-05-20/prompt-cache.js:39` and `/Users/alex/Desktop/Code/Kai Executive Assistant/scripts/bot/callbacks/approvals.js:163` — approval callbacks append user-role `[SYSTEM]` notes without an assistant reply. On the next Telegram message, `messages[length-2]` can be that user note, so the role check no-ops even though an earlier assistant message is the intended reusable breakpoint.
- Dashboard chat is another multi-turn conversational path using the same `messages` pattern: `/Users/alex/Desktop/Code/Kai Executive Assistant/scripts/routes/chat.js:40`, `/Users/alex/Desktop/Code/Kai Executive Assistant/scripts/routes/chat.js:108`, `/Users/alex/Desktop/Code/Kai Executive Assistant/scripts/routes/chat.js:135`, `/Users/alex/Desktop/Code/Kai Executive Assistant/scripts/routes/chat.js:266` — it keeps `dashboardState.history`, appends the current user message, runs a tool loop, and persists user/assistant turns. Per the review prompt's scope check, Telegram-only is incomplete unless dashboard chat is explicitly accepted as a separate follow-up.
- The quick verification can produce a false positive: `/Users/alex/Desktop/Code/Code Architect/docs/patch-prompt-caching-2026-05-20/README.md:83` — `cache_read > 0` already happens from the existing system/tools cache. Also, for a fresh conversation the new history breakpoint is usually written before it can be read, so the first history-specific read may not appear until the next turn/tool continuation.

### Low (nice-to-have)
- Rollback instructions are a little brittle: `/Users/alex/Desktop/Code/Code Architect/docs/patch-prompt-caching-2026-05-20/README.md:131` — `git checkout HEAD~1 -- scripts/bot/claude-processor.js` is only safe if this patch is exactly the previous commit and no later edits touched the file. The text says that, but a manual two-line revert or a named patch revert would be less foot-gunny.
- Cost math is directionally sound but slightly idealized: `/Users/alex/Desktop/Code/Code Architect/docs/patch-prompt-caching-2026-05-20/README.md:19` — 10x savings on cache-read history tokens is correct, and a 30-50% Telegram total cut is plausible if history dominates. The README should mention cache-write premium and the one-turn write-before-read effect so the first few calls do not look disappointing.

## Specific corrections requested
- `/Users/alex/Desktop/Code/Code Architect/docs/patch-prompt-caching-2026-05-20/prompt-cache.js:36` — make `addHistoryCachePoint` enforce exactly one message-level `cache_control` marker per request. Before adding the new marker, scan `messages` and clone/remove any existing `cache_control` fields on message content blocks previously touched by the helper. Then add the fresh marker.
- `/Users/alex/Desktop/Code/Code Architect/docs/patch-prompt-caching-2026-05-20/prompt-cache.js:39` — target the last assistant message before the final message, not strictly `length - 2`, so user-only system notes from approval callbacks do not disable caching for the whole next turn.
- `/Users/alex/Desktop/Code/Code Architect/docs/patch-prompt-caching-2026-05-20/README.md:149` — add the accumulation bug to the risk/test section and include a small verification test that calls the helper across multiple simulated tool rounds and asserts there is never more than one `cache_control` marker under `messages`.
- `/Users/alex/Desktop/Code/Kai Executive Assistant/scripts/routes/chat.js:108` — either apply the same corrected helper before both dashboard `messages.stream(...)` and `messages.create(...)`, or document dashboard chat as a known excluded multi-turn path with a separate owner-approved follow-up. Under the prompt's stated review criteria, I would include it now.
- `/Users/alex/Desktop/Code/Code Architect/docs/patch-prompt-caching-2026-05-20/README.md:83` — change quick verification from "cache_read values > 0" to a comparison against pre-patch Telegram baseline and/or a check that `cache_creation`/`cache_read` grows by roughly the size of conversation history, not just the static system/tools cache.

## Greenlight conditions
Pass after the helper is made single-marker/idempotent across repeated tool rounds, the consecutive-user-history case is handled, and the dashboard multi-turn path is either patched or explicitly carved out with approval. After that, the diff anchors are valid: the require block is near the top of `claude-processor.js`, and the main `while (true)` / `anthropic.messages.create(...)` loop is at `/Users/alex/Desktop/Code/Kai Executive Assistant/scripts/bot/claude-processor.js:341`.

API compatibility checks passed: current Anthropic docs say prompt caching supports tool use and tool result content blocks in `messages.content`, the cap is 4 breakpoints, Sonnet 4.5's minimum is 1,024 tokens, and cache prefixes include everything up to the breakpoint. Kai's installed `@anthropic-ai/sdk@0.74.0` also types `cache_control` on `ToolUseBlockParam` and `ToolResultBlockParam`.

Sources checked:
- Anthropic prompt caching docs: https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- Local SDK types: `/Users/alex/Desktop/Code/Kai Executive Assistant/node_modules/@anthropic-ai/sdk/resources/messages/messages.d.ts:728` and `:801`

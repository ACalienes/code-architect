# Codex prompt — review prompt-caching patch (2026-05-21)

You are reviewing a Code Architect patch that adds a conversation-history cache breakpoint to Kai's Telegram message pipeline. Paste this entire file into Codex and let it run.

---

## Context

CA's session-4 architecture audit + cost design found that Kai already caches the static system prompt and tools array (cache hit ratio: 22.6%). What's NOT cached is the `messages[]` conversation history, which dominates input tokens on multi-turn Telegram sessions.

This patch adds ONE cache_control breakpoint at `messages[length-2]` (the last assistant message before each new user input). It's the smallest possible change with the biggest expected impact.

You already reviewed the broader design docs (Codex round on 2026-05-20, verdict REVISE → corrections applied). **Do not re-review those.** Your job here is the specific code in the patch — is it correct, safe, and complete enough to ship?

## Files to review

All paths absolute:

1. **`/Users/alex/Desktop/Code/Code Architect/docs/patch-prompt-caching-2026-05-20/prompt-cache.js`** — the new helper. ~50 lines. Read in full.
2. **`/Users/alex/Desktop/Code/Code Architect/docs/patch-prompt-caching-2026-05-20/claude-processor.diff`** — the two-line edit to `scripts/bot/claude-processor.js` in Kai. Read in full.
3. **`/Users/alex/Desktop/Code/Code Architect/docs/patch-prompt-caching-2026-05-20/README.md`** — application + verification + rollback. Read in full.

Then read the patch targets in Kai's repo to verify the edit will land where intended:

4. **`/Users/alex/Desktop/Code/Kai Executive Assistant/scripts/bot/claude-processor.js`** — focus on lines 220-370 (message assembly + the `while (true)` loop with `anthropic.messages.create()`). Verify the diff's anchor points exist as described.
5. **`/Users/alex/Desktop/Code/Kai Executive Assistant/scripts/lib/system-prompt.js:1402`** — the existing static-system cache_control marker. Confirms the cache_control pattern in use.
6. **`/Users/alex/Desktop/Code/Kai Executive Assistant/scripts/lib/kai-tools.js`** — the tools array with cache_control on its last block. Sanity-check the existing pattern.

## Review angles (priority order)

### P0 — Correctness of the helper

- **Index targeting.** Helper targets `messages[length - 2]`. Is that the right breakpoint position for both (a) the first iteration of a new user turn (where length-2 is the prior assistant response) AND (b) subsequent iterations within a tool-use loop (where length-2 is the just-pushed tool_use response, and length-1 is the just-pushed tool_result user message)? Trace both cases.
- **Role check.** Helper requires `target.role === 'assistant'`. Is there any case where length-2 is NOT an assistant in normal Kai flow? E.g., could conversation history start with two consecutive user messages somehow?
- **Mutation safety.** Helper clones target message and replaces `messages[idx]` with the clone. But conversationHistory is mapped at claude-processor.js:226-236 into a new `messages` array, and the helper is called on THAT array. So the original conversationHistory items aren't mutated. **Verify** that no other code path holds a reference to the same content array that the helper rewrites.
- **Content-block-array cloning.** When content is an array, helper does `[...content.slice(0,-1), {...lastBlock, cache_control: {...}}]`. Is shallow cloning the last block sufficient, or does the last block need a deep clone if it has nested fields (e.g., tool_use input)?

### P0 — Anthropic API compatibility

- **cache_control on tool_use blocks.** During a tool-use loop, the last assistant message has `content: [{type: 'tool_use', id, name, input}]`. The helper adds `cache_control: {type: 'ephemeral'}` to this block. **Verify** Anthropic's current API accepts cache_control on tool_use block types — not just text. Check the latest Anthropic SDK or API docs if uncertain.
- **4-breakpoint cap.** Anthropic allows up to 4 cache_control markers per request. Existing: 1 in system (system-prompt.js:1402), 1 in tools (kai-tools.js, last tool). With this patch, +1 in messages. Total 3 — safely under cap. **Verify** there isn't a hidden 4th breakpoint anywhere (e.g., in `loadSystemPrompt`, `getSemanticContext`, calendar pre-flight, corrections injection at claude-processor.js:283-318) that would push to 4.
- **Minimum cacheable tokens.** Sonnet requires 1024 tokens minimum for a cache block to be eligible. If `messages[length-2]` is a single short assistant message (e.g., a one-line tool-use call) and EVERYTHING BEFORE IT (system + tools + prior conversation) doesn't already sum past 1024... wait, actually the cache prefix is everything UP TO the breakpoint, not just the marked block. So this should be fine. Verify the interpretation.

### P0 — Diff anchor points

- The diff says "around line 341, the main message-create loop." Verify by reading claude-processor.js. The require block should be near the top. The `while (true)` loop should contain `anthropic.messages.create(...)` at around line 342. Confirm.
- The diff uses fuzzy line markers (`@@ around line 341 @@`) rather than exact line numbers because the file may shift. **Verify** that the patch's anchor lines (the `while (true)` and `response = await anthropic.messages.create(...)` calls) exist as quoted. If they've moved, flag it.

### P1 — Are there other call sites that should also get this treatment?

CA deliberately scoped this patch to ONLY the Telegram path. Per the investigation:
- Crons (`morning-briefing.js`, `eod-summary.js`, `daily-planner.js`, `dream-synthesis.js`) use single-string system prompts with no cache_control and no `messages[]` array (one-shot calls, no history).
- Other agents (ACD, Framer, etc.) have their own SDK call paths — out of scope.

**Verify** the Telegram-only scope by checking: is there any OTHER multi-turn conversational path in Kai that would benefit from this helper? E.g., is there a non-Telegram chat interface (Slack, dashboard chat) that also uses conversationHistory pattern?

If yes, the patch is incomplete — those paths would also benefit. Flag with file:line.

### P1 — Cost-math sanity check

The README claims:
- Cache hit ratio: 22.6% → 50-70%
- Telegram cost: ~$15/mo → ~$8-11/mo (30-50% cut)
- $5-7/mo savings

**Spot-check** the math:
- Sonnet pricing: $3/M input, $0.30/M cache_read, $3.75/M cache_create
- Assume a Telegram session at turn 10 with 25K-token history
- Without patch: turn 10 sends 25K @ $3/M = $0.075 just for history
- With patch (assuming cache hit): turn 10 reads 25K from cache @ $0.30/M = $0.0075 just for history
- 10× savings on history portion per turn

Does that line up with the 30-50% total bill cut? (History is one portion of total input; ratios depend on history-to-rest ratio.)

### P2 — README quality

- Are the apply / verify / rollback steps complete and runnable?
- Is the verification node snippet syntactically correct (it uses `\n` for newline in a multi-line string — verify the shell escaping is right)?
- Is the commit message proposed in the README appropriate (conventional commits prefix, body, co-author line)?

### P2 — Missing risks

CA listed 5 risks. Hunt for:
- A risk that's not in the list but should be
- A risk where CA's mitigation looks too breezy ("Very low" or "Low" likelihood claims without backing)

## Output format

```
## Verdict
PASSED | REVISE | REJECT

## Concerns by severity

### High (block apply)
- [concern]: [file:line] — [why this matters]

### Med (worth fixing before apply)
- [concern]: [file:line]

### Low (nice-to-have)
- [concern]: [file:line]

## Specific corrections requested
- [file:line] — change X to Y because Z

## Greenlight conditions
If verdict is REVISE, list the exact changes CA should make so the next review can be PASSED.
```

## Constraints

- **Read the actual code.** Don't review based on the README's description; read the helper and the diff.
- **Verify against the target file.** The patch only matters if claude-processor.js looks like the diff expects. Open it.
- **Be specific.** "Mutation might be unsafe" is not actionable. "messages[idx].content shares reference with conversationHistory[X].content because of Y, fix by Z" is actionable.
- **Don't propose architectural rewrites.** Scope is the patch as written.
- **Token-budget your output.** Target under 1,500 words.

---

*End of Codex prompt. Save Codex's reply to `/Users/alex/Desktop/Code/Code Architect/docs/codex-review-2026-05-21-prompt-caching-patch-results.md` so CA can act on it.*

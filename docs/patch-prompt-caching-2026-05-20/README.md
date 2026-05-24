# Patch — Prompt caching, conversation history breakpoint

**Author:** Code Architect (session 4, 2026-05-20 · revised 2026-05-21 after Codex review)
**Status:** DRAFT — ready for re-review then apply. CA cannot apply directly; `scripts/bot/**` and `scripts/routes/**` are `human_review_required` per Kai's owners.json.
**Target repo:** `/Users/alex/Desktop/Code/Kai Executive Assistant/`

---

## Revision history

- **v1 (2026-05-20)** — initial draft, Telegram path only. Helper added marker per call without removing prior ones.
- **v2 (2026-05-21)** — Codex review (REVISE) folded in:
  - **Fixed marker accumulation bug** — helper now strips any existing message-level `cache_control` before placing the new one. Single-marker invariant. Prevents Anthropic 4-breakpoint-cap violation on multi-tool flows.
  - **Fixed consecutive-user-message case** — helper scans backward from `length-2` to find the most recent assistant message instead of just checking the slot before the latest.
  - **Added dashboard chat path** — `scripts/routes/chat.js` has the same multi-turn pattern. Now patched alongside Telegram.
  - **Tightened verification** — baseline comparison instead of "cache_read > 0" check.
  - **Softer rollback** — manual two-line revert instead of `git checkout HEAD~1`.
  - **Cost math honesty** — call out the 25% cache-write premium and the write-before-read effect on first calls.

---

## What this does

Adds **one new cache breakpoint** to Kai's multi-turn message pipelines: caches the conversation history prefix at the most recent completed assistant message before each new user input. Two paths benefit:

- **Telegram bot** (`scripts/bot/claude-processor.js`) — 73% of Kai's spend per current telemetry
- **Dashboard chat** (`scripts/routes/chat.js`) — same multi-turn pattern, smaller volume

Today's cache hit ratio is **22.6%** — from the static system prompt (`scripts/lib/system-prompt.js:1402`) and the tools array (`kai-tools.js`, last block). Those work. What doesn't: the `messages[]` array, which grows with conversation history and re-sends at full input rate on every turn.

For an active 10-20 turn session, conversation history can be 20-40K tokens. After this patch, those tokens are read from cache at 10% of input rate (Sonnet: $0.30/M vs $3/M = 90% discount on the history portion).

## The single-marker invariant (why this matters)

The helper is called inside tool-use loops where `messages[]` grows each iteration. **Naive implementation would accumulate markers** (1 → 2 → 3 → ...) and combined with system + tools markers eventually exceed Anthropic's 4-breakpoint cap (request 400-rejected).

v2 of the helper enforces a single message-level marker by stripping any existing `cache_control` from `messages[]` content blocks before adding the new one. This is the architectural guarantee against accumulation — see `prompt-cache.js` docstring for the full invariant.

## Expected impact (now with honest math)

- **Cache hit ratio:** 22.6% → 50-70% on `telegram` and `dashboard` sources (target window: 1 week post-deploy)
- **Per-turn cost on multi-turn sessions:** ~30-50% reduction once warm
- **First turn of a fresh session:** slightly HIGHER cost than baseline (cache_write premium: Sonnet $3.75/M vs $3/M for the freshly-cached history bytes — a one-time 25% premium on those tokens)
- **Second turn and later within TTL:** big savings (cache_read at 10% of input rate)
- **Net effect at session scope:** ~30-50% cut once a session has 3+ turns within 5 min

**Important:** the first 1-2 calls of any new session will look disappointing in api-usage.jsonl — that's the cache-write phase, not the cache-read phase. Wait until session turn 3+ before judging.

## Files in this patch

| File | Action | Target path | Owners.json policy |
|------|--------|-------------|---------------------|
| `prompt-cache.js` | NEW | `scripts/lib/prompt-cache.js` | DA-gated, bypass eligible |
| `claude-processor.diff` | EDIT | `scripts/bot/claude-processor.js` | `human_review_required` |
| `chat.diff` | EDIT | `scripts/routes/chat.js` | `human_review_required` |

The helper file is small (~110 lines, mostly comments + one function). Each diff is two adds: one `require` near the top, one `addHistoryCachePoint(messages)` call directly before each `anthropic.messages.create()` or `anthropic.messages.stream()` call inside the tool-use loop.

## How to apply

```bash
cd /Users/alex/Desktop/Code/Kai\ Executive\ Assistant/

# 1. Drop the helper file into scripts/lib/
cp /Users/alex/Desktop/Code/Code\ Architect/docs/patch-prompt-caching-2026-05-20/prompt-cache.js \
   scripts/lib/prompt-cache.js

# 2. Open scripts/bot/claude-processor.js and apply the two edits from claude-processor.diff:
#    (a) Add `const { addHistoryCachePoint } = require('../lib/prompt-cache');` near the top.
#    (b) Inside the `while (true) { ... }` loop, add `addHistoryCachePoint(messages);` directly
#        before the `response = await anthropic.messages.create({...})` call.

# 3. Open scripts/routes/chat.js and apply the two edits from chat.diff:
#    (a) Add `const { addHistoryCachePoint } = require('../lib/prompt-cache');` near the top.
#    (b) Inside the `while (toolRound++ < MAX_TOOL_ROUNDS)` loop, add `addHistoryCachePoint(messages);`
#        directly before the `if (streaming)` branch. This catches BOTH the streaming and
#        non-streaming code paths in one place.

# 4. Restart Kai's PM2 process on Mini so the bot reloads:
ssh kai@100.64.114.13 'cd ~/kai && ./node_modules/.bin/pm2 restart kai-bot'

# 5. Stage and commit when you're satisfied (do NOT use --no-verify):
git add scripts/lib/prompt-cache.js scripts/bot/claude-processor.js scripts/routes/chat.js
git diff --cached  # review
git commit -m "perf(cache): conversation-history breakpoint for Telegram + dashboard

Previously only static system prompt and tools were cached (22.6% hit ratio).
Conversation history grew uncached, dominating input tokens on multi-turn sessions.
Adds one cache_control breakpoint at the most recent completed assistant message,
with single-marker invariant: helper strips any prior message-level cache_control
before placing the new one, preventing accumulation past Anthropic's 4-breakpoint
cap on multi-tool flows.

Both bot paths covered: scripts/bot/claude-processor.js (Telegram) and
scripts/routes/chat.js (dashboard).

Expected: cache hit ratio 22.6% → 50-70%, 30-50% per-session cost cut after warm-up.
First 1-2 calls of a session will show write-premium cost; reads kick in turn 3+.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

## How to verify

### Quick sanity check (right after restart)

```bash
cd /Users/alex/Desktop/Code/Kai\ Executive\ Assistant/

# Send Kai 5+ Telegram messages back-to-back. Then:
tail -10 logs/api-usage.jsonl | jq 'select(.source == "telegram") | {ts, input_tokens, cache_creation, cache_read, cache_ratio}'

# Look for: cache_creation > 0 on the first 1-2 entries (initial cache write),
# then cache_read climbing on the 3rd+ entry as the history prefix is reused.
# Specifically: cache_read should grow with the conversation depth.
```

### Real measurement (one week)

```bash
cd /Users/alex/Desktop/Code/Kai\ Executive\ Assistant/

# BEFORE applying the patch, capture baseline:
node -e "
const fs = require('fs');
const usage = fs.readFileSync('logs/api-usage.jsonl','utf8').trim().split('\n')
  .map(l=>{try{return JSON.parse(l)}catch{}}).filter(Boolean);
const cutoff = Date.now() - 7*24*3600*1000;
const tele = usage.filter(e => e.source === 'telegram' && new Date(e.ts).getTime() > cutoff);
let inTok=0, cacheR=0, cacheC=0;
for (const e of tele) { inTok+=e.input_tokens||0; cacheR+=e.cache_read||0; cacheC+=e.cache_creation||0; }
const total = inTok+cacheR+cacheC;
console.log('BASELINE Telegram 7d:');
console.log('  Calls:', tele.length);
console.log('  Cache hit ratio:', ((cacheR/total)*100).toFixed(1)+'%');
console.log('  Cache write tokens:', (cacheC/1000).toFixed(1)+'K');
console.log('  Cache read tokens:', (cacheR/1000).toFixed(1)+'K');
console.log('  Fresh input tokens:', (inTok/1000).toFixed(1)+'K');
" > /tmp/cache-baseline-before.txt

# Apply the patch + restart.

# 7 days later, run the same node block and compare. Success criteria:
#   - cache hit ratio risen to 50-70% (from ~22.6%)
#   - cache_read tokens grown by roughly the size of typical conversation history
#     (NOT just static-system-tools-prompt baseline)
#   - cache_creation tokens grown by ~history-size-per-turn (one cache write per new prefix)
```

### Accumulation-bug regression test

Codex flagged that v1 of the helper accumulated markers across tool-use loop iterations.
Verify v2's single-marker invariant before applying to production:

```bash
cd /Users/alex/Desktop/Code/Code\ Architect/

# Run this test against the patched helper:
node -e "
const { addHistoryCachePoint } = require('./docs/patch-prompt-caching-2026-05-20/prompt-cache.js');

// Simulate a 3-round tool-use flow:
let messages = [
  { role: 'user', content: 'Question 1' },
  { role: 'assistant', content: 'Answer 1' },
  { role: 'user', content: 'Question 2' },
];

function countMarkers(msgs) {
  let n = 0;
  for (const m of msgs) {
    if (Array.isArray(m.content)) {
      for (const b of m.content) if (b && b.cache_control) n++;
    }
  }
  return n;
}

addHistoryCachePoint(messages);
console.log('After call 1, markers:', countMarkers(messages));  // expect 1

// Simulate tool-use loop: assistant tool_use + user tool_result pushed.
messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'tool', input: {} }] });
messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'result' }] });
addHistoryCachePoint(messages);
console.log('After call 2 (tool round 1), markers:', countMarkers(messages));  // expect 1, not 2

// Another tool round.
messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: 'tu_2', name: 'tool', input: {} }] });
messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_2', content: 'result' }] });
addHistoryCachePoint(messages);
console.log('After call 3 (tool round 2), markers:', countMarkers(messages));  // expect 1, not 3

if (countMarkers(messages) === 1) {
  console.log('\\n✓ Single-marker invariant holds.');
  process.exit(0);
} else {
  console.log('\\n✗ FAILED — marker accumulation detected. DO NOT APPLY.');
  process.exit(1);
}
"
```

Expected output:

```
After call 1, markers: 1
After call 2 (tool round 1), markers: 1
After call 3 (tool round 2), markers: 1

✓ Single-marker invariant holds.
```

If this fails, the helper still has the accumulation bug and the patch must not be applied.

## How to roll back

Three steps, fully reversible. Done manually (safer than `git checkout HEAD~1` which is only safe if no other commits touched these files):

```bash
cd /Users/alex/Desktop/Code/Kai\ Executive\ Assistant/

# 1. Open scripts/bot/claude-processor.js. Remove:
#    - The `require('../lib/prompt-cache')` line near the top
#    - The `addHistoryCachePoint(messages);` line inside the while loop

# 2. Open scripts/routes/chat.js. Remove the same two lines.

# 3. Delete the helper file:
rm scripts/lib/prompt-cache.js

# 4. Restart:
ssh kai@100.64.114.13 'cd ~/kai && ./node_modules/.bin/pm2 restart kai-bot'

# 5. (optional) commit the revert:
git add scripts/lib/prompt-cache.js scripts/bot/claude-processor.js scripts/routes/chat.js
git diff --cached  # confirm 3 files are reverted
git commit -m "revert: prompt-cache history breakpoint patch"
```

No data migration. No state to clean up. The `api-usage.jsonl` log will simply stop showing the increased cache hits.

## What this patch does NOT do (intentionally, scope discipline)

- **Does not upgrade TTL to 1 hour.** Codex v1 review flagged 1h-TTL is contingent on measured reuse patterns. We don't have post-patch data yet. Defer 1 week.
- **Does not restructure tools to fix queryType cache invalidation.** Separate, bigger lift. The existing tools cache works when queryType stays constant in a session.
- **Does not touch cron paths.** Daily-firing crons can't benefit from 5-min cache. 1h-TTL would cost more than it saves at once-per-day cadence.
- **Does not touch any other agent.** ACD, Framer, Enso, OA, PDE, etc. each have their own SDK call paths — separate, larger proposal per the cost-design doc Phase 1.

## Risks (v2 list — Codex-reviewed)

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| ~~Marker accumulation past 4-breakpoint cap on multi-tool flows~~ | Was HIGH in v1 | **FIXED in v2** — helper strips prior cache_control before adding new one. Regression test included above. |
| Helper modifies messages in a way that breaks downstream code | Low | Helper clones the targeted message + array element. Original conversationHistory upstream is untouched (callers map() into new array before passing here — verified at claude-processor.js:226 and chat.js:40). |
| cache_control on a tool_use block triggers an Anthropic API rejection | Very low | Codex verified SDK v0.74.0 types cache_control on ToolUseBlockParam + ToolResultBlockParam. |
| Conversation history has heavy per-turn variation in early messages | Low | User messages are short text; not embedded timestamps. Verifiable in api-usage.jsonl post-patch. |
| First 1-2 calls of a session look more expensive (cache_write premium) | EXPECTED | Document in the verification block above — judge at session turn 3+, not turn 1. |
| Cache misses dominated by queryType changes mid-conversation (different tool subset) | Med | History cache breakpoint is independent of tools cache. Even if tools change, history can still hit its own cache. |

## Authority + sign-off

Per CLAUDE.md HB#1, this v2 patch requires your explicit go-ahead before any commit. CA has staged the files in `docs/patch-prompt-caching-2026-05-20/` and made zero changes to Kai's working tree. Your move:

1. Optionally: re-submit to Codex for a confirmation pass (verdict-flip from REVISE to PASSED).
2. Read README, helper, both diffs.
3. Run the accumulation-bug regression test locally — confirm `✓ Single-marker invariant holds.`
4. Authorize application — CA SSHes, copies, edits, restarts PM2, shows you `git diff`, stops short of commit.
5. You commit when satisfied.

---

*v2 of the patch — Codex review applied. Single change to two paths. Measure for a week, then revisit the 1h-TTL question.*

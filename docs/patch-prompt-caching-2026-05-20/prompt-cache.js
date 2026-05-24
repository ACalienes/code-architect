// scripts/lib/prompt-cache.js
//
// Helper for Anthropic prompt-cache breakpoint placement on conversation history.
//
// Why: Kai's bot paths already cache the static system prompt (system-prompt.js:1402)
// and the tools array (kai-tools.js, last tool). That's the source of the current
// ~22.6% cache hit ratio. What's NOT cached is the messages[] array — conversation
// history. For 10–20 turn sessions, history dominates input tokens. This helper
// adds ONE cache_control breakpoint at the last completed assistant message before
// the current input. Anthropic's recommended pattern for chat apps.
//
// CRITICAL INVARIANT — single marker, idempotent across repeated calls:
//   The helper is called inside tool-use loops where messages[] grows each iteration.
//   If we just added a new marker each call without removing the old one, multi-tool
//   flows would accumulate: 1 marker → 2 → 3 → ... eventually exceeding Anthropic's
//   4-breakpoint-per-request cap (1 system + 1 tools + 3 history = 5 → API 400).
//   So this helper STRIPS any existing cache_control from messages content blocks
//   before adding the new marker. Result: exactly one message-level marker at all times.
//   (System + tools markers live OUTSIDE messages[] — not touched by this stripper.)
//
// HISTORY CONSIDERATIONS:
//   Some Kai paths (approval callbacks at scripts/bot/callbacks/approvals.js:163)
//   append user-role [SYSTEM] notes without an assistant reply. So messages[length-2]
//   may be a user message. The helper scans BACKWARD from length-2 to find the
//   most recent assistant message — not just checking the immediately preceding slot.
//
// MUTATION CONTRACT:
//   The helper rewrites entries of the `messages` array in place (replacing items
//   with cloned versions that have/lack cache_control). The original conversationHistory
//   objects upstream are not mutated because callers map() into a new array before
//   passing it here (see claude-processor.js:226 and chat.js:40).
//
// No-op when:
//   - messages is empty or has < 2 entries
//   - no assistant message exists earlier in history
//   - content shape is unknown (defensive)
//
// Anthropic prompt-cache cap: up to 4 cache_control breakpoints per request. With
// system + tools + history we use 3 — safely under cap. The strip-then-set pattern
// is the architectural guarantee that we never exceed this.
//
// Verified compatible with @anthropic-ai/sdk@0.74.0 (Kai's installed version):
// cache_control is typed on ToolUseBlockParam and ToolResultBlockParam in
// node_modules/@anthropic-ai/sdk/resources/messages/messages.d.ts.

'use strict';

/**
 * Add a single cache_control breakpoint to the most recent assistant message
 * in the history (excluding the latest message). Strips any prior cache_control
 * markers under messages[] first so the request always has exactly one
 * message-level marker — preventing accumulation across tool-use loop iterations.
 *
 * @param {Array<{role: string, content: string | Array}>} messages
 *   The messages array passed to anthropic.messages.create() / stream().
 *   Mutated in place (specific elements are replaced with clones).
 * @returns {Array} the same messages array reference.
 */
function addHistoryCachePoint(messages) {
  if (!Array.isArray(messages) || messages.length < 2) return messages;

  // STEP 1 — strip any existing cache_control markers under messages[].
  // This is the architectural guarantee against accumulation. Anthropic's 4-breakpoint
  // cap is enforced here: by always removing prior markers, we ensure exactly one
  // message-level marker per request.
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m || !Array.isArray(m.content)) continue;
    let dirty = false;
    const cleaned = m.content.map((block) => {
      if (block && Object.prototype.hasOwnProperty.call(block, 'cache_control')) {
        dirty = true;
        const cloned = { ...block };
        delete cloned.cache_control;
        return cloned;
      }
      return block;
    });
    if (dirty) messages[i] = { ...m, content: cleaned };
  }

  // STEP 2 — find the most recent assistant message in history, scanning backward
  // from length-2 (length-1 is the current/latest input we want to cache UP TO).
  // Walking backward handles the approval-callback case where messages[length-2]
  // is a user-role [SYSTEM] note rather than an assistant reply.
  let idx = -1;
  for (let i = messages.length - 2; i >= 0; i--) {
    if (messages[i] && messages[i].role === 'assistant') {
      idx = i;
      break;
    }
  }
  if (idx === -1) return messages; // no assistant in history → no breakpoint to place

  // STEP 3 — add cache_control to the last content block of the target message.
  const target = messages[idx];
  let content = target.content;

  if (typeof content === 'string') {
    content = [{ type: 'text', text: content, cache_control: { type: 'ephemeral' } }];
  } else if (Array.isArray(content) && content.length > 0) {
    const lastBlock = content[content.length - 1];
    const lastBlockWithCache = { ...lastBlock, cache_control: { type: 'ephemeral' } };
    content = [...content.slice(0, -1), lastBlockWithCache];
  } else {
    return messages; // unknown content shape — skip safely
  }

  messages[idx] = { ...target, content };
  return messages;
}

module.exports = { addHistoryCachePoint };

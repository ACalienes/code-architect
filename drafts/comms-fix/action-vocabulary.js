'use strict';
/**
 * action-vocabulary.js — shared dispatch-action validator (Phase A, v1).
 *
 * DRAFT (Code Architect, 2026-05-26). Staged for Alex's apply-approval; destined for
 * Kai repo `scripts/lib/action-vocabulary.js` (the cross-fleet helper lane in owners.json).
 *
 * Purpose: give senders + receivers ONE place to check that a dispatch action is valid for
 * its target, BEFORE it dies silently at the receiver (see docs/impl-action-validation + the
 * 2026-05-26 CFO empty-action case, docs/intake-kai-agent-org-buildout).
 *
 * Design invariants (DA-gated — these are the safety contract):
 *  - FAIL-OPEN. A missing/unreadable registry, or an unregistered agent, NEVER blocks traffic.
 *    The validator is advisory hardening, not a runtime dependency.
 *  - The ONLY hard block is an empty/whitespace action — that is unambiguously a bug
 *    (zero false positives), and is exactly the gap the legacy filesystem-drop channel has.
 *  - "Unrecognized but non-empty" is a WARN, not a block, in v1 — because reads are
 *    keyword-matchable (e.g. CFO maps "give me cash summary" -> cash_summary), so strict
 *    membership would false-reject legitimate free-text. Strict-block is opt-in per action
 *    (registry `match:"exact"` / agent `strict:true`) and only after a clean warn window.
 *  - No external deps (mesh is polyglot; keep this trivially portable).
 *
 * Returns: { ok, code?, warn?, known?, resolved? }
 *   ok:false  -> caller MUST reject/escalate loudly (never dispatch).
 *   warn set  -> caller SHOULD log to a SURFACED channel (not a dead inbox file).
 */

const fs = require('fs');
const path = require('path');

// Resolution order (first hit wins). Fixes Codex Finding 3: the committed registry under
// knowledge/manifests is now found relative to the module even without an env/home copy.
// Deploy step: the committed source-of-truth (knowledge/manifests/action-vocabulary.json) is
// synced to the canonical runtime path (~/.kameha/action-vocabulary.json) so all agents read it.
const DEFAULT_REGISTRY_PATHS = [
  process.env.ACTION_VOCABULARY_PATH,
  path.join(process.env.HOME || '', '.kameha', 'action-vocabulary.json'),                  // canonical runtime
  path.join(__dirname, '..', '..', 'knowledge', 'manifests', 'action-vocabulary.json'),    // committed source (from scripts/lib/)
  path.join(__dirname, 'action-vocabulary.json'),                                          // colocated (draft/dev)
];

let _cache = null;
let _cacheMtime = 0;

function loadRegistry(explicitPath) {
  const candidates = explicitPath ? [explicitPath] : DEFAULT_REGISTRY_PATHS;
  for (const p of candidates) {
    if (!p) continue;
    try {
      const stat = fs.statSync(p);
      if (_cache && p === _cache.__path && stat.mtimeMs === _cacheMtime) return _cache;
      const reg = JSON.parse(fs.readFileSync(p, 'utf8'));
      reg.__path = p;
      _cache = reg;
      _cacheMtime = stat.mtimeMs;
      return reg;
    } catch (_) { /* try next */ }
  }
  return null; // fail-open: caller treats null as REGISTRY_UNAVAILABLE
}

function _norm(action) {
  return String(action == null ? '' : action).toLowerCase().trim();
}

/** Mirror the receivers' simple resolution: exact capability name, then keyword token match. */
function _resolves(agentSpec, normAction) {
  const accepts = agentSpec.accepts || [];
  // 1. exact name (snake or space form)
  for (const cap of accepts) {
    const c = String(cap).toLowerCase();
    if (normAction === c || normAction === c.replace(/_/g, ' ')) return cap;
  }
  // 2. keyword token match (reads only) — registry may carry the agent's keyword map
  const tokens = normAction.split(/[^a-z0-9]+/).filter(Boolean);
  const km = agentSpec.keyword_map || {};
  for (const [keyword, cap] of Object.entries(km)) {
    const kwTokens = keyword.toLowerCase().split(/\s+/);
    if (kwTokens.every(kt => tokens.includes(kt))) return cap;
  }
  return null;
}

/**
 * validateDispatchAction(to, action, opts?)
 * @param {string} to       receiver agent id
 * @param {string} action   the dispatch action the receiver will switch on
 * @param {object} [opts]   { registryPath, strict }
 */
function validateDispatchAction(to, action, opts = {}) {
  const norm = _norm(action);
  if (!norm) return { ok: false, code: 'ACTION_EMPTY' };

  const reg = loadRegistry(opts.registryPath);
  if (!reg || !reg.agents) return { ok: true, warn: 'REGISTRY_UNAVAILABLE' };

  const agentSpec = reg.agents[to];
  if (!agentSpec) return { ok: true, warn: 'AGENT_NOT_REGISTERED' };

  const resolved = _resolves(agentSpec, norm);
  if (resolved) return { ok: true, resolved };

  const known = agentSpec.accepts || [];
  const strict = opts.strict || agentSpec.strict === true;
  if (strict) return { ok: false, code: 'ACTION_NOT_ACCEPTED', known };
  return { ok: true, warn: 'ACTION_UNRECOGNIZED', known };
}

module.exports = { validateDispatchAction, loadRegistry, _resolves };

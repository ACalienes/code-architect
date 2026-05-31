'use strict';
/**
 * board-consume-cfo — CFO's Board consumer (Phase 3, first per-agent handler).
 *
 * Closes the loop: an Alex approval on the supervisor view (a `supervisor_decision: approve` on a
 * CFO draft) reaches CFO and is SURFACED AS READY-TO-SEND — it is NEVER auto-sent. The Board approval
 * is the AUTHORIZATION; the actual money-movement send stays a final human tap in CFO. (Binding decision
 * 2026-05-29; design §12.4. The standing "never auto-send payment" rule, made structural.)
 *
 * WHY this can't auto-send (DA, §12.7): this module has NO payment primitive. Its only outward effects
 * are (a) writing a local `<draft>.ready.json` provenance sidecar and (b) publishing a status_update
 * back to the Board. Neither moves money. There is no code path here from "approve" to "send".
 *
 * Hosting: runs LAPTOP-SIDE (CFO drafts are laptop-local at ~/Desktop/Code/CFO/logs/drafts/), polling
 * the Mini gateway over Tailscale — same shape as board-emit-cfo.js in REMOTE mode.
 *
 * Routing: CFO subscribes to `supervisor_decision` (subscription-based router). Every subscriber gets
 * ALL of them, so the handler SELF-FILTERS by subject authorship (§12.1 / design §6 defense-in-depth):
 * it acts only when the decided fact was emitted by CFO.
 *
 * Run:   BOARD_URL=http://100.64.114.13:3351 node board-consume-cfo.js            # poll loop
 *        BOARD_URL=... node board-consume-cfo.js --once                           # single tick (cron/test)
 *        CFO_DIR=/path/to/CFO ...                                                 # override drafts root
 */
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { runConsumer, processInboxOnce, makeGatewayClient } = require('./board-consume-lib');
const { postFact } = require('./board-post');

const PERMANENT_POST = new Set([400, 401, 403, 409, 422]);  // mirror board-emit-cfo: these never self-heal

/**
 * Build CFO's handler map. Pure + injectable for tests:
 *   - cfoDir       : CFO repo root (drafts under <cfoDir>/logs/drafts)
 *   - publish      : async ({fact, idempotencyKey}) => { status } — the Board echo (defaults to postFact)
 *   - now          : () => ISO string (injectable so tests are deterministic)
 *   - fsImpl       : node:fs-like (existsSync, writeFileSync) — defaults to real fs
 */
function makeCfoHandlers({ cfoDir, publish, now = () => new Date().toISOString(), fsImpl = fs } = {}) {
  if (!cfoDir) throw new Error('makeCfoHandlers: cfoDir required');
  const draftsRoot = path.resolve(cfoDir, 'logs', 'drafts');

  // Resolve a draft_ref to an absolute path, refusing anything that escapes <cfoDir>/logs/drafts or
  // isn't a .json draft. draft_ref comes from a trusted (authorization-grade) fact, but path-traversal
  // defense is cheap and absolute — a bad ref must never let an approval touch a file outside drafts.
  function resolveDraft(draftRef) {
    if (typeof draftRef !== 'string' || !draftRef) return null;
    const abs = path.resolve(cfoDir, draftRef);
    if (abs !== draftsRoot && !abs.startsWith(draftsRoot + path.sep)) return null;  // outside drafts dir
    if (!abs.endsWith('.json') || abs.endsWith('.ready.json')) return null;          // not a draft file
    return abs;
  }

  async function onSupervisorDecision(d, ctx) {
    const log = (ctx && ctx.log) || (() => {});
    const payload = d.payload || {};
    const decision = payload.decision;
    const context = payload.context || {};

    // Provenance sanity — supervisor_decision is authorization-grade; only alex+supervise can publish it.
    // If something else somehow delivered one, refuse to act (surface it). Should be unreachable.
    if (d.source_agent && d.source_agent !== 'alex') {
      return { ok: false, permanent: true, reason: `supervisor_decision from non-alex source '${d.source_agent}'` };
    }

    // Only approvals authorize CFO surfacing. reject/dismiss need no CFO action → ack-noop.
    if (decision !== 'approve') { log(`cfo: decision='${decision}' on ${payload.subject_fact_id} — no CFO action, ack`); return { ok: true }; }

    // Self-filter: act only on CFO's OWN draft. Other agents' approvals are not ours → ack-noop (never spin).
    if (context.subject_source_agent !== 'cfo') { log(`cfo: approval on ${context.subject_source_agent || '?'}'s subject — not ours, ack`); return { ok: true }; }

    const abs = resolveDraft(context.draft_ref);
    if (!abs) return { ok: false, permanent: true, reason: `approved cfo draft has no resolvable draft_ref (got '${context.draft_ref}')` };
    if (!fsImpl.existsSync(abs)) return { ok: false, permanent: true, reason: `approved draft file missing: ${context.draft_ref}` };

    // Symlink-escape defense (Codex Phase-3 finding #2): lexical path.resolve + prefix checks DON'T catch a
    // symlinked dir/file under logs/drafts that points outside. realpath BOTH the drafts root and the actual
    // draft, and require the resolved draft to live inside the resolved root — else a sidecar write could
    // land outside the tree.
    let realRoot, realAbs;
    try { realRoot = fsImpl.realpathSync(draftsRoot); realAbs = fsImpl.realpathSync(abs); }
    catch (_) { return { ok: false, permanent: true, reason: `cannot realpath approved draft: ${context.draft_ref}` }; }
    if (realAbs !== realRoot && !realAbs.startsWith(realRoot + path.sep)) {
      return { ok: false, permanent: true, reason: `approved draft resolves outside drafts root (symlink escape?): ${context.draft_ref}` };
    }
    // Re-check the suffix AFTER realpath (Codex Phase-3 round 3): the lexical check ran on draft_ref, but a
    // symlink `alias.json -> notes.txt` resolves to a non-.json target, and `readyPath` (computed from
    // realAbs below) would then equal that target and OVERWRITE it. Reject any draft that really resolves to
    // a non-draft file.
    if (!realAbs.endsWith('.json') || realAbs.endsWith('.ready.json')) {
      return { ok: false, permanent: true, reason: `approved draft resolves to a non-draft file (symlink to ${path.basename(realAbs)}?): ${context.draft_ref}` };
    }

    // (a) Local READY marker — authoritative ready-to-send signal in CFO's own workflow. Money is NOT sent
    //     here. `approved_at` is stamped from the DELIVERY creation time (stable), NOT retry time, so a
    //     transient-echo retry can't drift the provenance timestamp (Codex Phase-3 finding #3).
    const readyPath = realAbs.replace(/\.json$/, '.ready.json');
    // Refuse a pre-planted symlink AT the sidecar path; the temp+rename below also replaces (never follows)
    // any existing symlink there, so an attacker can't redirect the write out of the tree.
    try { if (fsImpl.lstatSync(readyPath).isSymbolicLink()) return { ok: false, permanent: true, reason: 'ready sidecar path is a symlink — refusing' }; } catch (_) { /* ENOENT = clean */ }
    const provenance = {
      schema_version: 1, status: 'ready_to_send', draft_ref: context.draft_ref, approved: true, by: 'alex',
      decision_fact_id: d.fact_id, subject_fact_id: payload.subject_fact_id,
      supervisor_action_id: payload.supervisor_action_id, approved_at: d.created_at || now(),
      note: 'Board approval = authorization to send. The actual send still requires a final human tap in CFO.',
    };
    // Write via an EXCLUSIVE, NO-FOLLOW temp file, then atomic rename (Codex Phase-3 round 2). A
    // predictable temp path could itself be a pre-planted symlink that writeFileSync would follow out of
    // the tree, with the rename then moving that symlink into the sidecar slot. Defenses: (1) unguessable
    // temp name; (2) O_CREAT|O_EXCL refuses to open an existing path — including a symlink — so a planted
    // temp can't be written through; (3) O_NOFOLLOW belt-and-suspenders. rename replaces (never follows)
    // any symlink that races into readyPath after the earlier lstat, so the TOCTOU window is closed too.
    const C = fsImpl.constants || fs.constants;
    const wxFlags = C.O_CREAT | C.O_EXCL | C.O_WRONLY | (C.O_NOFOLLOW || 0);
    const tmpPath = `${readyPath}.tmp-${randomBytes(8).toString('hex')}`;
    try {
      const fd = fsImpl.openSync(tmpPath, wxFlags, 0o600);
      try { fsImpl.writeSync(fd, JSON.stringify(provenance, null, 2)); }
      finally { fsImpl.closeSync(fd); }
      fsImpl.renameSync(tmpPath, readyPath);
    } catch (e) {
      try { fsImpl.unlinkSync(tmpPath); } catch (_) { /* nothing to clean */ }
      return { ok: false, permanent: true, reason: `failed to write READY sidecar safely: ${e && e.message}` };
    }
    log(`cfo: marked READY → ${path.basename(readyPath)}`);

    // (b) Board echo — so the supervisor surfaces "READY TO SEND (needs your final tap)". Idempotent key.
    const title = path.basename(abs, '.json').replace(/[-_]/g, ' ');
    let r;
    try {
      r = await publish({
        idempotencyKey: `cfo:ready:${context.draft_ref}`,
        fact: { fact_type: 'status_update', visibility: 'internal', data_class: 'internal',
          subject_type: 'finance', subject_id: 'cfo-draft',
          payload: { status: 'ready_to_send', detail: `${title} — READY TO SEND (needs your final tap)`, draft_ref: context.draft_ref } },
      });
    } catch (e) {
      // Local READY is already written (authoritative). Leave un-acked so the next tick retries the echo;
      // both the sidecar write and the echo are idempotent, so at-least-once is safe.
      return { ok: false, reason: `board echo network error: ${e && e.message} (READY marker written; will retry)` };
    }
    if (r && r.status === 200) return { ok: true };
    if (r && PERMANENT_POST.has(r.status)) return { ok: false, permanent: true, reason: `board echo rejected ${r.status} (READY marker written)` };
    return { ok: false, reason: `board echo transient ${r && r.status} (READY marker written; will retry)` };
  }

  return { supervisor_decision: onSupervisorDecision };
}

module.exports = { makeCfoHandlers };

// ── CLI entry ─────────────────────────────────────────────────────────────────────────────────────
if (require.main === module) {
  const HOME = process.env.HOME;
  const CFO_DIR = process.env.CFO_DIR || path.join(HOME, 'Desktop', 'Code', 'CFO');
  const url = process.env.BOARD_URL;
  if (!url) { console.error('[consume-cfo] BOARD_URL required (e.g. http://100.64.114.13:3351)'); process.exit(2); }
  const token = (process.env.BOARD_TOKEN ||
    fs.readFileSync(path.join(HOME, '.kameha', 'board-gateway.tokens', 'cfo'), 'utf8')).trim();

  // The Board echo publishes through the gateway under CFO's own token (publish scope).
  const publish = ({ fact, idempotencyKey }) => postFact({ url, token, fact, idempotencyKey });
  const handlers = makeCfoHandlers({ cfoDir: CFO_DIR, publish });
  const onLog = m => console.log(`[consume-cfo] ${m}`);

  if (process.argv.includes('--once')) {
    const client = makeGatewayClient({ url, token });
    processInboxOnce({ client, handlers, ctxExtras: { leaseS: 300 }, onLog })
      .then(s => { console.log(`[consume-cfo] once: ${JSON.stringify(s)}`); process.exit(0); })
      .catch(e => { console.error('[consume-cfo] once error:', e.message); process.exit(1); });
  } else {
    runConsumer({ agent: 'cfo', url, token, handlers, onLog });
    console.log(`[consume-cfo] polling ${url} for cfo every 30s (drafts: ${CFO_DIR})`);
  }
}

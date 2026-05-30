'use strict';
/**
 * board-consume-lib — the generic Board consumer loop (Phase 3 backbone).
 *
 * A per-agent consumer polls its OWN inbox through the gateway and drives each delivery through the
 * claim → handle → ack lifecycle the gateway enforces. This module is PURE orchestration: it never
 * executes an external action itself — it dispatches to a registered handler by fact_type and records
 * the outcome via the gateway (ack on success, quarantine on permanent failure, leave-for-retry on
 * transient failure). publish/consume != act: the ACTING happens inside a handler the per-agent wrapper
 * supplies (e.g. board-consume-cfo.js), and that handler owns the action-ledger / at-most-once discipline.
 *
 * Design: docs/design-board-consume-gateway-2026-05-28.md §5–§6 (+ v2 claim/lease fold).
 * Security posture inherited from the gateway: identity is the token's; an agent only ever sees its own
 * deliveries; the per-instance claim_id is the single-executor lock.
 *
 * Testability: the gateway client is injectable. processInboxOnce({client, handlers}) runs exactly one
 * tick against any client (real HTTP or an in-memory fake), so the loop logic is unit-tested with no
 * network. runConsumer() wires a real client + setInterval on top.
 */
const { randomUUID } = require('node:crypto');
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Build an HTTP client bound to one gateway URL + token. Each method returns { status, ...json }. */
function makeGatewayClient({ url, token, fetchImpl, retries = 2 }) {
  if (!url) throw new Error('gateway client: url required');
  if (!token) throw new Error('gateway client: token required');
  const doFetch = fetchImpl || globalThis.fetch;
  if (!doFetch) throw new Error('gateway client: no fetch available (Node 18+ or pass fetchImpl)');
  const base = url.replace(/\/+$/, '');
  const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  async function call(method, path, body) {
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await doFetch(base + path, { method, headers: auth, body: body ? JSON.stringify(body) : undefined });
        let json = {}; try { json = await r.json(); } catch (_) {}
        if (r.status >= 500 && attempt < retries) { await sleep(250 * (attempt + 1)); continue; }
        return { status: r.status, ...json };
      } catch (e) {
        if (attempt < retries) { await sleep(250 * (attempt + 1)); continue; }
        return { status: 0, ok: false, error: String(e && e.message || e) };  // network error → caller treats as transient
      }
    }
  }
  return {
    inbox: (limit = 50) => call('GET', `/inbox?limit=${encodeURIComponent(limit)}`),
    claim: (id, leaseS, claimId) => call('POST', `/claim/${encodeURIComponent(id)}?lease=${encodeURIComponent(leaseS)}${claimId ? `&claim_id=${encodeURIComponent(claimId)}` : ''}`),
    ack:   (id, body = {}) => call('POST', `/ack/${encodeURIComponent(id)}`, body),
    quarantine: (id, body) => call('POST', `/quarantine/${encodeURIComponent(id)}`, body),
  };
}

/**
 * Run ONE consume tick: pull the inbox and process each delivery independently. Returns stats.
 * Per-delivery flow:
 *   - no handler for fact_type → SKIP (do NOT claim — leave it for whoever owns that type; never spin on it).
 *   - claim: 200 → we hold it (claim_id); 409/410/403 → SKIP (another instance/acked/dead).
 *   - handler {ok:true}             → ACK.
 *   - handler {ok:false, permanent} → QUARANTINE (durable, surfaced; not retried).
 *   - handler {ok:false}            → LEAVE (transient; lease expires, retried next tick).
 *   - handler throws                → LEAVE, but if delivery_attempts >= maxAttempts → QUARANTINE (anti-poison-pill).
 * A handler failure on one delivery never stops the rest of the page.
 */
async function processInboxOnce({ client, handlers, ctxExtras = {}, onLog = () => {}, maxAttempts = 5, limit = 50 }) {
  const stats = { fetched: 0, acked: 0, quarantined: 0, left: 0, skipped: 0, claim_conflicts: 0 };
  const inbox = await client.inbox(limit);
  if (inbox.status !== 200 || !Array.isArray(inbox.deliveries)) {
    onLog(`inbox fetch failed: status=${inbox.status} ${inbox.error || ''}`);
    return { ...stats, error: inbox.error || `status ${inbox.status}` };
  }
  stats.fetched = inbox.deliveries.length;

  for (const d of inbox.deliveries) {
    const handler = handlers[d.fact_type];
    if (typeof handler !== 'function') { stats.skipped++; onLog(`no handler for fact_type='${d.fact_type}' (delivery ${d.delivery_id}) — skipped`); continue; }

    const claim = await client.claim(d.delivery_id, ctxExtras.leaseS || 300);
    if (claim.status !== 200) {
      if (claim.status === 409) stats.claim_conflicts++; else stats.skipped++;
      onLog(`claim ${d.delivery_id} → ${claim.status} (${claim.error || 'held/acked/dead'}) — skipped`);
      continue;
    }

    const ctx = { delivery: d, agent: inbox.agent, claim_id: claim.claim_id, log: onLog, ...ctxExtras };
    try {
      const res = await handler(d, ctx) || {};
      if (res.ok) {
        const a = await client.ack(d.delivery_id, { logged: res.logged === true });
        if (a.status === 200) stats.acked++;
        else { stats.left++; onLog(`ack ${d.delivery_id} → ${a.status} (${a.error || ''}) — left for retry`); }
      } else if (res.permanent) {
        await client.quarantine(d.delivery_id, { error: String(res.reason || 'permanent handler failure'), handler: d.fact_type });
        stats.quarantined++; onLog(`quarantined ${d.delivery_id}: ${res.reason || 'permanent'}`);
      } else {
        stats.left++; onLog(`transient on ${d.delivery_id}: ${res.reason || 'left for retry'}`);
      }
    } catch (e) {
      const attempts = (d.delivery_attempts || 0) + 1;
      if (attempts >= maxAttempts) {
        await client.quarantine(d.delivery_id, { error: `handler threw ${attempts}x: ${e && e.message}`, handler: d.fact_type });
        stats.quarantined++; onLog(`quarantined ${d.delivery_id} after ${attempts} throws: ${e && e.message}`);
      } else {
        stats.left++; onLog(`handler threw on ${d.delivery_id} (attempt ${attempts}/${maxAttempts}), left for retry: ${e && e.message}`);
      }
    }
  }
  return stats;
}

/**
 * Wire a real gateway client and poll on an interval. Returns { stop } to clear the loop.
 * Token resolution order: explicit `token` → BOARD_TOKEN env → ~/.kameha/board-gateway.tokens/<agent>.
 */
function runConsumer({ agent, url, token, handlers, intervalMs = 30000, leaseS = 300, fetchImpl, onLog = () => {}, ctxExtras = {} }) {
  if (!agent) throw new Error('runConsumer: agent required');
  if (!handlers || typeof handlers !== 'object') throw new Error('runConsumer: handlers map required');
  let tok = token || process.env.BOARD_TOKEN;
  if (!tok) {
    const fs = require('node:fs'), path = require('node:path');
    tok = fs.readFileSync(path.join(process.env.HOME, '.kameha', 'board-gateway.tokens', agent), 'utf8').trim();
  }
  const client = makeGatewayClient({ url: url || process.env.BOARD_URL, token: tok, fetchImpl });
  const tick = async () => {
    try { const s = await processInboxOnce({ client, handlers, ctxExtras: { leaseS, ...ctxExtras }, onLog });
      if (s.fetched) onLog(`[consume:${agent}] fetched=${s.fetched} acked=${s.acked} quar=${s.quarantined} left=${s.left} skip=${s.skipped}`); }
    catch (e) { onLog(`[consume:${agent}] tick error: ${e && e.message}`); }
  };
  tick();                                   // run immediately, then on the interval
  const timer = setInterval(tick, intervalMs);
  if (timer.unref) timer.unref();
  return { stop: () => clearInterval(timer), tick };
}

module.exports = { makeGatewayClient, processInboxOnce, runConsumer };

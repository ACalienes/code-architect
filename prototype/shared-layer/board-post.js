'use strict';
/**
 * board-post — the client side of the Board Write Gateway. A feed running anywhere (laptop or Mini)
 * uses this to publish a fact over Tailscale instead of opening kameha-mesh.db locally. Retries on
 * network / 5xx, REUSING the idempotency_key so a retry can't double-post (gateway dedupes it).
 *
 *   const { postFact } = require('./board-post');
 *   await postFact({ url: process.env.BOARD_URL, token, fact: { fact_type:'status_update',
 *     visibility:'internal', subject_id:'x', payload:{ status:'update', detail:'…' } } });
 *
 * The gateway sets source_agent from the token — do NOT send it.
 */
const { randomUUID } = require('node:crypto');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function postFact({ url, token, fact, idempotencyKey, retries = 2, fetchImpl }) {
  if (!url) throw new Error('postFact: url required (BOARD_URL)');
  if (!token) throw new Error('postFact: token required');
  const doFetch = fetchImpl || globalThis.fetch;
  if (!doFetch) throw new Error('postFact: no fetch available (Node 18+ or pass fetchImpl)');
  const endpoint = url.replace(/\/+$/, '') + '/publish';
  const idk = idempotencyKey || randomUUID();           // stable across retries → dedupe
  const body = JSON.stringify({ ...fact, idempotency_key: idk });

  for (let attempt = 0; ; attempt++) {
    try {
      const r = await doFetch(endpoint, {
        method: 'POST',
        headers: { 'authorization': `Bearer ${token}`, 'content-type': 'application/json' },
        body,
      });
      let json = {}; try { json = await r.json(); } catch (_) {}
      if (r.status >= 500 && attempt < retries) { await sleep(250 * (attempt + 1)); continue; }
      return { status: r.status, ...json };
    } catch (e) {
      if (attempt < retries) { await sleep(250 * (attempt + 1)); continue; }
      throw e;
    }
  }
}

module.exports = { postFact };

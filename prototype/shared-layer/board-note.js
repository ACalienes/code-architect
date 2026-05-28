'use strict';
/**
 * board-note — the simplest way for ANY enrolled agent to leave a note on the Board.
 * Posts a `status_update` ({status:'note', detail}) via the gateway, with @mentions for the agents
 * who should specifically be aware. The ledger and supervisor view highlight @mentions.
 *
 *   node board-note.js <from> "<text>" [--for=kai,acd] [--subject=topic] [--client=slug]
 *
 *   node board-note.js kmg "Brand bible for Vania is live for review." --for=kai,acd --subject=brand-bible-vania
 *   node board-note.js framer "DAGDC Memorial Day carousel is rendered." --for=acd --subject=dagdc-memorial-day
 *
 * Token: ~/.kameha/board-gateway.tokens/<from>. Gateway sets source_agent from that token.
 */
const lib = require('./board-emit-lib');
const { postFact } = require('./board-post');

const argv = process.argv.slice(2);
const from = argv[0];
const text = argv[1];
const opts = {};
for (let i = 2; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--for=')) opts.for = a.slice(6).split(',').map(s => s.trim()).filter(Boolean);
  else if (a.startsWith('--subject=')) opts.subject = a.slice(10);
  else if (a.startsWith('--client=')) opts.client = a.slice(9);
}
if (!from || !text) {
  console.error('usage: node board-note.js <from> "<text>" [--for=kai,acd] [--subject=topic] [--client=slug]');
  process.exit(2);
}

const URL = process.env.BOARD_URL || 'http://100.64.114.13:3351';
let token; try { token = lib.readToken(from); }
catch (_) { console.error(`[note] no token for '${from}' — enroll one with gateway-enroll.js first`); process.exit(2); }

const mentions = (opts.for || []).map(a => `@${a}`).join(' ');
const detail = mentions ? `${mentions} — ${text}` : text;

postFact({
  url: URL, token,
  idempotencyKey: lib.idemKey(`${from}:note`, Date.now() + ':' + text),
  fact: {
    fact_type: 'status_update',
    visibility: opts.client ? 'client' : 'internal',
    data_class: opts.client ? 'client_confidential' : 'internal',
    subject_type: opts.subject ? 'topic' : 'note',
    subject_id: opts.subject || (opts.for && opts.for[0]) || 'note',
    payload: { status: 'note', detail: lib.clip(detail) },
    ...(opts.client ? { client_id: opts.client } : {}),
  },
}).then(r => {
  if (r.status === 200) console.log(`[note] ${from}${mentions ? ' ' + mentions : ''}: posted (fact_id ${r.fact_id}, routed to ${r.routed ?? 0} agents)`);
  else console.error(`[note] ${from}: status ${r.status} — ${r.error || ''}`);
}).catch(e => console.error('[note] error:', e.message));

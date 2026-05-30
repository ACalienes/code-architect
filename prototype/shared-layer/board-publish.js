'use strict';
/**
 * board-publish — the publish path for The Board. Any agent (or Alex) posts a fact with one call.
 * This is the concrete "publish API" Kai asked to confirm for the new types.
 *
 *   node board-publish.js --type objective --from kai --subject company-goals \
 *        --detail "Everything pertinent to the team lives on The Board" [--status active]
 *   node board-publish.js --type question --from cfo --subject ca --detail "Can we automate X?"
 *   node board-publish.js --type task --from kai --subject dag --detail "June calendar" --owner nami --status open
 *   node board-publish.js --type status_update --from conductor --subject gort-productions --detail "closed out" \
 *        [--client dagdc]   # client-scoped (routes only to that client's manager + internal '*')
 *
 * Internal types use client_id=null (route to '*' subscribers). Pass --client to scope to one client.
 */
const { openDb, writeFact, FACT_TYPES, AUTH_GRADE_TYPES } = require('./shared-layer');

const arg = k => { const i = process.argv.indexOf('--' + k); return i > -1 ? process.argv[i + 1] : undefined; };
const type = arg('type'), from = arg('from'), subject = arg('subject'), detail = arg('detail');
const client = arg('client') || null, owner = arg('owner'), status = arg('status') || 'update';

if (!type || !from || !detail) {
  console.error('usage: --type <fact_type> --from <agent> --detail "<text>" [--subject <id>] [--client <id>] [--owner <agent>] [--status <s>]');
  console.error('valid types: ' + [...FACT_TYPES].join(', '));
  process.exit(2);
}
if (!FACT_TYPES.has(type)) { console.error(`rejected: unknown fact_type '${type}'. valid: ${[...FACT_TYPES].join(', ')}`); process.exit(2); }
// Auth-grade fact types (e.g. supervisor_decision) authorize downstream agent action — the CLI must
// NEVER mint them. Only the authenticated gateway/supervisor path can (board-consume Codex P0 #2).
if (AUTH_GRADE_TYPES.has(type)) { console.error(`rejected: '${type}' is authorization-grade — only the authenticated gateway/supervisor can create it, never the CLI.`); process.exit(2); }

const db = openDb(process.env.HOME + '/.kameha/kameha-mesh.db');
const payload = { status, detail };
if (owner) payload.owner = owner;

const r = writeFact(db, {
  fact_type: type,
  visibility: client ? 'client' : 'internal',
  data_class: 'internal',
  client_id: client,
  source_agent: from,
  subject_type: 'topic',
  subject_id: subject || null,
  payload,
});
if (!r.ok) { console.error('publish rejected:', r.error); process.exit(1); }
const recips = db.prepare('SELECT recipient_agent FROM deliveries WHERE fact_id = ? ORDER BY recipient_agent').all(r.fact_id).map(x => x.recipient_agent);
console.log(`published ${type} (${r.fact_id}) → delivered to ${recips.length}: ${recips.join(', ') || '(no subscribers)'}`);

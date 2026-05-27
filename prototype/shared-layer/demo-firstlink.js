'use strict';
/**
 * First-link one-shot proof — CFO → (adapter) → Shared Layer → Kai.
 * Runs against the LIVE production kameha-mesh.db on the Mini. Additive: writes one test
 * fact + delivery, then drains it for kai. Touches no running agent, deploys no daemon.
 *
 *   node demo-firstlink.js
 */
const fs = require('node:fs');
const crypto = require('node:crypto');
const { openDb, drain } = require('./shared-layer');
const { ingestEnvelope } = require('./adapter-mesh');

const DB = process.env.HOME + '/.kameha/kameha-mesh.db';
const KEY = process.env.HOME + '/.kameha/keystore/mesh-adapter.key';
const db = openDb(DB);
const privateKey = crypto.createPrivateKey(fs.readFileSync(KEY, 'utf8'));

// A realistic CFO outbound mesh event (what CFO already emits — here, an invoice-paid status).
const env = {
  message_id: 'cfo-firstlink-' + Date.now(),
  action: 'status.update',
  from: 'cfo',
  correlation_id: 'INV-1042',     // → fact.subject_id
  visibility: 'internal',
  data_class: 'internal',
  payload: { status: 'paid', detail: 'Invoice INV-1042 marked paid ($4,200)' },  // status_update schema: status (req) + detail
};

console.log('\n\x1b[1m1. CFO event enters via the adapter (signed as the trusted bridge)\x1b[0m');
const r = ingestEnvelope(db, env, { adapterIdentity: { agent: 'mesh-adapter', privateKey } });
console.log('  ingest →', JSON.stringify(r));

console.log('\n\x1b[1m2. Kai drains its Shared-Layer inbox (no terminal, no manual relay)\x1b[0m');
const inbox = drain(db, 'kai');
const got = inbox.find(d => d.subject_id === 'INV-1042');
// drain() returns a delivery projection (no payload/source_agent) — read provenance from the fact row.
const factRow = r.fact_id ? db.prepare('SELECT source_agent, payload FROM facts WHERE fact_id=?').get(r.fact_id) : null;
let prov = null; try { prov = JSON.parse((factRow || {}).payload || '{}')._via_mesh_from; } catch (_) {}
if (got) console.log(`  kai got: ${got.fact_type}:${got.subject_id}  | signed-by: ${(factRow||{}).source_agent}  | original sender: ${prov}`);

console.log('\n\x1b[1mVerdict\x1b[0m');
const ok = r.ok && got;
console.log(`  ${r.ok ? '✓' : '✗'}  adapter ingested + signed + routed (routed=${r.routed})`);
console.log(`  ${got ? '✓' : '✗'}  Kai received the CFO event on its own drain`);
console.log(`  ${prov === 'cfo' ? '✓' : '✗'}  provenance preserved: original sender = cfo`);
console.log(ok && prov === 'cfo'
  ? '\n\x1b[32m  FIRST REAL LINK PROVEN ON THE LIVE MINI DB ✓  (CFO event → signed fact → Kai, no terminal)\x1b[0m\n'
  : '\n\x1b[31m  link check failed\x1b[0m\n');
process.exit(ok && prov === 'cfo' ? 0 : 1);

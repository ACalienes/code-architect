'use strict';
/**
 * The Board drainer — ONE trusted-writer process that services EVERY subscribed agent.
 *
 * Why one process (not one per agent): on a single SQLite file, N separate processes each holding a
 * write connection contend for the write lock ("database is locked"). The single-user Mini design
 * (cutover decision D2) is a single trusted writer — so this one loop drains for all agents on one
 * connection: no contention. Each agent still has its own delivery scope + its own visible inbox
 * (~/.kameha/board-inbox/<agent>.ndjson); one process just services them all.
 *
 * Agent list is derived live from subscriptions, so subscribing a new agent auto-enrolls it here.
 *
 *   pm2 start board-listener.js --name board-drainer
 */
const fs = require('node:fs');
const path = require('node:path');
const { openDb, drain } = require('./shared-layer');

const DIR = process.env.HOME + '/.kameha/board-inbox';
fs.mkdirSync(DIR, { recursive: true });
const db = openDb(process.env.HOME + '/.kameha/kameha-mesh.db');

const rec = (agent, f) => fs.appendFileSync(path.join(DIR, agent + '.ndjson'), JSON.stringify({
  received_at: new Date().toISOString(), delivery_id: f.delivery_id, fact_id: f.fact_id,
  kind: f.kind, fact_type: f.fact_type, subject_id: f.subject_id, payload: f.payload,
}) + '\n');

const agents = () => db.prepare('SELECT DISTINCT agent FROM subscriptions').all().map(r => r.agent);

function tick() {
  for (const a of agents()) {
    try {
      const got = drain(db, a);
      got.forEach(f => rec(a, f));
      if (got.length) console.log(`[board] ${a} picked up ${got.length} post(s)`);
    } catch (e) { console.error(`[board] ${a} error: ${e.message}`); }
  }
}

tick();                          // catch up everything pending now
setInterval(tick, 30000);        // then service all agents every 30s
console.log('[board] single-writer drainer live for: ' + agents().join(', '));

'use strict';
/**
 * Operational helper — enroll a Board-gateway bearer token for an agent. Privileged (operator-run).
 * Writes the token to a 0600 file under ~/.kameha/board-gateway.tokens/<agent>; prints ONLY metadata
 * (length), never the token itself (HB#9 — credentials never hit stdout/logs).
 *
 *   node gateway-enroll.js <agent> [client_id] [canProduce,csv]
 *   node gateway-enroll.js cfo                      # internal, any fact_type
 *   node gateway-enroll.js dag-repo tdb client_feedback,status_update
 *
 * The token file is what board-post.js / an emit hook reads (or copy it to the machine that publishes).
 */
const fs = require('node:fs');
const path = require('node:path');
const { openDb } = require('./shared-layer');
const { enrollToken } = require('./board-gateway');

const agent = process.argv[2];
if (!agent) { console.error('usage: node gateway-enroll.js <agent> [client_id] [canProduce,csv]'); process.exit(2); }
const client_id = process.argv[3] && process.argv[3] !== '-' ? process.argv[3] : null;
const can_produce = process.argv[4] ? process.argv[4].split(',').map(s => s.trim()).filter(Boolean) : null;

const db = openDb(process.env.BOARD_DB || (process.env.HOME + '/.kameha/kameha-mesh.db'));
const token = enrollToken(db, { agent, client_id, can_produce });

const dir = path.join(process.env.HOME, '.kameha', 'board-gateway.tokens');
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const file = path.join(dir, agent);
fs.writeFileSync(file, token, { mode: 0o600 });

console.log(`enrolled '${agent}' (client=${client_id || '-'}, can_produce=${can_produce ? can_produce.join('|') : 'any'}) → ${file} [${token.length} chars, not shown]`);

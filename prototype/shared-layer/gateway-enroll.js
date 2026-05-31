'use strict';
/**
 * Operational helper — enroll a Board-gateway bearer token for an agent. Privileged (operator-run).
 * Writes the token to a 0600 file under ~/.kameha/board-gateway.tokens/<agent>; prints ONLY metadata
 * (length), never the token itself (HB#9 — credentials never hit stdout/logs).
 *
 *   node gateway-enroll.js <agent> [client_id] [canProduce,csv] [--scopes=csv]
 *   node gateway-enroll.js cfo                                  # internal, any fact_type, legacy publish-only
 *   node gateway-enroll.js dag-repo tdb client_feedback,status_update
 *   node gateway-enroll.js cfo - - --scopes=publish,read,ack    # Phase 3 consumer (read+ack its inbox)
 *   node gateway-enroll.js alex - - --scopes=publish,supervise  # supervisor (may publish supervisor_decision)
 *
 * The token file is what board-post.js / an emit hook reads (or copy it to the machine that publishes).
 * Scopes default to [publish] (legacy) when --scopes is omitted, so existing call sites are unchanged.
 */
const fs = require('node:fs');
const path = require('node:path');
const { openDb } = require('./shared-layer');
const { enrollToken } = require('./board-gateway');

// Positional args, skipping any --flag. --scopes=csv is optional and order-independent.
const argv = process.argv.slice(2);
const scopesFlag = argv.find(a => a.startsWith('--scopes='));
const positional = argv.filter(a => !a.startsWith('--'));
const agent = positional[0];
if (!agent) { console.error('usage: node gateway-enroll.js <agent> [client_id] [canProduce,csv] [--scopes=publish,read,ack]'); process.exit(2); }
const client_id = positional[1] && positional[1] !== '-' ? positional[1] : null;
const can_produce = positional[2] && positional[2] !== '-' ? positional[2].split(',').map(s => s.trim()).filter(Boolean) : null;
const scopes = scopesFlag ? scopesFlag.slice('--scopes='.length).split(',').map(s => s.trim()).filter(Boolean) : undefined;

const db = openDb(process.env.BOARD_DB || (process.env.HOME + '/.kameha/kameha-mesh.db'));
// enrollToken validates each scope against ALL_SCOPES and throws on an unknown one (fail-loud).
const token = enrollToken(db, { agent, client_id, can_produce, ...(scopes ? { scopes } : {}) });

const dir = path.join(process.env.HOME, '.kameha', 'board-gateway.tokens');
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const file = path.join(dir, agent);
fs.writeFileSync(file, token, { mode: 0o600 });

console.log(`enrolled '${agent}' (client=${client_id || '-'}, can_produce=${can_produce ? can_produce.join('|') : 'any'}, scopes=${scopes ? scopes.join('|') : 'publish(legacy)'}) → ${file} [${token.length} chars, not shown]`);

'use strict';
/**
 * Fleet enrollment — the privileged identity bootstrap (deployment runbook §3).
 * Generates an Ed25519 keypair per agent, registers the PUBLIC key into a Shared Layer db, and writes
 * each PRIVATE key to a per-agent file (0600) for custody.
 *
 * HB#9 / T3: private keys ARE credentials. They are written 0600 and NEVER logged (the summary carries
 * only public-key fingerprints). The file-based keystore here is the REFERENCE custody mechanism;
 * production custody (a secret store / per-agent env injection) is a T3 decision for Alex + Kai. Live
 * enrollment is gated behind the pre-deploy Codex round.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { registerIdentity } = require('./identity');

// The Kameha fleet: mesh participants (internal, cross-client) + client repos (bound to one client).
// canProduce=null → any known fact_type (tighten per agent when the per-agent vocabulary is settled).
const FLEET_ROSTER = [
  { agent: 'kai', clientId: null },
  { agent: 'acd', clientId: null },
  { agent: 'nami', clientId: null },
  { agent: 'framer', clientId: null },
  { agent: 'enso', clientId: null },
  { agent: 'cfo', clientId: null },
  { agent: 'conductor', clientId: null },
  { agent: 'offer-architect', clientId: null },
  { agent: 'lead-engine', clientId: null },
  { agent: 'code-architect', clientId: null },
  { agent: 'dag-repo', clientId: 'dagdc' },
  { agent: 'tdb-repo', clientId: 'tdb' },
];

const fingerprint = (pubPem) => crypto.createHash('sha256').update(pubPem).digest('hex').slice(0, 16);

/**
 * Enroll a roster into `db`. If `keysDir` is given, writes each private key to `<keysDir>/<agent>.key`
 * (0600). Returns a summary of { agent, clientId, pubkey_fp } — PUBLIC fingerprints only.
 */
function enrollFleet(db, roster = FLEET_ROSTER, { keysDir } = {}) {
  if (keysDir) { fs.mkdirSync(keysDir, { recursive: true }); fs.chmodSync(keysDir, 0o700); }
  const summary = [];
  for (const r of roster) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    registerIdentity(db, { agent: r.agent, publicKey: pubPem, clientId: r.clientId ?? null, canProduce: r.canProduce ?? null });
    if (keysDir) {
      const keyPath = path.join(keysDir, `${r.agent}.key`);
      fs.writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
      fs.chmodSync(keyPath, 0o600); // belt-and-suspenders vs umask
    }
    summary.push({ agent: r.agent, clientId: r.clientId ?? null, pubkey_fp: fingerprint(pubPem) });
  }
  return summary;
}

module.exports = { enrollFleet, FLEET_ROSTER, fingerprint };

// CLI: node enroll.js --db <path> --keys <dir>   (live enrollment — privileged, gated)
if (require.main === module) {
  const arg = (k) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : null; };
  const dbPath = arg('--db'); const keysDir = arg('--keys');
  if (!dbPath || !keysDir) { console.error('usage: node enroll.js --db <kameha-mesh.db> --keys <keystore-dir>'); process.exit(2); }
  const { openDb } = require('./shared-layer');
  const db = openDb(dbPath);
  const summary = enrollFleet(db, FLEET_ROSTER, { keysDir });
  console.log(`Enrolled ${summary.length} identities into ${dbPath}; private keys (0600) in ${keysDir}`);
  for (const s of summary) console.log(`  ${s.agent}${s.clientId ? ' [' + s.clientId + ']' : ' (internal)'} · pub ${s.pubkey_fp}`);
  console.log('Distribute each <agent>.key to that agent\'s secret store, then DELETE the keystore dir.');
}

'use strict';
/**
 * Enrollment proof — the bootstrap tooling, run against a STAGING db (real keypairs, then cleaned up).
 * Proves: public keys registered with bindings, private keys written 0600, no private material in the
 * db, and an enrolled identity's key actually works through the production door. Exits non-zero on
 * any failure.
 *
 *   node prototype/shared-layer/enroll.test.js
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { openDb, subscribe, drain } = require('./shared-layer');
const { defaultRegistry } = require('./registry');
const { signFact, writeSignedFact } = require('./identity');
const { enrollFleet } = require('./enroll');

let failures = 0;
const check = (label, cond) => { console.log(`  ${cond ? '✓' : '✗ FAIL'}  ${label}`); if (!cond) failures++; };
const h = (s) => console.log(`\n\x1b[1m${s}\x1b[0m`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-enroll-'));
const keysDir = path.join(tmp, 'keys');
const roster = [{ agent: 'acd', clientId: null }, { agent: 'dag-repo', clientId: 'dagdc' }, { agent: 'tdb-repo', clientId: 'tdb' }];

h('1. Enroll a roster into a staging db');
const db = openDb();
const summary = enrollFleet(db, roster, { keysDir });
check('all identities registered (public keys)', db.prepare('SELECT COUNT(*) AS n FROM identities').get().n === 3);
check('client repos carry their binding', db.prepare("SELECT client_id FROM identities WHERE agent='dag-repo'").get().client_id === 'dagdc');
check('summary exposes only public-key fingerprints (no key material)', summary.every(s => /^[0-9a-f]{16}$/.test(s.pubkey_fp)) && !/PRIVATE/.test(JSON.stringify(summary)));

h('2. Private keys are written as 0600 files, nothing private in the db');
check('one .key file per agent', roster.every(r => fs.existsSync(path.join(keysDir, `${r.agent}.key`))));
check('private key files are 0600', roster.every(r => (fs.statSync(path.join(keysDir, `${r.agent}.key`)).mode & 0o777) === 0o600));
check('keystore dir is 0700', (fs.statSync(keysDir).mode & 0o777) === 0o700);
check('no PRIVATE key material in the identities table', !/PRIVATE/.test(JSON.stringify(db.prepare('SELECT * FROM identities').all())));

h('3. An enrolled identity actually works through the production door');
subscribe(db, 'acd', 'client_feedback', '*');
const dagPriv = crypto.createPrivateKey(fs.readFileSync(path.join(keysDir, 'dag-repo.key')));
const fact = { fact_type: 'client_feedback', client_id: 'dagdc', subject_id: 'm', visibility: 'client', data_class: 'client_confidential', source_agent: 'dag-repo', observed_at: '2026-05-25T00:00:00Z', payload: { sentiment: 'loved' } };
const r = writeSignedFact(db, fact, signFact(dagPriv, fact), { registry: defaultRegistry });
check('signed write from the enrolled dag-repo key passes + routes', r.ok && r.routed === 1);
check('acd receives it', drain(db, 'acd').length === 1);
const bad = { ...fact, client_id: 'tdb', subject_id: 'x' };
check('the enrolled client binding still holds (dag-repo can\'t write TDB)', !writeSignedFact(db, bad, signFact(dagPriv, bad)).ok);

h('4. Re-running enrollment skips already-enrolled agents (no mismatched key written)');
{
  const keysDir2 = path.join(tmp, 'keys2');
  const summary2 = enrollFleet(db, roster, { keysDir: keysDir2 }); // same db, already enrolled
  check('every already-enrolled agent is reported skipped', summary2.every(s => s.skipped) && summary2.length === roster.length);
  check('NO new key files written for skipped agents (would mismatch the registered pubkey)', !fs.existsSync(path.join(keysDir2, 'dag-repo.key')));
  // the original enrolled key still verifies — re-run did not replace the identity
  const stillGood = { ...fact, subject_id: 'after-rerun' };
  check('the ORIGINAL enrolled key still works (identity untouched by the re-run)', writeSignedFact(db, stillGood, signFact(dagPriv, stillGood), { registry: defaultRegistry }).ok);
}

// cleanup — do not leave key material on disk
fs.rmSync(tmp, { recursive: true, force: true });
h(failures === 0 ? '\x1b[32mENROLLMENT HOLDS ✓ (staging keys cleaned up)\x1b[0m' : `\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`);
process.exit(failures === 0 ? 0 : 1);

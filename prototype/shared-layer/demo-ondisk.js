'use strict';
/**
 * Demo A — the SAME DAG→ACD/NAMI flow, but projected to REAL FILES on disk,
 * so you can watch a fact written in one repo physically appear in others' inboxes
 * (and NOT in the repo it must never reach).
 *
 *   node prototype/shared-layer/demo-ondisk.js
 *
 * Uses the real projectClient() — the actual isolation boundary, not a mock.
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { openDb, subscribe, writeFact, drain } = require('./shared-layer');
const { projectClient, openProjectionDb } = require('./projection');

const ROOT = '/tmp/shared-layer-demo';
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true });
const PROJ = path.join(ROOT, 'projections');
const h = (s) => console.log(`\n\x1b[1m${s}\x1b[0m`);

const central = openDb(path.join(ROOT, 'central.db'));

h('Setup — subscriptions (client repos scoped to their own client; ACD/NAMI internal = all clients)');
subscribe(central, 'acd',      'client_feedback', '*');
subscribe(central, 'nami',     'client_feedback', '*');
subscribe(central, 'dag-repo', 'client_feedback', 'dagdc');
subscribe(central, 'tdb-repo', 'client_feedback', 'tdb');
console.log('  acd,nami → *   |   dag-repo → dagdc   |   tdb-repo → tdb');

h('1. One write in the DAG repo: "Dan loved the Memorial Day posts"');
writeFact(central, {
  fact_type: 'client_feedback', client_id: 'dagdc', subject_type: 'campaign', subject_id: 'memorial-day',
  visibility: 'client', data_class: 'client_confidential', source_agent: 'dag-repo',
  payload: { sentiment: 'loved', note: 'Dan approved; posts published' },
});
console.log('  one write in the dag-repo, "Dan loved the Memorial Day posts"');

h('2. A separate TDB-confidential write (the thing DAG must never see)');
writeFact(central, {
  fact_type: 'client_feedback', client_id: 'tdb', subject_type: 'campaign', subject_id: 'tdb-secret-launch',
  visibility: 'client', data_class: 'client_confidential', source_agent: 'tdb-repo',
  payload: { sentiment: 'confidential TDB info' },
});
console.log('  one write in the tdb-repo, "tdb-secret-launch"');

h('3. Project to REAL on-disk inboxes (the actual projectClient mechanism)');
projectClient(central, { dir: PROJ, agent: 'dag-repo', clientId: 'dagdc' });
projectClient(central, { dir: PROJ, agent: 'tdb-repo', clientId: 'tdb' });
console.log(execSync(`ls -la ${PROJ}`).toString().trim());

h('4. What each repo PHYSICALLY holds on disk (read back from its inbox.db file)');
function inboxFacts(agent) {
  const pdb = openProjectionDb(path.join(PROJ, agent, 'inbox.db'));
  const rows = pdb.prepare('SELECT * FROM facts').all();
  pdb.close();
  return rows.map(r => `${r.client_id}/${r.subject_id}`);
}
const dagHas = inboxFacts('dag-repo');
const tdbHas = inboxFacts('tdb-repo');
console.log(`  /tmp/shared-layer-demo/projections/dag-repo/inbox.db  →  ${JSON.stringify(dagHas)}`);
console.log(`  /tmp/shared-layer-demo/projections/tdb-repo/inbox.db  →  ${JSON.stringify(tdbHas)}`);

h('5. Internal agents (ACD, NAMI) — cross-client by design — see both');
console.log('  acd  drains →', drain(central, 'acd').map(d => d.subject_id));
console.log('  nami drains →', drain(central, 'nami').map(d => d.subject_id));

h('Verdict');
let fail = 0;
const ck = (label, cond) => { console.log(`  ${cond ? '✓' : '✗ FAIL'}  ${label}`); if (!cond) fail++; };
ck('DAG repo file HAS its own fact (memorial-day)', dagHas.includes('dagdc/memorial-day'));
ck('DAG repo file does NOT contain the TDB fact', !dagHas.some(x => x.includes('tdb-secret-launch')));
ck('TDB repo file HAS its own fact', tdbHas.includes('tdb/tdb-secret-launch'));
ck('TDB repo file does NOT contain the DAG fact', !tdbHas.some(x => x.includes('memorial-day')));
console.log(fail === 0 ? '\n\x1b[32m  PROPAGATION + PHYSICAL ISOLATION HOLD ON REAL FILES ✓\x1b[0m' : `\n\x1b[31m  ${fail} FAILED\x1b[0m`);
console.log(`\n  Inspect it yourself:  ls -R ${PROJ}\n`);
process.exit(fail === 0 ? 0 : 1);

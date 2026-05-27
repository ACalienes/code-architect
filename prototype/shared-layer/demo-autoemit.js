'use strict';
/**
 * Demo C — "8 repos informing each other constantly, automatically."
 *
 * The point: NOBODY calls writeFact by hand. Each repo declares a PUBLICATION CONTRACT
 * (when event X happens here, emit fact Y). A repo just does its normal work and fires an
 * event; the emit hook publishes the fact; subscriptions fan it to exactly the repos that
 * care. That is the "constant chatter" — automatic, filtered, no manual relaying.
 *
 *   node prototype/shared-layer/demo-autoemit.js
 */
const { openDb, subscribe, writeFact, drain } = require('./shared-layer');
const db = openDb();
const h = (s) => console.log(`\n\x1b[1m${s}\x1b[0m`);

// ── PUBLICATION CONTRACTS: per repo, "this work event → emit this fact" (the missing half) ──
const PUBLICATIONS = {
  'dag-repo':        { feedback_recorded: d => ({ fact_type:'client_feedback', client_id:'dagdc', visibility:'client', data_class:'client_confidential', subject_type:'campaign', subject_id:d.subject, payload:d }) },
  'tdb-repo':        { feedback_recorded: d => ({ fact_type:'client_feedback', client_id:'tdb',   visibility:'client', data_class:'client_confidential', subject_type:'campaign', subject_id:d.subject, payload:d }) },
  'acd':             { concept_approved:  d => ({ fact_type:'decision',        visibility:'internal', data_class:'internal', subject_type:'concept',  subject_id:d.subject, payload:d }),
                       brief_issued:      d => ({ fact_type:'creative_brief',  visibility:'internal', data_class:'internal', subject_type:'brief',    subject_id:d.subject, payload:d }) },
  'framer':          { asset_shipped:     d => ({ fact_type:'status_update',   visibility:'internal', data_class:'internal', subject_type:'asset',    subject_id:d.subject, payload:d }) },
  'nami':            { posts_scheduled:   d => ({ fact_type:'status_update',   visibility:'internal', data_class:'internal', subject_type:'schedule', subject_id:d.subject, payload:d }) },
  'cfo':             { invoice_paid:      d => ({ fact_type:'status_update',   visibility:'internal', data_class:'internal', subject_type:'invoice',  subject_id:d.subject, payload:d }) },
  'offer-architect': { deal_advanced:     d => ({ fact_type:'status_update',   visibility:'internal', data_class:'internal', subject_type:'deal',     subject_id:d.subject, payload:d }) },
  'kai':             { priority_set:      d => ({ fact_type:'decision',        visibility:'fleet',    data_class:'internal', subject_type:'priority', subject_id:d.subject, payload:d }) },
};

// ── SUBSCRIPTIONS: per repo, "what I care about" (the half already proven) ──
const SUBS = {
  'kai':             [['decision','*'],['status_update','*'],['client_feedback','*']],  // Chief of Staff: sees the whole hum
  'acd':             [['client_feedback','*'],['decision','*'],['status_update','*']],
  'nami':            [['client_feedback','*'],['decision','*'],['status_update','*']],
  'framer':          [['creative_brief','*'],['decision','*']],
  'cfo':             [['decision','*'],['status_update','*']],
  'offer-architect': [['status_update','*'],['decision','*']],
  'dag-repo':        [['client_feedback','dagdc'],['decision','dagdc']],   // client repo: ONLY its client
  'tdb-repo':        [['client_feedback','tdb']],                          // client repo: ONLY its client
};
const REPOS = Object.keys(SUBS);
for (const [agent, subs] of Object.entries(SUBS)) for (const [ft, scope] of subs) subscribe(db, agent, ft, scope);

// ── THE EMIT HOOK: a repo does work → its contract publishes the fact. No manual send. ──
function work(repo, event, data) {
  const make = PUBLICATIONS[repo] && PUBLICATIONS[repo][event];
  if (!make) return;
  const r = writeFact(db, { source_agent: repo, ...make(data) });
  console.log(`  \x1b[36m${repo}\x1b[0m did "${event}" → auto-emitted \x1b[33m${make(data).fact_type}\x1b[0m → reached ${r.routed} repo(s)`);
}

h('A normal stretch of work across 8 repos — each just does its job; nobody relays anything');
work('dag-repo',        'feedback_recorded', { subject:'memorial-day', sentiment:'Dan loved the posts' });
work('acd',             'concept_approved',  { subject:'q3-brand-refresh' });
work('framer',          'asset_shipped',     { subject:'reel-cut-04' });
work('nami',            'posts_scheduled',   { subject:'memorial-day-grid' });
work('cfo',             'invoice_paid',      { subject:'INV-1042' });
work('offer-architect', 'deal_advanced',     { subject:'acme-retainer', stage:'proposal-sent' });
work('tdb-repo',        'feedback_recorded', { subject:'tdb-launch', sentiment:'confidential' });
work('kai',             'priority_set',      { subject:'ship-malaga-brief-first' });

h('The chatter that resulted — what each repo now knows, automatically (filtered to what it cares about)');
let total = 0;
const received = {};   // capture real drained data for the verdict
for (const repo of REPOS) {
  const inbox = drain(db, repo);
  received[repo] = inbox;
  total += inbox.length;
  const items = inbox.map(d => `${d.fact_type}:${d.subject_id}`).join(', ') || '—';
  console.log(`  \x1b[36m${repo.padEnd(16)}\x1b[0m ${String(inbox.length).padStart(2)} update(s)  ${items}`);
}

h('Verdict (asserted on the real drained inboxes)');
let fail = 0;
const ck = (l, c) => { console.log(`  ${c ? '✓' : '✗ FAIL'}  ${l}`); if (!c) fail++; };
const kaiTypes = new Set(received['kai'].map(d => d.fact_type));
const dagSawTdb = received['dag-repo'].some(d => d.client_id === 'tdb');
const tdbSawDag = received['tdb-repo'].some(d => d.client_id === 'dagdc');
ck('updates propagated with ZERO manual sends (only work() events fired)', total > 0);
ck(`Chief-of-Staff (kai) saw the cross-repo hum (${kaiTypes.size} distinct update types)`, kaiTypes.size >= 2);
ck('client repo isolation held: dag-repo never saw tdb', !dagSawTdb);
ck('client repo isolation held: tdb-repo never saw dagdc', !tdbSawDag);
console.log(fail === 0
  ? `\n  \x1b[32m${total} updates propagated automatically across ${REPOS.length} repos — that is the constant chatter.\x1b[0m`
  : `\n  \x1b[31m${fail} check(s) failed\x1b[0m`);
console.log('  Add a 9th repo: it declares its publications + subscriptions once, and it is in the conversation.\n');
process.exit(fail === 0 ? 0 : 1);

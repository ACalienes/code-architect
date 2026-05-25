'use strict';
/**
 * Backfill-as-claims proof. The security-critical invariants: claims never route, secrets
 * are scrubbed at the door (stored payload holds no secret), only known fact_types can be
 * promoted, promotion routes the real fact, re-ingest is idempotent, rejection is terminal.
 * Exits non-zero on any failed invariant.
 *
 *   node prototype/shared-layer/backfill.test.js
 */
const { openDb, subscribe, drain } = require('./shared-layer');
const { ingestClaim, listClaims, promoteClaim, rejectClaim, scrubString } = require('./backfill');

let failures = 0;
const check = (label, cond) => {
  console.log(`  ${cond ? '✓' : '✗ FAIL'}  ${label}`);
  if (!cond) failures++;
};
const h = (s) => console.log(`\n\x1b[1m${s}\x1b[0m`);

const countDeliveries = (db) => db.prepare('SELECT COUNT(*) AS n FROM deliveries').get().n;
const noSecretInClaims = (db) => {
  // The planted secrets, verbatim — none may survive anywhere in the claims table.
  const blob = JSON.stringify(db.prepare('SELECT * FROM claims').all());
  return !/sk-ant-PLANTED|AKIAPLANTED|dan@dagdc\.com|hunter2supersecret/.test(blob);
};

// ── 1. Scrub unit: secrets/PII redacted, key names kept, counts recorded ──
h('1. scrub — secrets and PII are redacted to typed tags; only counts are kept');
{
  const { clean, redactions } = scrubString(
    'key=sk-ant-PLANTEDsecretvalue1234567 email dan@dagdc.com password: "hunter2supersecret"'
  );
  check('anthropic key redacted', !clean.includes('sk-ant-PLANTED') && /\[REDACTED:anthropic_key\]/.test(clean));
  check('email redacted', !clean.includes('dan@dagdc.com') && /\[REDACTED:email\]/.test(clean));
  check('kv secret value redacted, key name kept', /password\s*:\s*\[REDACTED:secret\]/.test(clean) && !clean.includes('hunter2supersecret'));
  check('redaction summary counts present (no values)', redactions.anthropic_key >= 1 && redactions.email >= 1);

  // High-value patterns added after the DA pass:
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.s3cr3tSignaturePart';
  const conn = 'postgres://admin:hunter2pass@db.internal:5432/prod';
  const r2 = scrubString(`tok ${jwt} db ${conn} card 4111 1111 1111 1111`);
  check('JWT redacted', !r2.clean.includes(jwt) && /\[REDACTED:jwt\]/.test(r2.clean));
  check('connection-string credentials redacted', !r2.clean.includes('hunter2pass') && /\[REDACTED:conn_string\]/.test(r2.clean));
  check('credit-card-shaped number redacted', !r2.clean.includes('4111 1111 1111 1111') && /\[REDACTED:credit_card\]/.test(r2.clean));
  const pem = scrubString('-----BEGIN RSA PRIVATE KEY-----\nMIIBfakekeymaterial==\n-----END RSA PRIVATE KEY-----');
  check('PEM private key block redacted', !pem.clean.includes('fakekeymaterial') && /\[REDACTED:private_key\]/.test(pem.clean));
}

// ── 2. Ingest quarantines a claim and NEVER routes it ──
h('2. ingest — a backfilled item becomes a quarantined claim and creates ZERO deliveries');
{
  const db = openDb();
  subscribe(db, 'acd', 'client_feedback', '*'); // a subscriber exists — proves claims still don't deliver
  const r = ingestClaim(db, {
    fact_type: 'client_feedback', client_id: 'dagdc', subject_type: 'campaign', subject_id: 'memorial-day',
    visibility: 'client', data_class: 'client_confidential', source_agent: 'dag-repo',
    source_ref: 'memory/session-2026-05-01.md:42',
    payload: { note: 'Dan loved it; reach him at dan@dagdc.com', token: 'sk-ant-PLANTEDsecretvalue1234567' },
  });
  check('ingest ok, quarantined', r.ok && !r.deduped);
  check('NO deliveries created for a claim (it cannot reach any agent)', countDeliveries(db) === 0);
  check('drain returns nothing — claim is invisible to subscribers', drain(db, 'acd').length === 0);
  check('secret + PII scrubbed before storage', noSecretInClaims(db));
  const q = listClaims(db);
  check('claim is in the quarantine review queue', q.length === 1 && q[0].subject_id === 'memorial-day');
  check('stored payload is scrubbed, provenance retained', /\[REDACTED:email\]/.test(JSON.stringify(q[0].payload)) && q[0].source_ref.endsWith(':42'));
}

// ── 3. Idempotent re-ingest: re-running the backfill doesn't duplicate ──
h('3. idempotent — re-ingesting the same provenance+content dedupes (backfill is re-runnable)');
{
  const db = openDb();
  const item = {
    fact_type: 'decision', subject_id: 'shared-layer-cutover', visibility: 'internal', data_class: 'internal',
    source_ref: 'docs/decision-2026-05-25.md:1', payload: { text: 'clean cutover blessed' },
  };
  const a = ingestClaim(db, item);
  const b = ingestClaim(db, item);
  check('first ingest is new', a.ok && a.deduped === false);
  check('second ingest is deduped to the same claim', b.ok && b.deduped === true && b.claim_id === a.claim_id);
  check('only one claim row exists', listClaims(db, { status: 'quarantined' }).length === 1);
}

// ── 4. Promotion is the only egress, and it routes the real fact ──
h('4. promote — human-gated; only then does the claim become a real, routed fact');
{
  const db = openDb();
  subscribe(db, 'acd', 'client_feedback', '*');
  subscribe(db, 'dag-repo', 'client_feedback', 'dagdc');
  const r = ingestClaim(db, {
    fact_type: 'client_feedback', client_id: 'dagdc', subject_id: 'memorial-day',
    visibility: 'client', data_class: 'client_confidential', source_ref: 'memory/x.md:1',
    payload: { sentiment: 'loved' },
  });
  check('no deliveries while quarantined', countDeliveries(db) === 0);
  const p = promoteClaim(db, r.claim_id, 'alex');
  check('promotion ok → a real fact_id', p.ok && !!p.fact_id);
  check('promotion routed to the real subscribers (acd + dag-repo)', p.routed === 2);
  check('NOW deliveries exist (claim became a routed fact)', countDeliveries(db) === 2);
  const acd = drain(db, 'acd');
  check('ACD receives the promoted fact, provenance-stamped', acd.length === 1 && acd[0].payload._provenance === 'memory/x.md:1');
  check('claim marked promoted (no longer in quarantine queue)', listClaims(db, { status: 'quarantined' }).length === 0);
  check('a second promote is refused (not quarantined anymore)', promoteClaim(db, r.claim_id, 'alex').ok === false);
}

// ── 5. Unknown fact_type can be quarantined but CANNOT be promoted ──
h('5. promotion preflight — an unknown fact_type stays quarantined, never becomes a fact');
{
  const db = openDb();
  const r = ingestClaim(db, {
    fact_type: 'gossip', subject_id: 'x', visibility: 'internal', data_class: 'internal',
    source_ref: 'memory/y.md:1', payload: { text: 'unverified hearsay' },
  });
  check('ingest accepts it (quarantine is permissive; review decides)', r.ok);
  const p = promoteClaim(db, r.claim_id, 'alex');
  check('promotion rejected by the schema door (unknown fact_type)', p.ok === false && /unknown fact_type/.test(p.error));
  check('claim stays quarantined after a failed promotion', listClaims(db, { status: 'quarantined' }).length === 1);
  check('still zero deliveries (nothing leaked out)', countDeliveries(db) === 0);
}

// ── 6. Client-confidential claim missing client_id: quarantinable, not promotable ──
h('6. promotion preflight — client-confidential w/o client_id cannot be promoted (no ambiguous scope)');
{
  const db = openDb();
  const r = ingestClaim(db, {
    fact_type: 'client_feedback', subject_id: 'x', visibility: 'client', data_class: 'client_confidential',
    source_ref: 'memory/z.md:1', payload: { sentiment: 'loved' }, // schema-valid → rejection is on the missing client_id, not the schema
  });
  const p = promoteClaim(db, r.claim_id, 'alex');
  check('promotion rejected: missing client_id', p.ok === false && /missing client_id/.test(p.error));
  check('claim remains quarantined for correction', listClaims(db).length === 1);
}

// ── 7. Rejection is terminal ──
h('7. reject — a bad claim is rejected with a reason and never routes');
{
  const db = openDb();
  const r = ingestClaim(db, {
    fact_type: 'decision', subject_id: 'wrong', visibility: 'internal', data_class: 'internal',
    source_ref: 'memory/w.md:1', payload: { text: 'misattributed' },
  });
  const rej = rejectClaim(db, r.claim_id, 'alex', 'misattributed source');
  check('reject ok', rej.ok);
  check('gone from quarantine queue', listClaims(db, { status: 'quarantined' }).length === 0);
  check('appears in the rejected set with its reason', listClaims(db, { status: 'rejected' })[0].reason === 'misattributed source');
  check('promote refused after rejection', promoteClaim(db, r.claim_id, 'alex').ok === false);
  check('never routed', countDeliveries(db) === 0);
}

// ── result ──
h(failures === 0 ? '\x1b[32mALL BACKFILL INVARIANTS HOLD ✓\x1b[0m' : `\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`);
process.exit(failures === 0 ? 0 : 1);

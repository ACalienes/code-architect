'use strict';
/**
 * fact_type schema + versioning proof. The validator subset, the starter vocabulary accept/reject,
 * reject-at-the-door (invalid payloads never persist), version stamping, schema evolution (v1→v2
 * without stranding old facts), and registry/core drift. Exits non-zero on any failure.
 *
 *   node prototype/shared-layer/registry.test.js
 */
const { openDb, subscribe, drain, FACT_TYPES } = require('./shared-layer');
const { validate, validatePayload, writeFactValidated, defaultRegistry, registryMatchesCore } = require('./registry');

let failures = 0;
const check = (label, cond) => {
  console.log(`  ${cond ? '✓' : '✗ FAIL'}  ${label}`);
  if (!cond) failures++;
};
const h = (s) => console.log(`\n\x1b[1m${s}\x1b[0m`);

// ── 1. The validator subset ──
h('1. validator — type / required / enum / additionalProperties / nested');
{
  const schema = { type: 'object', required: ['a'], additionalProperties: false,
    properties: { a: { type: 'string', enum: ['x', 'y'] }, n: { type: 'integer' },
      sub: { type: 'object', properties: { z: { type: 'boolean' } }, additionalProperties: false } } };
  check('valid object passes', validate(schema, { a: 'x', n: 3 }).length === 0);
  check('missing required field fails', validate(schema, { n: 3 }).some(e => /a: required/.test(e)));
  check('wrong type fails', validate(schema, { a: 5 }).some(e => /expected string/.test(e)));
  check('enum violation fails', validate(schema, { a: 'q' }).some(e => /not in enum/.test(e)));
  check('non-integer fails integer', validate(schema, { a: 'x', n: 1.5 }).some(e => /expected integer/.test(e)));
  check('unexpected property fails (additionalProperties:false)', validate(schema, { a: 'x', bogus: 1 }).some(e => /unexpected property/.test(e)));
  check('nested error is path-qualified', validate(schema, { a: 'x', sub: { z: 'no' } }).some(e => /sub\.z: expected boolean/.test(e)));
  check('named reserved-metadata keys are allowed', validate(schema, { a: 'x', _schema_ver: '1', _provenance: 'f.md:1' }).length === 0);
  check('an arbitrary _-key (e.g. _api_key) is REJECTED, not waved through', validate(schema, { a: 'x', _api_key: 'sk-leak' }).some(e => /_api_key: unexpected property/.test(e)));
}

// ── 2. The starter vocabulary — accept good, reject bad ──
h('2. default registry — the starter fact_type contracts');
{
  check('good client_feedback passes', validatePayload(defaultRegistry, 'client_feedback', { sentiment: 'loved', note: 'Dan approved' }).ok);
  check('client_feedback missing sentiment fails', !validatePayload(defaultRegistry, 'client_feedback', { note: 'x' }).ok);
  check('client_feedback bad sentiment enum fails', !validatePayload(defaultRegistry, 'client_feedback', { sentiment: 'thrilled' }).ok);
  check('client_feedback extra property fails', !validatePayload(defaultRegistry, 'client_feedback', { sentiment: 'loved', secret: 'x' }).ok);
  check('good work_order passes', validatePayload(defaultRegistry, 'work_order', { task: 'ship', priority: 'high' }).ok);
  check('unknown fact_type rejected', !validatePayload(defaultRegistry, 'gossip', {}).ok);
}

// ── 3. Reject at the door — an invalid payload never persists ──
h('3. writeFactValidated — invalid payload rejected before any write');
{
  const db = openDb();
  subscribe(db, 'acd', 'client_feedback', '*');
  const bad = writeFactValidated(db, { fact_type: 'client_feedback', client_id: 'dagdc', visibility: 'client', data_class: 'client_confidential', source_agent: 'x', payload: { sentiment: 'thrilled' } });
  check('write rejected with a schema error', bad.ok === false && /schema/.test(bad.error));
  check('NOTHING persisted (rejected at the door)', db.prepare('SELECT COUNT(*) AS n FROM facts').get().n === 0);
}

// ── 4. Valid write stamps the version and routes through the proven core ──
h('4. writeFactValidated — valid write is stamped and routes normally');
{
  const db = openDb();
  subscribe(db, 'acd', 'client_feedback', '*');
  const ok = writeFactValidated(db, { fact_type: 'client_feedback', client_id: 'dagdc', subject_id: 'memorial-day', visibility: 'client', data_class: 'client_confidential', source_agent: 'dag-repo', payload: { sentiment: 'loved' } });
  check('write accepted + routed (core preflight + routing intact)', ok.ok && ok.routed === 1);
  const got = drain(db, 'acd');
  check('recipient sees the fact stamped with its schema version', got.length === 1 && got[0].payload._schema_ver === '1');
}

// ── 5. Versioning — evolve a schema without stranding old facts ──
h('5. versioning — a v2 schema validates differently; v1 stays selectable');
{
  // a type that gained a required field in v2
  const reg = { note: { current: '2', versions: {
    '1': { type: 'object', required: ['body'], additionalProperties: false, properties: { body: { type: 'string' } } },
    '2': { type: 'object', required: ['body', 'author'], additionalProperties: false, properties: { body: { type: 'string' }, author: { type: 'string' } } },
  } } };
  const payload = { body: 'hi', author: 'alex' };
  check('payload valid under current (v2)', validatePayload(reg, 'note', payload).ok && validatePayload(reg, 'note', payload).version === '2');
  check('same payload validated against v1 fails (extra author)', !validatePayload(reg, 'note', payload, '1').ok);
  check('a v1-shaped payload still validates under v1', validatePayload(reg, 'note', { body: 'hi' }, '1').ok);
  check('unknown version is rejected', !validatePayload(reg, 'note', payload, '9').ok);
}

// ── 6. Registry/core drift guard ──
h('6. drift — the vocabulary and the core accepted-types agree');
{
  check('defaultRegistry matches core FACT_TYPES', registryMatchesCore());
  check('every default type is a core type', Object.keys(defaultRegistry).every(t => FACT_TYPES.has(t)));
}

h(failures === 0 ? '\x1b[32mALL REGISTRY INVARIANTS HOLD ✓\x1b[0m' : `\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`);
process.exit(failures === 0 ? 0 : 1);

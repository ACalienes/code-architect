'use strict';
/**
 * fact_type schema + versioning — Shared Layer hardening roadmap increment #6.
 * Code Architect · 2026-05-25. This is the action-vocabulary registry made concrete (the systemic
 * fix for the fleet's silent-failure class): each fact_type has a typed PAYLOAD contract + a
 * version, validated at the door so a mis-tagged or malformed payload is rejected before it persists
 * — extending the proven B2/S6 preflight from "is the type name known" to "does the payload conform".
 *
 * Surgical by design: this sits ON TOP of the proven core. writeFactValidated() validates then calls
 * the unchanged writeFact(), so the core (and its 139 green checks) is untouched. Production enables
 * the registry; lenient writeFact() stays available. Zero-install: a small, well-tested JSON-Schema
 * SUBSET validator (type/required/properties/enum/additionalProperties/items) rather than a dep;
 * production may swap in ajv behind the same validatePayload() surface.
 *
 * Versioning: a fact_type maps to { current, versions:{ver:schema} }. A fact is stamped with the
 * version it validated against (payload._schema_ver) so a later schema bump doesn't strand old facts
 * — a reader knows which contract produced each fact. Adding a v2 never invalidates v1-stamped facts.
 */

const { writeFact, FACT_TYPES } = require('./shared-layer');

// ── Minimal JSON-Schema-subset validator. Returns an array of human-readable errors ([] = valid).
function validate(schema, value, p = '') {
  const errs = [];
  const isType = (t, v) => ({
    string: typeof v === 'string', number: typeof v === 'number',
    integer: typeof v === 'number' && Number.isInteger(v), boolean: typeof v === 'boolean',
    array: Array.isArray(v), object: v != null && typeof v === 'object' && !Array.isArray(v),
  }[t] ?? true);

  const at = p ? p.replace(/\.$/, '') : 'value'; // drop the trailing '.' for leaf messages
  if (schema.type && !isType(schema.type, value)) { errs.push(`${at}: expected ${schema.type}`); return errs; }
  if (schema.enum && !schema.enum.includes(value)) errs.push(`${at}: not in enum [${schema.enum.join(', ')}]`);
  if (schema.type === 'object') {
    const props = schema.properties || {};
    for (const r of schema.required || []) if (!(r in value)) errs.push(`${p}${r}: required`);
    if (schema.additionalProperties === false)
      for (const k of Object.keys(value))
        // '_'-prefixed keys are reserved layer metadata (_schema_ver, _provenance) and always allowed
        if (!(k in props) && !k.startsWith('_')) errs.push(`${p}${k}: unexpected property`);
    for (const k of Object.keys(props)) if (k in value) errs.push(...validate(props[k], value[k], `${p}${k}.`));
  }
  if (schema.type === 'array' && schema.items && Array.isArray(value))
    value.forEach((it, i) => errs.push(...validate(schema.items, it, `${p}${i}.`)));
  return errs;
}

// ── The starter vocabulary. Each fact_type → { current, versions }. Mirrors the core FACT_TYPES. ──
const S = (required, properties) => ({ type: 'object', required, properties, additionalProperties: false });
const defaultRegistry = {
  client_feedback: { current: '1', versions: { '1':
    S(['sentiment'], { sentiment: { type: 'string', enum: ['loved', 'liked', 'neutral', 'disliked', 'rejected'] },
      note: { type: 'string' }, subject_ref: { type: 'string' } }) } },
  creative_brief: { current: '1', versions: { '1':
    S(['title'], { title: { type: 'string' }, brief: { type: 'string' }, client_ref: { type: 'string' } }) } },
  decision: { current: '1', versions: { '1':
    S(['text'], { text: { type: 'string' }, rationale: { type: 'string' } }) } },
  status_update: { current: '1', versions: { '1':
    S(['status'], { status: { type: 'string' }, detail: { type: 'string' } }) } },
  work_order: { current: '1', versions: { '1':
    S(['task'], { task: { type: 'string' }, priority: { type: 'string', enum: ['low', 'med', 'high'] } }) } },
};

/** Validate a payload against a fact_type's schema (a specific version, else its current). */
function validatePayload(registry, factType, payload, ver) {
  const entry = registry[factType];
  if (!entry) return { ok: false, errors: [`unknown fact_type '${factType}'`] };
  const version = ver || entry.current;
  const schema = entry.versions[version];
  if (!schema) return { ok: false, errors: [`unknown schema version '${version}' for '${factType}'`], version };
  const errors = validate(schema, payload ?? {});
  return { ok: errors.length === 0, errors, version };
}

/**
 * The validated write path: reject a non-conforming payload AT THE DOOR (never persisted), else
 * stamp the schema version and hand off to the proven writeFact() (which still runs its own
 * preflight + routing). Drop-in for writeFact when the registry is enabled.
 */
function writeFactValidated(db, fact, registry = defaultRegistry) {
  const v = validatePayload(registry, fact.fact_type, fact.payload);
  if (!v.ok) return { ok: false, error: `payload failed ${fact.fact_type} schema v${v.version || '?'}: ${v.errors.join('; ')}`, errors: v.errors };
  const stamped = { ...fact, payload: { ...(fact.payload || {}), _schema_ver: v.version } };
  return writeFact(db, stamped);
}

/** Registry/core drift guard: the vocabulary and the core's accepted types must agree. */
function registryMatchesCore(registry = defaultRegistry) {
  const reg = new Set(Object.keys(registry));
  return reg.size === FACT_TYPES.size && [...FACT_TYPES].every(t => reg.has(t));
}

module.exports = { validate, validatePayload, writeFactValidated, defaultRegistry, registryMatchesCore };

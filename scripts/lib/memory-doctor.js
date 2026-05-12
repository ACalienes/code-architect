#!/usr/bin/env node
/**
 * memory-doctor.js — Enforces CA memory caps + source-file integrity.
 *
 * Phase 1 W3 scope:
 *   - Cap enforcement (methodology lines, active card count, word budgets,
 *     permanent count + rationale)
 *   - Source-file integrity (SHA-256 drift detection vs ~/.code-architect/source-hashes.json)
 *
 * Deferred (Phase 2+):
 *   - Graph-walk relevance ranking
 *   - Pruning rules + archive proposals
 *   - --re-distill mode
 *
 * Exit codes:
 *   0 = clean
 *   1 = source-file drift
 *   2 = cap violation
 *   3 = configuration error
 *
 * CLI:
 *   node scripts/lib/memory-doctor.js                # full check
 *   node scripts/lib/memory-doctor.js --json         # machine-readable report
 *   node scripts/lib/memory-doctor.js --quiet        # exit-code-only
 *   node scripts/lib/memory-doctor.js --skip-integrity   # skip SHA check (CI mode)
 *
 * Pure functions exported for tests; CLI wrapper at bottom.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_PATHS = {
  methodologyPath: path.join(REPO_ROOT, 'methodology.md'),
  activeDir: path.join(REPO_ROOT, 'memory', 'active'),
  hashesPath: path.join(os.homedir(), '.code-architect', 'source-hashes.json'),
};

const DEFAULT_CAPS = {
  methodologyLines: 200,
  activeCards: 30,
  permanentCards: 5,
  words: { pattern: 100, 'failure-analysis': 200, reference: 100 },
};

// --- Helpers ----------------------------------------------------------------

function readTextSafe(p) {
  try { return fs.readFileSync(p, 'utf8'); }
  catch (_) { return null; }
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function countWords(text) {
  return text.trim().split(/\s+/).filter(w => w.length > 0).length;
}

/**
 * Minimal YAML frontmatter parser — covers the subset CA cards use.
 * Supports top-level scalars, nested metadata.* scalars, inline arrays.
 *
 * @returns {{ frontmatter: object|null, body: string }}
 */
function parseFrontmatter(raw) {
  if (!raw.startsWith('---')) return { frontmatter: null, body: raw };
  const end = raw.indexOf('\n---', 3);
  if (end === -1) return { frontmatter: null, body: raw };

  const fmBlock = raw.slice(3, end).trim();
  const bodyStart = raw.indexOf('\n', end + 4);
  const body = bodyStart === -1 ? '' : raw.slice(bodyStart + 1);

  const fm = { metadata: {} };
  let currentKey = null;
  for (const rawLine of fmBlock.split('\n')) {
    const line = rawLine.replace(/\t/g, '  ');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    const stripped = line.trim();

    if (indent === 0) {
      const m = stripped.match(/^([a-z_][a-z0-9_]*)\s*:\s*(.*)$/i);
      if (!m) continue;
      const [, key, val] = m;
      if (val === '' || val === '{}') {
        if (key !== 'metadata') fm[key] = {};
        currentKey = key;
      } else {
        fm[key] = parseScalar(val);
        currentKey = null;
      }
    } else if (indent >= 2 && currentKey === 'metadata') {
      const m = stripped.match(/^([a-z_][a-z0-9_]*)\s*:\s*(.*)$/i);
      if (m) {
        const [, k, v] = m;
        if (v === '' || v === '[]') fm.metadata[k] = v === '[]' ? [] : '';
        else fm.metadata[k] = parseScalar(v);
      }
    } else if (indent >= 4 && currentKey === 'metadata') {
      // Nested list item like:
      //   source_files:
      //     - /abs/path
      const m = stripped.match(/^-\s*(.*)$/);
      if (m) {
        // Find the most recent metadata key with an array value (or empty)
        // and append. Simple heuristic: last assigned empty-array key.
        const lastKey = Object.keys(fm.metadata).reverse().find(k => Array.isArray(fm.metadata[k]));
        if (lastKey) fm.metadata[lastKey].push(parseScalar(m[1]));
      }
    }
  }
  return { frontmatter: fm, body };
}

function parseScalar(val) {
  const t = val.trim();
  if (t === '' || t === '""' || t === "''") return '';
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null' || t === '~') return null;
  if (/^-?\d+$/.test(t)) return parseInt(t, 10);
  if (/^-?\d+\.\d+$/.test(t)) return parseFloat(t);
  if (t.startsWith('[') && t.endsWith(']')) {
    return t.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean);
  }
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

// --- Checks (pure; testable) ------------------------------------------------

function checkMethodology({ methodologyPath, capLines = DEFAULT_CAPS.methodologyLines } = {}) {
  const raw = readTextSafe(methodologyPath);
  if (raw === null) {
    return { lines: null, violations: [], configErrors: [`methodology.md not found at ${methodologyPath}`] };
  }
  const lines = raw.split('\n').length;
  const violations = [];
  if (lines > capLines) {
    violations.push(`methodology.md is ${lines} lines (cap: ${capLines}). Trim before next implement run.`);
  }
  return { lines, violations, configErrors: [] };
}

function checkActiveCards({
  activeDir,
  capCards = DEFAULT_CAPS.activeCards,
  capPermanent = DEFAULT_CAPS.permanentCards,
  capWords = DEFAULT_CAPS.words,
} = {}) {
  if (!fs.existsSync(activeDir)) {
    return { count: null, permanentCount: null, violations: [], configErrors: [`memory/active/ not found at ${activeDir}`] };
  }
  const cards = fs.readdirSync(activeDir).filter(f => f.endsWith('.md'));
  const violations = [];
  if (cards.length > capCards) {
    violations.push(`memory/active/ has ${cards.length} cards (cap: ${capCards}). Archive one before adding more.`);
  }

  let permanentCount = 0;
  for (const file of cards) {
    const full = path.join(activeDir, file);
    const raw = readTextSafe(full);
    if (raw === null) continue;
    const { frontmatter, body } = parseFrontmatter(raw);
    if (!frontmatter) {
      violations.push(`${file}: missing or malformed YAML frontmatter`);
      continue;
    }
    const type = frontmatter.metadata?.type;
    if (!type || !(type in capWords)) {
      violations.push(`${file}: invalid or missing metadata.type (must be one of ${Object.keys(capWords).join(', ')})`);
    } else {
      const wordCap = capWords[type];
      const words = countWords(body);
      if (words > wordCap) {
        violations.push(`${file}: body has ${words} words (cap: ${wordCap} for ${type})`);
      }
    }
    if (frontmatter.metadata?.permanent === true) {
      permanentCount++;
      const rationale = frontmatter.metadata?.permanent_rationale;
      if (!rationale || (typeof rationale === 'string' && rationale.trim() === '')) {
        violations.push(`${file}: permanent: true requires non-empty permanent_rationale`);
      }
    }
  }
  if (permanentCount > capPermanent) {
    violations.push(`${permanentCount} cards marked permanent: true (cap: ${capPermanent})`);
  }
  return { count: cards.length, permanentCount, violations, configErrors: [] };
}

function checkSourceIntegrity({ hashesPath } = {}) {
  if (!fs.existsSync(hashesPath)) {
    return {
      drift: [],
      configErrors: [`source-hashes.json not found at ${hashesPath}. Run \`code-architect memory re-distill\` (manual paste of methodology.md sources for now; auto-derivation in Phase 2).`],
    };
  }
  let hashes;
  try { hashes = JSON.parse(fs.readFileSync(hashesPath, 'utf8')); }
  catch (e) { return { drift: [], configErrors: [`source-hashes.json failed to parse: ${e.message}`] }; }

  if (!hashes.sources || !Array.isArray(hashes.sources)) {
    return { drift: [], configErrors: [`source-hashes.json missing 'sources' array`] };
  }

  const drift = [];
  const configErrors = [];
  for (const entry of hashes.sources) {
    const { path: srcPath, sha256: expected } = entry;
    if (!srcPath || !expected) {
      configErrors.push(`source-hashes.json entry missing path or sha256: ${JSON.stringify(entry)}`);
      continue;
    }
    if (!fs.existsSync(srcPath)) {
      drift.push({ path: srcPath, kind: 'missing' });
      continue;
    }
    let actual;
    try { actual = sha256(fs.readFileSync(srcPath)); }
    catch (e) { drift.push({ path: srcPath, kind: 'unreadable', detail: e.message }); continue; }
    if (actual !== expected) drift.push({ path: srcPath, kind: 'changed', expected, actual });
  }
  return { drift, configErrors };
}

function runAll(opts = {}) {
  const paths = { ...DEFAULT_PATHS, ...opts };
  const caps = { ...DEFAULT_CAPS, ...(opts.caps || {}) };

  const methodology = checkMethodology({ methodologyPath: paths.methodologyPath, capLines: caps.methodologyLines });
  const active = checkActiveCards({
    activeDir: paths.activeDir,
    capCards: caps.activeCards,
    capPermanent: caps.permanentCards,
    capWords: caps.words,
  });
  const integrity = opts.skipIntegrity
    ? { drift: [], configErrors: [], skipped: true }
    : checkSourceIntegrity({ hashesPath: paths.hashesPath });

  return {
    methodology_lines: methodology.lines,
    active_card_count: active.count,
    permanent_card_count: active.permanentCount,
    cap_violations: [...methodology.violations, ...active.violations],
    drift: integrity.drift,
    config_errors: [...methodology.configErrors, ...active.configErrors, ...integrity.configErrors],
    integrity_skipped: !!integrity.skipped,
  };
}

function exitCodeFor(findings) {
  if (findings.config_errors.length > 0) return 3;
  if (findings.cap_violations.length > 0) return 2;
  if (findings.drift.length > 0) return 1;
  return 0;
}

// --- CLI --------------------------------------------------------------------

function main() {
  const args = new Set(process.argv.slice(2));
  const quiet = args.has('--quiet');
  const jsonMode = args.has('--json');
  const skipIntegrity = args.has('--skip-integrity');

  const findings = runAll({ skipIntegrity });

  if (jsonMode) {
    process.stdout.write(JSON.stringify(findings, null, 2) + '\n');
  } else if (!quiet) {
    const log = (...a) => console.log(...a);
    const err = (...a) => console.error(...a);
    log(`[memory-doctor] methodology.md: ${findings.methodology_lines ?? '—'} / ${DEFAULT_CAPS.methodologyLines} lines`);
    log(`[memory-doctor] memory/active/: ${findings.active_card_count ?? '—'} / ${DEFAULT_CAPS.activeCards} cards (${findings.permanent_card_count ?? 0} permanent)`);
    if (findings.integrity_skipped) log('[memory-doctor] source-integrity: SKIPPED (--skip-integrity)');
    if (findings.cap_violations.length === 0 && findings.drift.length === 0 && findings.config_errors.length === 0) {
      log('[memory-doctor] CLEAN');
    }
    if (findings.cap_violations.length > 0) {
      err('[memory-doctor] CAP VIOLATIONS:');
      for (const v of findings.cap_violations) err(`  - ${v}`);
    }
    if (findings.drift.length > 0) {
      err('[memory-doctor] SOURCE DRIFT:');
      for (const d of findings.drift) {
        if (d.kind === 'changed') err(`  - changed: ${d.path}\n      expected ${d.expected.slice(0, 12)}…\n      actual   ${d.actual.slice(0, 12)}…`);
        else err(`  - ${d.kind}: ${d.path}${d.detail ? ' (' + d.detail + ')' : ''}`);
      }
      err('  Re-distill methodology.md against current sources, then re-run memory-doctor.');
    }
    if (findings.config_errors.length > 0) {
      err('[memory-doctor] CONFIG ERRORS:');
      for (const e of findings.config_errors) err(`  - ${e}`);
    }
  }
  process.exit(exitCodeFor(findings));
}

if (require.main === module) main();

module.exports = {
  checkMethodology,
  checkActiveCards,
  checkSourceIntegrity,
  runAll,
  exitCodeFor,
  parseFrontmatter,
  countWords,
  DEFAULT_CAPS,
  DEFAULT_PATHS,
};

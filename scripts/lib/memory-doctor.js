#!/usr/bin/env node
/**
 * memory-doctor.js — Enforces CA memory caps + source-file integrity.
 *
 * Tonight's scope (Phase 1 W3):
 *   - Cap enforcement:
 *       methodology.md ≤200 lines
 *       memory/active/ ≤30 markdown cards
 *       pattern card body ≤100 words; failure-analysis body ≤200 words
 *       permanent: true entries ≤5; each requires non-empty permanent_rationale
 *   - Source-file integrity:
 *       Read ~/.code-architect/source-hashes.json
 *       Recompute SHA-256 of every cited absolute path; flag drift
 *
 * Deferred (Phase 2+):
 *   - Graph-walk relevance ranking (no cards exist yet)
 *   - Pruning rules + archive proposals (no run-ledger query target yet)
 *   - --re-distill mode (manual hash refresh)
 *
 * Exit codes:
 *   0 = clean
 *   1 = source-file drift detected
 *   2 = cap violation
 *   3 = configuration error (missing source-hashes.json, malformed frontmatter)
 *
 * CLI:
 *   node scripts/lib/memory-doctor.js                # full check
 *   node scripts/lib/memory-doctor.js --json         # machine-readable report
 *   node scripts/lib/memory-doctor.js --quiet        # exit-code-only, no stdout
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const METHODOLOGY_PATH = path.join(REPO_ROOT, 'methodology.md');
const ACTIVE_DIR = path.join(REPO_ROOT, 'memory', 'active');
const SOURCE_HASHES_PATH = path.join(os.homedir(), '.code-architect', 'source-hashes.json');

// Caps (also documented in memory/MEMORY.md so they survive code+memory drift)
const CAP_METHODOLOGY_LINES = 200;
const CAP_ACTIVE_CARDS = 30;
const CAP_PERMANENT_CARDS = 5;
const CAP_WORDS = { pattern: 100, 'failure-analysis': 200, reference: 100 };

const args = new Set(process.argv.slice(2));
const QUIET = args.has('--quiet');
const JSON_MODE = args.has('--json');

const findings = {
  methodology_lines: null,
  active_card_count: null,
  permanent_card_count: null,
  cap_violations: [],
  drift: [],
  config_errors: [],
};

function log(...a) { if (!QUIET && !JSON_MODE) console.log(...a); }
function err(...a) { if (!QUIET && !JSON_MODE) console.error(...a); }

function readTextSafe(p) {
  try { return fs.readFileSync(p, 'utf8'); }
  catch (e) { return null; }
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// Minimal YAML frontmatter parser — covers the subset CA cards use.
// Supports top-level scalars (key: value) + metadata.* nested scalars +
// simple inline arrays ([a, b, c]).
function parseFrontmatter(raw) {
  if (!raw.startsWith('---')) return { frontmatter: null, body: raw };
  const end = raw.indexOf('\n---', 3);
  if (end === -1) return { frontmatter: null, body: raw };

  const fmBlock = raw.slice(3, end).trim();
  const bodyStart = raw.indexOf('\n', end + 4);
  const body = bodyStart === -1 ? '' : raw.slice(bodyStart + 1);

  const fm = { metadata: {} };
  let currentBlock = fm;
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
        currentBlock = (key === 'metadata') ? fm.metadata : (fm[key] = {});
        currentKey = key;
      } else {
        fm[key] = parseScalar(val);
        currentBlock = fm;
        currentKey = null;
      }
    } else if (indent >= 2 && currentKey === 'metadata') {
      const m = stripped.match(/^([a-z_][a-z0-9_]*)\s*:\s*(.*)$/i);
      if (m) fm.metadata[m[1]] = parseScalar(m[2]);
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
  // Strip surrounding quotes
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

function countWords(text) {
  return text.trim().split(/\s+/).filter(w => w.length > 0).length;
}

// --- Check 1: methodology.md line count -------------------------------------
function checkMethodology() {
  const raw = readTextSafe(METHODOLOGY_PATH);
  if (raw === null) {
    findings.config_errors.push(`methodology.md not found at ${METHODOLOGY_PATH}`);
    return;
  }
  const lines = raw.split('\n').length;
  findings.methodology_lines = lines;
  if (lines > CAP_METHODOLOGY_LINES) {
    findings.cap_violations.push(
      `methodology.md is ${lines} lines (cap: ${CAP_METHODOLOGY_LINES}). Trim before next implement run.`
    );
  }
}

// --- Check 2: memory/active/ cards ------------------------------------------
function checkActiveCards() {
  if (!fs.existsSync(ACTIVE_DIR)) {
    findings.config_errors.push(`memory/active/ not found at ${ACTIVE_DIR}`);
    return;
  }
  const cards = fs.readdirSync(ACTIVE_DIR).filter(f => f.endsWith('.md'));
  findings.active_card_count = cards.length;
  if (cards.length > CAP_ACTIVE_CARDS) {
    findings.cap_violations.push(
      `memory/active/ has ${cards.length} cards (cap: ${CAP_ACTIVE_CARDS}). Archive one before adding more.`
    );
  }

  let permanentCount = 0;
  for (const file of cards) {
    const full = path.join(ACTIVE_DIR, file);
    const raw = readTextSafe(full);
    if (raw === null) continue;
    const { frontmatter, body } = parseFrontmatter(raw);
    if (!frontmatter) {
      findings.cap_violations.push(`${file}: missing or malformed YAML frontmatter`);
      continue;
    }
    const type = frontmatter.metadata?.type;
    if (!type || !(type in CAP_WORDS)) {
      findings.cap_violations.push(`${file}: invalid or missing metadata.type (must be one of ${Object.keys(CAP_WORDS).join(', ')})`);
    } else {
      const wordCap = CAP_WORDS[type];
      const words = countWords(body);
      if (words > wordCap) {
        findings.cap_violations.push(`${file}: body has ${words} words (cap: ${wordCap} for ${type})`);
      }
    }

    if (frontmatter.metadata?.permanent === true) {
      permanentCount++;
      const rationale = frontmatter.metadata?.permanent_rationale;
      if (!rationale || (typeof rationale === 'string' && rationale.trim() === '')) {
        findings.cap_violations.push(`${file}: permanent: true requires non-empty permanent_rationale`);
      }
    }
  }
  findings.permanent_card_count = permanentCount;
  if (permanentCount > CAP_PERMANENT_CARDS) {
    findings.cap_violations.push(
      `${permanentCount} cards marked permanent: true (cap: ${CAP_PERMANENT_CARDS})`
    );
  }
}

// --- Check 3: source-file integrity -----------------------------------------
function checkSourceIntegrity() {
  if (!fs.existsSync(SOURCE_HASHES_PATH)) {
    findings.config_errors.push(`source-hashes.json not found at ${SOURCE_HASHES_PATH}. Run \`code-architect memory re-distill\` to generate it (manual paste of methodology.md sources for now; auto-derivation in Phase 2).`);
    return;
  }
  let hashes;
  try {
    hashes = JSON.parse(fs.readFileSync(SOURCE_HASHES_PATH, 'utf8'));
  } catch (e) {
    findings.config_errors.push(`source-hashes.json failed to parse: ${e.message}`);
    return;
  }
  if (!hashes.sources || !Array.isArray(hashes.sources)) {
    findings.config_errors.push(`source-hashes.json missing 'sources' array`);
    return;
  }

  for (const entry of hashes.sources) {
    const { path: srcPath, sha256: expected } = entry;
    if (!srcPath || !expected) {
      findings.config_errors.push(`source-hashes.json entry missing path or sha256: ${JSON.stringify(entry)}`);
      continue;
    }
    if (!fs.existsSync(srcPath)) {
      findings.drift.push({ path: srcPath, kind: 'missing' });
      continue;
    }
    let actual;
    try {
      actual = sha256(fs.readFileSync(srcPath));
    } catch (e) {
      findings.drift.push({ path: srcPath, kind: 'unreadable', detail: e.message });
      continue;
    }
    if (actual !== expected) {
      findings.drift.push({ path: srcPath, kind: 'changed', expected, actual });
    }
  }
}

// --- Run ---------------------------------------------------------------------
checkMethodology();
checkActiveCards();
checkSourceIntegrity();

if (JSON_MODE) {
  process.stdout.write(JSON.stringify(findings, null, 2) + '\n');
} else {
  log(`[memory-doctor] methodology.md: ${findings.methodology_lines ?? '—'} / ${CAP_METHODOLOGY_LINES} lines`);
  log(`[memory-doctor] memory/active/: ${findings.active_card_count ?? '—'} / ${CAP_ACTIVE_CARDS} cards (${findings.permanent_card_count ?? 0} permanent)`);
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

if (findings.config_errors.length > 0) process.exit(3);
if (findings.cap_violations.length > 0) process.exit(2);
if (findings.drift.length > 0) process.exit(1);
process.exit(0);

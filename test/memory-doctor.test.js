'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const {
  checkMethodology,
  checkActiveCards,
  checkSourceIntegrity,
  runAll,
  exitCodeFor,
  parseFrontmatter,
  countWords,
  DEFAULT_CAPS,
} = require('../scripts/lib/memory-doctor');

const REPO_ROOT = path.resolve(__dirname, '..');
const CLI_PATH = path.join(REPO_ROOT, 'scripts', 'code-architect.js');
const DOCTOR_PATH = path.join(REPO_ROOT, 'scripts', 'lib', 'memory-doctor.js');

function mkTmp(prefix = 'ca-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function writeCard(dir, name, frontmatter, body) {
  const fm = ['---', ...Object.entries(frontmatter).map(([k, v]) => {
    if (k === 'metadata' && typeof v === 'object') {
      return 'metadata:\n' + Object.entries(v).map(([mk, mv]) => `  ${mk}: ${JSON.stringify(mv)}`).join('\n');
    }
    return `${k}: ${JSON.stringify(v)}`;
  }), '---', '', body, ''].join('\n');
  fs.writeFileSync(path.join(dir, name), fm);
}

// ============================================================================
// checkMethodology
// ============================================================================

test('checkMethodology: reports line count and no violations on small file', () => {
  const tmp = mkTmp();
  try {
    const p = path.join(tmp, 'methodology.md');
    fs.writeFileSync(p, 'a\nb\nc\n');
    const r = checkMethodology({ methodologyPath: p });
    assert.equal(r.lines, 4);
    assert.deepEqual(r.violations, []);
    assert.deepEqual(r.configErrors, []);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('checkMethodology: triggers cap violation when over limit', () => {
  const tmp = mkTmp();
  try {
    const p = path.join(tmp, 'methodology.md');
    fs.writeFileSync(p, Array(250).fill('line').join('\n'));
    const r = checkMethodology({ methodologyPath: p, capLines: 200 });
    assert.equal(r.lines, 250);
    assert.equal(r.violations.length, 1);
    assert.match(r.violations[0], /250 lines/);
    assert.match(r.violations[0], /cap: 200/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('checkMethodology: missing file reports configError', () => {
  const tmp = mkTmp();
  try {
    const r = checkMethodology({ methodologyPath: path.join(tmp, 'nope.md') });
    assert.equal(r.lines, null);
    assert.equal(r.configErrors.length, 1);
    assert.match(r.configErrors[0], /not found/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

// ============================================================================
// checkActiveCards
// ============================================================================

test('checkActiveCards: empty directory reports count 0, no violations', () => {
  const tmp = mkTmp();
  try {
    fs.mkdirSync(path.join(tmp, 'active'));
    const r = checkActiveCards({ activeDir: path.join(tmp, 'active') });
    assert.equal(r.count, 0);
    assert.equal(r.permanentCount, 0);
    assert.deepEqual(r.violations, []);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('checkActiveCards: missing directory reports configError', () => {
  const tmp = mkTmp();
  try {
    const r = checkActiveCards({ activeDir: path.join(tmp, 'no-such-dir') });
    assert.equal(r.configErrors.length, 1);
    assert.match(r.configErrors[0], /not found/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('checkActiveCards: well-formed pattern card passes', () => {
  const tmp = mkTmp();
  try {
    const active = path.join(tmp, 'active');
    fs.mkdirSync(active);
    writeCard(active, 'a.md',
      { name: 'a', description: 'd', metadata: { type: 'pattern', permanent: false, word_budget: 100 } },
      'short body of a few words'
    );
    const r = checkActiveCards({ activeDir: active });
    assert.equal(r.count, 1);
    assert.equal(r.permanentCount, 0);
    assert.deepEqual(r.violations, []);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('checkActiveCards: pattern card over word budget triggers violation', () => {
  const tmp = mkTmp();
  try {
    const active = path.join(tmp, 'active');
    fs.mkdirSync(active);
    writeCard(active, 'a.md',
      { name: 'a', description: 'd', metadata: { type: 'pattern' } },
      Array(150).fill('word').join(' ')
    );
    const r = checkActiveCards({ activeDir: active });
    assert.equal(r.count, 1);
    assert.equal(r.violations.length, 1);
    assert.match(r.violations[0], /150 words.*cap: 100/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('checkActiveCards: failure-analysis card has 200-word cap', () => {
  const tmp = mkTmp();
  try {
    const active = path.join(tmp, 'active');
    fs.mkdirSync(active);
    writeCard(active, 'a.md',
      { name: 'a', description: 'd', metadata: { type: 'failure-analysis' } },
      Array(150).fill('word').join(' ')
    );
    const r = checkActiveCards({ activeDir: active });
    assert.deepEqual(r.violations, []); // 150 < 200 → clean

    writeCard(active, 'b.md',
      { name: 'b', description: 'd', metadata: { type: 'failure-analysis' } },
      Array(250).fill('word').join(' ')
    );
    const r2 = checkActiveCards({ activeDir: active });
    assert.equal(r2.violations.length, 1);
    assert.match(r2.violations[0], /250 words.*cap: 200/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('checkActiveCards: missing metadata.type triggers violation', () => {
  const tmp = mkTmp();
  try {
    const active = path.join(tmp, 'active');
    fs.mkdirSync(active);
    writeCard(active, 'a.md', { name: 'a', description: 'd', metadata: { permanent: false } }, 'body');
    const r = checkActiveCards({ activeDir: active });
    assert.equal(r.violations.length, 1);
    assert.match(r.violations[0], /missing metadata\.type/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('checkActiveCards: malformed frontmatter triggers violation', () => {
  const tmp = mkTmp();
  try {
    const active = path.join(tmp, 'active');
    fs.mkdirSync(active);
    fs.writeFileSync(path.join(active, 'a.md'), 'no frontmatter here\njust body\n');
    const r = checkActiveCards({ activeDir: active });
    assert.equal(r.violations.length, 1);
    assert.match(r.violations[0], /malformed YAML frontmatter/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('checkActiveCards: permanent: true without rationale triggers violation', () => {
  const tmp = mkTmp();
  try {
    const active = path.join(tmp, 'active');
    fs.mkdirSync(active);
    writeCard(active, 'p.md',
      { name: 'p', description: 'd', metadata: { type: 'pattern', permanent: true, permanent_rationale: '' } },
      'body'
    );
    const r = checkActiveCards({ activeDir: active });
    assert.equal(r.permanentCount, 1);
    assert.ok(r.violations.some(v => /permanent_rationale/.test(v)));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('checkActiveCards: permanent with non-empty rationale passes', () => {
  const tmp = mkTmp();
  try {
    const active = path.join(tmp, 'active');
    fs.mkdirSync(active);
    writeCard(active, 'p.md',
      { name: 'p', description: 'd', metadata: { type: 'pattern', permanent: true, permanent_rationale: 'core ethic' } },
      'body'
    );
    const r = checkActiveCards({ activeDir: active });
    assert.equal(r.permanentCount, 1);
    assert.deepEqual(r.violations, []);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('checkActiveCards: permanent count over cap triggers violation', () => {
  const tmp = mkTmp();
  try {
    const active = path.join(tmp, 'active');
    fs.mkdirSync(active);
    for (let i = 0; i < 6; i++) {
      writeCard(active, `p${i}.md`,
        { name: `p${i}`, description: 'd', metadata: { type: 'pattern', permanent: true, permanent_rationale: 'r' } },
        'body'
      );
    }
    const r = checkActiveCards({ activeDir: active, capPermanent: 5 });
    assert.equal(r.permanentCount, 6);
    assert.ok(r.violations.some(v => /6.*permanent.*cap: 5/.test(v)));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('checkActiveCards: cards over cap triggers violation', () => {
  const tmp = mkTmp();
  try {
    const active = path.join(tmp, 'active');
    fs.mkdirSync(active);
    for (let i = 0; i < 31; i++) {
      writeCard(active, `c${i}.md`,
        { name: `c${i}`, description: 'd', metadata: { type: 'pattern' } },
        'body'
      );
    }
    const r = checkActiveCards({ activeDir: active, capCards: 30 });
    assert.equal(r.count, 31);
    assert.ok(r.violations.some(v => /31 cards.*cap: 30/.test(v)));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

// ============================================================================
// checkSourceIntegrity
// ============================================================================

test('checkSourceIntegrity: missing hashes file reports configError', () => {
  const tmp = mkTmp();
  try {
    const r = checkSourceIntegrity({ hashesPath: path.join(tmp, 'nope.json') });
    assert.equal(r.configErrors.length, 1);
    assert.match(r.configErrors[0], /not found/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('checkSourceIntegrity: matching hashes reports clean', () => {
  const tmp = mkTmp();
  try {
    const sourcePath = path.join(tmp, 'source.md');
    fs.writeFileSync(sourcePath, 'unchanged content');
    const hashesPath = path.join(tmp, 'hashes.json');
    fs.writeFileSync(hashesPath, JSON.stringify({
      schema_version: 1,
      sources: [{ path: sourcePath, sha256: sha256(fs.readFileSync(sourcePath)) }],
    }));
    const r = checkSourceIntegrity({ hashesPath });
    assert.deepEqual(r.drift, []);
    assert.deepEqual(r.configErrors, []);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('checkSourceIntegrity: modified source triggers drift', () => {
  const tmp = mkTmp();
  try {
    const sourcePath = path.join(tmp, 'source.md');
    fs.writeFileSync(sourcePath, 'original');
    const originalHash = sha256(fs.readFileSync(sourcePath));
    fs.writeFileSync(sourcePath, 'modified');
    const hashesPath = path.join(tmp, 'hashes.json');
    fs.writeFileSync(hashesPath, JSON.stringify({
      sources: [{ path: sourcePath, sha256: originalHash }],
    }));
    const r = checkSourceIntegrity({ hashesPath });
    assert.equal(r.drift.length, 1);
    assert.equal(r.drift[0].kind, 'changed');
    assert.equal(r.drift[0].expected, originalHash);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('checkSourceIntegrity: missing source file flagged as missing', () => {
  const tmp = mkTmp();
  try {
    const hashesPath = path.join(tmp, 'hashes.json');
    fs.writeFileSync(hashesPath, JSON.stringify({
      sources: [{ path: path.join(tmp, 'never-existed.md'), sha256: 'abc' }],
    }));
    const r = checkSourceIntegrity({ hashesPath });
    assert.equal(r.drift.length, 1);
    assert.equal(r.drift[0].kind, 'missing');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('checkSourceIntegrity: malformed JSON reports configError', () => {
  const tmp = mkTmp();
  try {
    const hashesPath = path.join(tmp, 'hashes.json');
    fs.writeFileSync(hashesPath, '{not valid json');
    const r = checkSourceIntegrity({ hashesPath });
    assert.equal(r.configErrors.length, 1);
    assert.match(r.configErrors[0], /failed to parse/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

// ============================================================================
// exitCodeFor + runAll
// ============================================================================

test('exitCodeFor: clean → 0, drift → 1, cap → 2, configError → 3 (priority order)', () => {
  assert.equal(exitCodeFor({ config_errors: [], cap_violations: [], drift: [] }), 0);
  assert.equal(exitCodeFor({ config_errors: [], cap_violations: [], drift: [{ path: 'x', kind: 'changed' }] }), 1);
  assert.equal(exitCodeFor({ config_errors: [], cap_violations: ['over'], drift: [] }), 2);
  assert.equal(exitCodeFor({ config_errors: ['missing'], cap_violations: [], drift: [] }), 3);
  // configError dominates
  assert.equal(exitCodeFor({ config_errors: ['x'], cap_violations: ['y'], drift: [{}] }), 3);
});

test('runAll: skipIntegrity bypasses source-hash check', () => {
  const tmp = mkTmp();
  try {
    const methodologyPath = path.join(tmp, 'methodology.md');
    const activeDir = path.join(tmp, 'active');
    const hashesPath = path.join(tmp, 'hashes.json'); // does not exist
    fs.writeFileSync(methodologyPath, 'line\n');
    fs.mkdirSync(activeDir);
    const r = runAll({ methodologyPath, activeDir, hashesPath, skipIntegrity: true });
    assert.equal(r.integrity_skipped, true);
    assert.deepEqual(r.config_errors, []);
    assert.deepEqual(r.drift, []);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

// ============================================================================
// parseFrontmatter helpers
// ============================================================================

test('parseFrontmatter: extracts top-level + metadata scalars', () => {
  const { frontmatter, body } = parseFrontmatter('---\nname: foo\nmetadata:\n  type: pattern\n  permanent: true\n---\nbody here\n');
  assert.equal(frontmatter.name, 'foo');
  assert.equal(frontmatter.metadata.type, 'pattern');
  assert.equal(frontmatter.metadata.permanent, true);
  assert.equal(body.trim(), 'body here');
});

test('parseFrontmatter: no frontmatter returns null', () => {
  const { frontmatter } = parseFrontmatter('just body\nno fm\n');
  assert.equal(frontmatter, null);
});

test('countWords: handles whitespace correctly', () => {
  assert.equal(countWords('one two three'), 3);
  assert.equal(countWords('  one\n  two  \nthree '), 3);
  assert.equal(countWords(''), 0);
  assert.equal(countWords('   '), 0);
});

// ============================================================================
// CLI exit codes (subprocess)
// ============================================================================

test('CLI: --version exits 0', () => {
  const r = spawnSync(process.execPath, [CLI_PATH, '--version']);
  assert.equal(r.status, 0);
  assert.match(r.stdout.toString(), /^\d+\.\d+\.\d+/);
});

test('CLI: --help exits 0', () => {
  const r = spawnSync(process.execPath, [CLI_PATH, '--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout.toString(), /Usage/);
});

test('CLI: unknown subcommand exits 64', () => {
  const r = spawnSync(process.execPath, [CLI_PATH, 'implement', 'foo']);
  assert.equal(r.status, 64);
});

test('CLI: memory doctor --skip-integrity on this repo exits 0', () => {
  const r = spawnSync(process.execPath, [CLI_PATH, 'memory', 'doctor', '--skip-integrity']);
  assert.equal(r.status, 0, `stderr: ${r.stderr.toString()}`);
});

test('memory-doctor.js direct invocation with --skip-integrity exits 0', () => {
  const r = spawnSync(process.execPath, [DOCTOR_PATH, '--skip-integrity']);
  assert.equal(r.status, 0, `stderr: ${r.stderr.toString()}`);
});

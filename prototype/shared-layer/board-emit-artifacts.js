'use strict';
/**
 * Generic ARTIFACT emitter — watches an agent's output dir and emits "produced X" when a NEW artifact
 * appears, at a configured granularity:
 *   - 'file'  : one event per matching file (ACD brand audits, KMG drafts).
 *   - 'dir'   : one event per directory at `depth` levels under the watch root (Framer builds —
 *               one post per project, NEVER per slide). [Codex #3]
 * "Build complete" guard (Codex #3): an artifact is emittable only once its mtime is QUIET (no writes
 * for QUIET_MS) — so a half-written build is never posted. Payloads are minimal metadata only — name +
 * relative path, never file bodies (Codex #8). Settle/quarantine + health-gate + per-config isolation.
 *
 *   node board-emit-artifacts.js --dry-run
 *   BOARD_URL=http://100.64.114.13:3351 node board-emit-artifacts.js --emit-all
 *   pm2 start board-emit-artifacts.js --name board-emit-artifacts -- --watch
 */
const fs = require('node:fs');
const path = require('node:path');
const lib = require('./board-emit-lib');
const HOME = lib.HOME;

const URL = process.env.BOARD_URL || 'http://100.64.114.13:3351';
const DRY = process.argv.includes('--dry-run');
const WATCH = process.argv.includes('--watch');
const EMIT_ALL = process.argv.includes('--emit-all');
const RECENT = process.env.EMIT_RECENT ? Number(process.env.EMIT_RECENT) : 12;   // newest-N per agent (avoid history dump)
const QUIET_MS = Number(process.env.EMIT_QUIET_MS || 120000);                    // artifact must be untouched this long
const INTERVAL = 30000;
const IGNORE = /(^\.|\.tmp$|\.part$|~$|\.DS_Store|node_modules|\.git|^README|^CHANGELOG|^index\.|package(-lock)?\.json)/i;
const titleize = s => s.replace(/[-_/]/g, ' ').replace(/\.\w+$/, '').replace(/\s+/g, ' ').trim();

const CONFIG = [
  { agent: 'framer', root: path.join(HOME, 'framer', 'outputs'),                         mode: 'dir',  depth: 2, subject: 'framer-build',  verb: 'rendered a build' },
  { agent: 'acd',    root: path.join(HOME, 'acd', 'knowledge', 'brand-audits'),          mode: 'file', exts: ['.md'], subject: 'acd-brand-audit', verb: 'produced a brand audit' },
  { agent: 'kmg',    root: path.join(HOME, 'kmg', 'memory', 'drafts'),                   mode: 'file', exts: ['.md', '.json'], subject: 'kmg-draft', verb: 'drafted' },
];

function dirsAtDepth(root, depth) {
  let level = [root];
  for (let d = 0; d < depth; d++) {
    const next = [];
    for (const dir of level) {
      let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) {}
      for (const e of ents) if (e.isDirectory() && !IGNORE.test(e.name)) next.push(path.join(dir, e.name));
    }
    level = next;
  }
  return level;
}
function filesUnder(root, exts) {
  const out = [];
  const walk = dir => { let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) {} for (const e of ents) { if (IGNORE.test(e.name)) continue; const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else if (e.isFile() && (!exts || exts.includes(path.extname(e.name)))) out.push(p); } };
  walk(root); return out;
}
const treeMtime = p => {   // newest mtime in the subtree (for the QUIET "build complete" check)
  let m = 0; const st = (x) => { try { const s = fs.statSync(x); if (s.mtimeMs > m) m = s.mtimeMs; if (s.isDirectory()) for (const e of fs.readdirSync(x)) st(path.join(x, e)); } catch (_) {} };
  st(p); return m;
};

function collect(c) {
  const items = (c.mode === 'dir' ? dirsAtDepth(c.root, c.depth) : filesUnder(c.root, c.exts))
    .map(p => ({ p, rel: path.relative(c.root, p), mtime: c.mode === 'dir' ? treeMtime(p) : (fs.statSync(p).mtimeMs) }))
    .sort((a, b) => b.mtime - a.mtime);
  return items.slice(0, RECENT);
}

async function runOne(c) {
  const stateFile = path.join(HOME, '.kameha', `board-emit-artifacts-${c.agent}.state.json`);
  let token; try { token = lib.readToken(c.agent); } catch (_) { console.error(`[artifacts] ${c.agent}: no token — skip`); return; }
  if (!fs.existsSync(c.root)) { console.error(`[artifacts] ${c.agent}: no root ${c.root} — skip`); return; }

  const items = collect(c);
  const prev = lib.loadSeen(stateFile);
  const baseline = !prev && !EMIT_ALL;
  const seen = prev || new Set();
  const now = Date.now();

  if (baseline) { for (const it of items) seen.add(it.rel); if (!DRY) lib.saveSeen(stateFile, seen); console.log(`[artifacts] ${c.agent}: baseline (${items.length}) — new from here`); return; }

  const events = [];
  for (const it of items) {
    if (seen.has(it.rel)) continue;
    if (now - it.mtime < QUIET_MS) continue;       // build-complete guard: still being written → wait
    events.push({
      key: it.rel,
      idem: lib.idemKey(`${c.agent}:artifact`, it.rel),
      // payload must satisfy the status_update schema exactly ({status, detail}); the human title is the
      // minimized metadata (no file bodies/paths beyond the title — Codex #8). subject carries the rel.
      fact: { fact_type: 'status_update', visibility: 'internal', data_class: 'internal', subject_type: 'work', subject_id: c.subject, payload: { status: 'update', detail: lib.clip(`${c.verb}: ${titleize(it.rel)}`) } },
    });
  }

  if (DRY) { console.log(`[artifacts] ${c.agent}: would post ${events.length} of ${items.length} (rest seen/not-quiet)`); events.slice(0, 6).forEach(e => console.log(`    • ${lib.clip(e.fact.payload.detail, 70)}`)); return; }
  if (!events.length) return;
  if (!(await lib.healthGate(URL, { onLog: m => console.error(`[artifacts] ${c.agent}: ${m}`) }))) { console.error(`[artifacts] ${c.agent}: gateway not writable — ${events.length} pending`); return; }
  const r = await lib.postEvents(events, { url: URL, token, agent: c.agent, onLog: m => console.error(`[artifacts] ${c.agent}: ${m}`) });
  for (const e of events) if (r.settled.has(e.key)) seen.add(e.key);
  lib.saveSeen(stateFile, seen);
  console.log(`[artifacts] ${c.agent}: ${r.posted} posted, ${r.quarantined} quarantined, ${r.pending} pending`);
}

async function tick() { for (const c of CONFIG) { try { await runOne(c); } catch (e) { console.error(`[artifacts] ${c.agent}: ${e.message}`); } } }

tick().catch(e => console.error('[artifacts] error:', e.message));
if (WATCH && !DRY) {
  setInterval(() => tick().catch(e => console.error('[artifacts] tick error:', e.message)), INTERVAL);
  console.log(`[artifacts] watching ${CONFIG.map(c => c.agent).join(', ')} → ${URL}, every 30s`);
}

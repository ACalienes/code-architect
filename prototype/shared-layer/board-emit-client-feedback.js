'use strict';
/**
 * board-emit-client-feedback — bridges per-client notes/feedback/*.md into the Board as
 * client_feedback facts, tagged with the right client_id. This is the structure Alex actually uses:
 *   ~/Desktop/Code/<Client>/notes/feedback/<dated>.md
 * Each new file becomes a fact (sentiment classified from content, first meaningful line as the note).
 * Posts as `kai` (chief of staff surfaces client feedback to the team).
 *
 *   node board-emit-client-feedback.js --dry-run
 *   BOARD_URL=http://100.64.114.13:3351 node board-emit-client-feedback.js --emit-all
 *   pm2 start board-emit-client-feedback.js --name board-emit-client-feedback -- --watch
 */
const fs = require('node:fs');
const path = require('node:path');
const lib = require('./board-emit-lib');
const HOME = lib.HOME;

const URL = process.env.BOARD_URL || 'http://100.64.114.13:3351';
const DRY = process.argv.includes('--dry-run');
const WATCH = process.argv.includes('--watch');
const EMIT_ALL = process.argv.includes('--emit-all');
const INTERVAL = 30000;

const CONFIG = [
  { client_id: 'tdb',   dir: path.join(HOME, 'Desktop/Code/The Dental Boutique/notes/feedback'), name: 'Dental Boutique' },
  { client_id: 'dagdc', dir: path.join(HOME, 'Desktop/Code/DAGDC/notes/feedback'),                name: 'DAGDC' },
];

const POS_LOVED   = /\b(love|amazing|excellent|perfect|brilliant|fantastic|gorgeous)\b/i;
const POS_LIKED   = /\b(like|great|good|nice|pleased|happy|approved?|appreciat)/i;
const NEG_HARD    = /\b(reject|terrible|awful|hate|unacceptable|wrong|stop|kill it)\b/i;
const NEG_SOFT    = /\b(dislike|disappointed|frustrat|concern|issue|problem|broken|fix|off|wrong)\b/i;
function classifySentiment(text) {
  if (POS_LOVED.test(text)) return 'loved';
  if (NEG_HARD.test(text))  return 'rejected';
  if (POS_LIKED.test(text)) return 'liked';
  if (NEG_SOFT.test(text))  return 'disliked';
  return 'neutral';
}

// Take the first meaningful line: skip yaml front-matter, headings, blank lines.
function firstMeaningfulLine(text, maxLen = 220) {
  const all = text.split('\n');
  let start = 0;
  if (all[0] && all[0].trim() === '---') { const end = all.indexOf('---', 1); if (end > 0) start = end + 1; }
  for (let i = start; i < all.length; i++) {
    const l = all[i].trim();
    if (!l) continue;
    if (l.startsWith('#')) continue;
    if (l.startsWith('---')) continue;
    return l.slice(0, maxLen);
  }
  return all.find(l => l.trim()) || '';
}

async function runOne(c) {
  if (!fs.existsSync(c.dir)) { console.error(`[cf] ${c.client_id}: no dir (${c.dir}) — skip`); return; }
  const stateFile = path.join(HOME, '.kameha', `board-emit-clientfb-${c.client_id}.state.json`);
  let token; try { token = lib.readToken('kai'); }
  catch (_) { console.error(`[cf] ${c.client_id}: no 'kai' token — skip`); return; }

  const files = fs.readdirSync(c.dir)
    .filter(n => n.endsWith('.md') && !/^README/i.test(n))
    .map(n => path.join(c.dir, n))
    .map(p => ({ p, rel: path.basename(p), mtime: fs.statSync(p).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  const prev = lib.loadSeen(stateFile);
  const baseline = !prev && !EMIT_ALL;
  const seen = prev || new Set();

  if (baseline) {
    for (const f of files) seen.add(f.rel);
    if (!DRY) lib.saveSeen(stateFile, seen);
    console.log(`[cf] ${c.client_id}: baseline (${files.length}) — posting new from here`);
    return;
  }

  const events = [];
  for (const f of files) {
    if (seen.has(f.rel)) continue;
    let text = ''; try { text = fs.readFileSync(f.p, 'utf8'); } catch (_) {}
    if (!text.trim()) { seen.add(f.rel); continue; }
    if (lib.looksSecret(text)) { lib.quarantine('kai', { client_id: c.client_id, rel: f.rel }, 'looks_secret'); seen.add(f.rel); continue; }
    const note = lib.clip(firstMeaningfulLine(text), 220);
    const sentiment = classifySentiment(text);
    events.push({
      key: f.rel,
      idem: lib.idemKey(`${c.client_id}:feedback`, f.rel),
      fact: { fact_type: 'client_feedback', visibility: 'client', data_class: 'client_confidential',
        client_id: c.client_id, subject_type: 'client', subject_id: c.client_id,
        payload: { sentiment, note, subject_ref: f.rel } },
    });
  }

  if (DRY) {
    console.log(`[cf] ${c.client_id}: would post ${events.length} feedback item(s)`);
    events.slice(0, 5).forEach(e => console.log(`    • [${e.fact.payload.sentiment}] ${e.fact.payload.subject_ref}: "${lib.clip(e.fact.payload.note, 70)}"`));
    return;
  }
  if (!events.length) return;
  if (!(await lib.healthGate(URL, { onLog: () => {} }))) { console.error(`[cf] ${c.client_id}: gateway not writable`); return; }
  const r = await lib.postEvents(events, { url: URL, token, agent: 'kai', onLog: m => console.error(`[cf] ${c.client_id}: ${m}`) });
  for (const e of events) if (r.settled.has(e.key)) seen.add(e.key);
  lib.saveSeen(stateFile, seen);
  console.log(`[cf] ${c.client_id}: ${r.posted} posted, ${r.quarantined} quarantined, ${r.pending} pending`);
}

async function tick() { for (const c of CONFIG) { try { await runOne(c); } catch (e) { console.error(`[cf] ${c.client_id}: ${e.message}`); } } }

tick().catch(e => console.error('[cf]', e.message));
if (WATCH && !DRY) {
  setInterval(() => tick().catch(e => console.error('[cf] tick:', e.message)), INTERVAL);
  console.log(`[cf] watching ${CONFIG.map(c => c.client_id).join(', ')} → ${URL}, every 30s`);
}

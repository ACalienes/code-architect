'use strict';
/**
 * CFO → The Board semantic emit hook. The second emit hook (after board-sync for Conductor).
 *
 * Like board-sync: an always-on watcher that turns CFO's REAL output into plain-English Board posts,
 * so the ledger fills on its own. It READS CFO's own state-of-truth read-only (no edits to the CFO
 * repo, no reaching into CFO's scripts) and diffs against a saved snapshot, emitting ONLY what's new.
 *
 * Semantic, not mechanical: it posts meaningful financial events (alerts CFO raised, invoices/payments
 * CFO drafted, books CFO closed) — NOT raw tool-call activity. First run = silent baseline (no dump).
 *
 * Sources (read-only):
 *   - docs/shared/outbox-cfo.json  → CFO's own alerts/findings (type/severity/summary)
 *   - logs/drafts/**.json          → invoice/payment drafts CFO produced
 *   - logs/closes/**               → month-close artifacts
 *
 *   node board-emit-cfo.js --dry-run     # preview what it WOULD post, write nothing (default-safe)
 *   node board-emit-cfo.js --once        # one real pass (emit new items), then exit
 *   pm2 start board-emit-cfo.js --name board-emit-cfo -- --watch   # continuous, every 30s
 *
 * CFO repo location is env-configurable (laptop vs Mini differ): CFO_DIR (default ~/Desktop/Code/CFO).
 */
const fs = require('node:fs');
const path = require('node:path');
const { openDb, writeFact } = require('./shared-layer');

const HOME = process.env.HOME;
const CFO_DIR = process.env.CFO_DIR || path.join(HOME, 'Desktop', 'Code', 'CFO');
const STATE = path.join(HOME, '.kameha', 'board-emit-cfo-state.json');
const INTERVAL = 30000;

const DRY = process.argv.includes('--dry-run');
const WATCH = process.argv.includes('--watch');
const EMIT_ALL = process.argv.includes('--emit-all'); // one-time: post ALL current events (initial populate)

const loadState = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch (_) { return null; } };
const saveState = s => { const tmp = STATE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(s)); fs.renameSync(tmp, STATE); };
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; } };
const walk = (dir, hits = []) => {
  let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return hits; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, hits);
    else if (e.isFile() && e.name.endsWith('.json')) hits.push(p);
  }
  return hits;
};

const titleFromFile = f => path.basename(f, '.json').replace(/[-_]/g, ' ');

/** Collect the CURRENT set of semantic events from CFO's state (the universe; diffing happens later). */
function collect() {
  const events = [];

  // 1) Alerts CFO raised. The outbox is a daily-repeating feed (39 near-identical "N critical, M
  //    warning" lines) — emitting each is spam. Semantic value = the CURRENT alert state, posted only
  //    when it CHANGES. So: take the latest alert message, key it by its SUMMARY (not timestamp) so an
  //    unchanged state never re-posts; a changed count posts once.
  const outbox = readJson(path.join(CFO_DIR, 'docs', 'shared', 'outbox-cfo.json'));
  const alerts = ((outbox && outbox.messages) || []).filter(m => m.summary);
  const latest = alerts[alerts.length - 1];
  if (latest) {
    const sev = latest.severity ? `[${latest.severity}] ` : '';
    events.push({
      key: 'alert-state:' + latest.summary,            // changes only when the alert summary changes
      subject: 'financial-alert',
      detail: `${sev}current financial alerts — ${latest.summary}`,
    });
  }

  // 2) Invoice/payment drafts CFO produced.
  for (const f of walk(path.join(CFO_DIR, 'logs', 'drafts'))) {
    const rel = path.relative(CFO_DIR, f);
    events.push({ key: 'draft:' + rel, subject: 'cfo-draft', detail: `drafted ${titleFromFile(f)}` });
  }
  // 3) Month closes.
  for (const f of walk(path.join(CFO_DIR, 'logs', 'closes'))) {
    const rel = path.relative(CFO_DIR, f);
    events.push({ key: 'close:' + rel, subject: 'cfo-close', detail: `closed the books: ${titleFromFile(f)}` });
  }
  return events;
}

function tick() {
  const cur = collect();
  // --emit-all: treat everything current as fresh, post it once, then record baseline (initial populate).
  if (EMIT_ALL) {
    if (DRY) { previewAll(cur); return; }
    const db = openDb(path.join(HOME, '.kameha', 'kameha-mesh.db'));
    let posted = 0;
    for (const e of cur) {
      const r = writeFact(db, {
        fact_type: 'status_update', visibility: 'internal', data_class: 'internal',
        client_id: null, source_agent: 'cfo', subject_type: 'finance', subject_id: e.subject,
        payload: { status: 'update', detail: e.detail },
      });
      if (r.ok) posted++;
    }
    saveState({ seen: cur.map(e => e.key) });
    console.log(`[emit-cfo] --emit-all: posted ${posted} CFO event(s) to The Board`);
    return;
  }
  const prev = loadState();
  if (!prev) {
    if (!DRY) saveState({ seen: cur.map(e => e.key) });
    console.log(`[emit-cfo] baseline set (${cur.length} existing CFO events) — will post NEW ones from here` +
      (DRY ? ' [DRY-RUN: nothing saved]' : ''));
    if (DRY) { previewAll(cur); }
    return;
  }
  const seen = new Set(prev.seen || []);
  const fresh = cur.filter(e => !seen.has(e.key));
  if (DRY) { previewAll(fresh); return; }

  const db = openDb(path.join(HOME, '.kameha', 'kameha-mesh.db'));
  let posted = 0;
  for (const e of fresh) {
    const r = writeFact(db, {
      fact_type: 'status_update', visibility: 'internal', data_class: 'internal',
      client_id: null, source_agent: 'cfo', subject_type: 'finance', subject_id: e.subject,
      payload: { status: 'update', detail: e.detail },
    });
    if (r.ok) posted++;
  }
  saveState({ seen: cur.map(e => e.key) });
  if (posted) console.log(`[emit-cfo] posted ${posted} new CFO event(s) to The Board`);
}

function previewAll(list) {
  console.log(`\n=== DRY-RUN: ${list.length} CFO event(s) that would post to The Board ===`);
  for (const e of list.slice(0, 25)) console.log(`  • CFO · ${e.subject}: "${e.detail}"`);
  if (list.length > 25) console.log(`  … and ${list.length - 25} more`);
}

tick();
if (WATCH && !DRY) {
  setInterval(tick, INTERVAL);
  console.log(`[emit-cfo] watching CFO (${CFO_DIR}) → posting new events to The Board every 30s`);
}

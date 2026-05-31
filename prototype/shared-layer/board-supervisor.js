'use strict';
/**
 * The Board — SUPERVISOR view. Sibling to the read-only ledger but FILTERED, ACTION-ORIENTED.
 *
 *   Diagnostic ledger (:3350)  → firehose, for Code Architect (debug the fleet).
 *   Supervisor view  (:3352)   → what NEEDS Alex (approvals/questions/drafts) + active projects +
 *                                a clean activity feed of real inter-agent talk. NO mechanical noise.
 *
 * v1 = read-only. v2 will add approve/reject buttons (POST → decision facts via gateway) so Alex's
 * supervision becomes Board facts the consumption layer routes back to the agents. Bind to Tailscale.
 *
 *   pm2 start board-supervisor.js --name board-supervisor    # :3352
 *   open http://100.64.114.13:3352
 */
const http = require('node:http');
const { DatabaseSync } = require('node:sqlite');

const fs = require('node:fs');
const HOME = process.env.HOME;
const BOARD_DB     = process.env.BOARD_DB     || `${HOME}/.kameha/kameha-mesh.db`;
const CONDUCTOR_DB = process.env.CONDUCTOR_DB || `${HOME}/.kameha/conductor.db`;
const PORT = Number(process.env.SUPERVISOR_PORT || 3352);
const HOST = process.env.SUPERVISOR_HOST || '100.64.114.13';
// v2 — Approve / Reject / Comment buttons fire here, post a decision/status_update fact through the gateway under the 'alex' token.
// Gateway binds the Tailscale IP only (never loopback). Same URL the emit hooks use.
const GATEWAY_URL = process.env.GATEWAY_URL || 'http://100.64.114.13:3351';
const SUPERVISOR_TOKEN_FILE = process.env.SUPERVISOR_TOKEN_FILE || `${HOME}/.kameha/board-gateway.tokens/alex`;
let _superToken = null;
const supervisorToken = () => _superToken || (_superToken = fs.readFileSync(SUPERVISOR_TOKEN_FILE, 'utf8').trim());

// Auth for the supervisor's /action endpoint itself (DA-a — critical: without this, any tailnet
// device can POST forged 'Alex approved' facts). Token auto-generated on first run, persisted 0600,
// then embedded SERVER-SIDE in the rendered HTML so the browser sends it back as
// `X-Supervisor-Action` on every /action POST. Rotate by deleting the file and restarting.
const { randomBytes, timingSafeEqual, createHash } = require('node:crypto');
const path = require('node:path');
const SUPERVISOR_ACTION_TOKEN_FILE = process.env.SUPERVISOR_ACTION_TOKEN_FILE || `${HOME}/.kameha/supervisor.token`;
let _supActionToken = null;
function supervisorActionToken() {
  if (_supActionToken) return _supActionToken;
  try { const t = fs.readFileSync(SUPERVISOR_ACTION_TOKEN_FILE, 'utf8').trim(); if (t.length >= 32) { _supActionToken = t; return t; } } catch (_) {}
  const t = randomBytes(32).toString('base64url');
  try { fs.mkdirSync(path.dirname(SUPERVISOR_ACTION_TOKEN_FILE), { recursive: true, mode: 0o700 }); } catch (_) {}
  fs.writeFileSync(SUPERVISOR_ACTION_TOKEN_FILE, t, { mode: 0o600 });
  _supActionToken = t;
  console.log(`[supervisor] generated new /action auth token → ${SUPERVISOR_ACTION_TOKEN_FILE}`);
  return t;
}
function actionAuthOK(req) {
  const provided = req.headers['x-supervisor-action'];
  if (!provided || typeof provided !== 'string') return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(supervisorActionToken());
  if (a.length !== b.length) return false;
  try { return timingSafeEqual(a, b); } catch (_) { return false; }
}

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ago = ts => { const s = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000); if (s < 60) return Math.floor(s) + 's'; if (s < 3600) return Math.floor(s / 60) + 'm'; if (s < 86400) return Math.floor(s / 3600) + 'h'; return Math.floor(s / 86400) + 'd'; };
const NAME = { kai: 'Kai', cfo: 'CFO', enso: 'Enso', acd: 'ACD', nami: 'NAMI', framer: 'Framer', conductor: 'Conductor', 'lead-engine': 'Lead Engine', 'offer-architect': 'Offer Architect', 'code-architect': 'Code Architect', 'pitch-deck': 'Pitch Deck', kmg: 'KMG', 'dag-repo': 'DAG', 'tdb-repo': 'Dental Boutique', chronicle: 'Chronicle', alex: 'Alex' };
// Client slugs → display names. CEO-readable everywhere a slug appears.
const CLIENT_NAME = {
  tdb: 'Dental Boutique', 'tdb-repo': 'Dental Boutique', dental: 'Dental Boutique', 'the-dental-boutique': 'Dental Boutique',
  dagdc: 'DAGDC', 'dag-repo': 'DAGDC', dag: 'DAGDC', 'dag-development-construction': 'DAGDC',
  jmm: 'JMM Law', 'jmm-law': 'JMM Law', 'jmm-law-jimenez-mazzitelli-mordes': 'JMM Law',
  'hannah-goldy': 'Hannah Goldy', 'hannah goldy': 'Hannah Goldy',
  gort: 'Gort Productions', 'gort-productions': 'Gort Productions',
  vcm: 'VCM Production', 'vcm-production': 'VCM Production',
  baptist: 'Baptist Health', 'baptist-health': 'Baptist Health', 'baptist-health-south-florida': 'Baptist Health',
  'cynthia-demos': 'Cynthia Demos', 'cynthia-demos-communications': 'Cynthia Demos',
  'dr-pratt': 'Dr. Pratt', tenet: 'Tenet', 'george-villalba': 'George Villalba',
  'christian-rodriguez': 'Christian Rodriguez', malaga: 'Townhomes on Malaga',
};
const clientName = slug => CLIENT_NAME[String(slug || '').toLowerCase()] || null;
// Replace slug tokens inside free text with display names ("drafted vcm 2026 04" → "VCM Production 2026 04").
const SLUG_RX = new RegExp('\\b(' + Object.keys(CLIENT_NAME).map(s => s.replace(/[-]/g, '[-\\s]?')).join('|') + ')\\b', 'gi');
const expandSlugs = s => String(s || '').replace(SLUG_RX, m => CLIENT_NAME[m.toLowerCase().replace(/\s+/g, '-')] || CLIENT_NAME[m.toLowerCase()] || m);
const isUUID = s => /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(String(s || ''));
const who = a => NAME[a] || a || '—';
const title = slug => String(slug || '').replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
const detailOf = p => { try { const o = JSON.parse(p || '{}'); return o.detail || o.text || o.task || o.note || o.summary || o.content || o.status || ''; } catch (_) { return ''; } };
const statusOf = p => { try { return JSON.parse(p || '{}').status || ''; } catch (_) { return ''; } };
// Highlight @agent mentions so the eye catches who a note is for.
const renderMentions = s => esc(s).replace(/@([A-Za-z][A-Za-z0-9_-]*)/g, (_, a) => `<span class="mn">@${esc(NAME[a.toLowerCase()] || a)}</span>`);

// CA is a single-shot session, not a daemon. Mesh WOs for it sit queued until a session opens.
// Surface that queue so Alex sees what's waiting and can approve (v2) or open a session himself.
async function caInbox() {
  try {
    const r = await fetch('http://127.0.0.1:3341/inbox/code-architect', { signal: AbortSignal.timeout(2500) });
    if (!r.ok) return [];
    const d = await r.json();
    const open = (d.messages || []).filter(m => m.status !== 'completed' && m.status !== 'rejected' && m.status !== 'failed');
    return open.map(m => {
      let p = m.payload; if (typeof p === 'string') { try { p = JSON.parse(p); } catch (_) { p = {}; } }
      const title = (p && (p.title || p.subject || p.summary)) || m.action || 'mesh request';
      return { message_id: m.message_id, from: m.from_agent, title: String(title).slice(0, 140), action: m.action, status: m.status, created_at: m.created_at };
    });
  } catch (_) { return []; }
}

function snapshot() {
  const b = new DatabaseSync(BOARD_DB, { readOnly: true });
  let projects = [], cycles = [];
  try {
    const c = new DatabaseSync(CONDUCTOR_DB, { readOnly: true });
    try {
      projects = c.prepare("SELECT id, name, client_slug, type, status, stage, COALESCE(updated_at, created_at) AS updated_at FROM projects WHERE status='active' ORDER BY stage DESC, updated_at DESC LIMIT 24").all();
      cycles = c.prepare("SELECT project_id, month, deliverables FROM retainer_cycles ORDER BY month DESC LIMIT 60").all();
    } finally { c.close(); }
  } catch (_) {}
  try {
    const facts = b.prepare("SELECT fact_id, fact_type, source_agent, subject_id, payload, created_at, revoked_at FROM facts WHERE revoked_at IS NULL ORDER BY created_at DESC LIMIT 200").all();
    const recipStmt = b.prepare('SELECT recipient_agent FROM deliveries WHERE fact_id = ?');
    for (const f of facts) f.recipients = recipStmt.all(f.fact_id).map(r => r.recipient_agent);
    // Subject_ids Alex has already decided on (approved/rejected) — used to drop them from "needs you".
    // Union BOTH the legacy `decision` AND the new authorization-grade `supervisor_decision` (§12.5) —
    // approvals now publish supervisor_decision, so without the union an approved item would reappear.
    const decided = new Set(b.prepare("SELECT DISTINCT subject_id FROM facts WHERE fact_type IN ('decision','supervisor_decision') AND source_agent='alex' AND revoked_at IS NULL").all().map(r => r.subject_id).filter(Boolean));
    return { facts, projects, cycles, decided };
  } finally { b.close(); }
}

// Drop the inter-agent "reply: ..." chatter — it's system traffic, not a CEO decision.
const NOISE_DETAIL = /^(reply:|Daily production snapshot|Received but requires manual action: \w+_\w+$|status update$)/i;
const isNoise = d => NOISE_DETAIL.test(String(d || '').trim());

// CFO "drafted X" detail signals an actual draft awaiting send.
const CFO_DRAFT_RX = /^drafted\b/i;

function needsYou(facts) {
  const items = [];
  const completedSubjects = new Set();
  for (const f of facts) {
    const d = detailOf(f.payload).toLowerCase();
    if (f.fact_type === 'status_update' && (d.includes('complete') || d.includes('done') || d.startsWith('reply'))) completedSubjects.add(f.subject_id + '|' + f.source_agent);
  }
  for (const f of facts.slice(0, 120)) {
    const d = detailOf(f.payload);
    if (isNoise(d)) continue;
    if (f.fact_type === 'question') {
      items.push({ kind: 'question', from: f.source_agent, to: f.subject_id, detail: d, age: f.created_at, fact_id: f.fact_id });
    } else if (f.fact_type === 'work_order') {
      if (!completedSubjects.has(f.source_agent + '|' + f.subject_id)) items.push({ kind: 'work_order', from: f.source_agent, to: f.subject_id, detail: d, age: f.created_at, fact_id: f.fact_id });
    } else if (f.source_agent === 'cfo' && f.fact_type === 'status_update' && CFO_DRAFT_RX.test(d)) {
      items.push({ kind: 'cfo-draft', from: 'cfo', to: 'alex', detail: d, age: f.created_at, fact_id: f.fact_id });
    }
  }
  // group by (kind|from|first-2-words-of-detail) so repeated drafts/WOs of the same kind collapse with a count.
  const groupKey = it => {
    if (it.kind === 'cfo-draft') { const m = it.detail.toLowerCase().match(/^drafted\s+(\S+)/); return `cfo-draft|${m ? 'drafted ' + m[1] : it.detail.slice(0, 28).toLowerCase()}`; }
    return `${it.kind}|${it.from}|${it.detail.slice(0, 50).toLowerCase()}`;
  };
  const groups = new Map();
  for (const it of items) {
    const k = groupKey(it);
    if (groups.has(k)) { const g = groups.get(k); g.count++; g.others.push(it); } else { groups.set(k, { ...it, count: 1, others: [] }); }
  }
  return Array.from(groups.values()).slice(0, 14);
}
// Drop anything Alex has already decided on (an alex decision fact with matching subject_id exists).
function dropDecided(items, decided) {
  if (!decided || !decided.size) return items;
  return items.filter(it => !decided.has(String(it.fact_id || '')));
}

// CEO-readable headline for each need card — reads as a sentence the way an office update would.
const friendlyName = id => NAME[id] || clientName(id) || (id ? title(expandSlugs(String(id))) : '—');

// Bucket items by recency so what's URGENT stays in the primary pane and the rest moves down.
const FRESH_MS = 24 * 60 * 60 * 1000;
const STALE_MS = 7 * 24 * 60 * 60 * 1000;   // hide entirely past a week
function bucketByAge(items) {
  const now = Date.now(); const fresh = []; const aged = [];
  for (const it of items) {
    const ageMs = now - new Date(it.age).getTime();
    if (!isFinite(ageMs) || ageMs >= STALE_MS) continue;          // too old → drop
    (ageMs < FRESH_MS ? fresh : aged).push(it);
  }
  return { fresh, aged };
}
// Tag for the age pill on each card so the eye can scan urgency.
function ageTag(ts) {
  const ms = Date.now() - new Date(ts).getTime();
  if (ms < 4 * 60 * 60 * 1000) return { cls: 'hot',  txt: ago(ts) };           // < 4h — fresh
  if (ms < 24 * 60 * 60 * 1000) return { cls: 'warm', txt: ago(ts) };          // < 24h — getting older
  return { cls: 'cold', txt: ago(ts) };                                        // > 24h — stale
}
// For each need item, find the most recent OTHER fact about the same subject/client so the card carries continuity.
function pickContext(item, facts) {
  if (!item.fact_id || !facts) return null;
  const wanted = String(item.detail || '').toLowerCase();
  const subj = String(item.fact_id || '');
  const clientSlug = String(item.to || '').toLowerCase();
  for (const f of facts) {
    if (f.fact_id === subj) continue;
    const d = detailOf(f.payload).toLowerCase();
    if (!d) continue;
    if (NOISE_DETAIL.test(d)) continue;
    // related: shares the client/topic
    if ((clientSlug && (String(f.subject_id || '').toLowerCase() === clientSlug || d.includes(clientSlug))) ||
        (wanted && d.includes(wanted.split(' ')[0]))) {
      return { who: who(f.source_agent), detail: expandSlugs(detailOf(f.payload)).slice(0, 120), age: f.created_at };
    }
  }
  return null;
}
function cardSentence(n) {
  const fromName = esc(friendlyName(n.from));
  let detail = expandSlugs(String(n.detail || '')).replace(/[_]/g, ' ').replace(/\s+/g, ' ').trim();
  if (detail.length > 200) detail = detail.slice(0, 198) + '…';
  const toName = esc(friendlyName(n.to));
  const more = n.count > 1 ? ` <span class="cnt">+${n.count - 1} similar</span>` : '';
  if (n.kind === 'question')   return `<b>${fromName}</b> asked <b>${toName}</b>: ${esc(detail) || '—'}${more}`;
  if (n.kind === 'work_order') return `<b>${fromName}</b> sent <b>${toName}</b> a work order: ${esc(detail) || '—'}${more}`;
  if (n.kind === 'cfo-draft')  return `<b>CFO</b> drafted ${esc(detail.replace(/^drafted\s+/i, '')) || 'an item'} — needs your nod to send${more}`;
  if (n.kind === 'ca-mesh')    return `<b>${fromName}</b> queued a work order for <b>Code Architect</b>: ${esc(detail) || 'mesh request'}${more}`;
  return `<b>${fromName}</b>: ${esc(detail) || '—'}${more}`;
}

function activityFeed(facts) {
  const NOISE_DETAIL = /^reply: (\d+ |Daily production snapshot|status update)/i;
  const out = [];
  const seen = new Set();
  for (const f of facts) {
    const d = detailOf(f.payload);
    const k = f.source_agent + '|' + f.subject_id + '|' + d.slice(0, 60);
    if (seen.has(k)) continue;
    if (NOISE_DETAIL.test(d) && out.filter(x => x.source_agent === f.source_agent).length >= 1) continue;   // collapse repetitive replies
    seen.add(k);
    out.push(f);
    if (out.length >= 18) break;
  }
  return out;
}

// Recent notes — organic awareness posts (status_update with status='note' OR containing @mentions),
// distinct from the reply-chain status_updates the mesh bridge surfaces.
function notesFeed(facts) {
  const out = [];
  const seen = new Set();
  for (const f of facts) {
    if (f.fact_type !== 'status_update') continue;
    const d = detailOf(f.payload);
    const s = statusOf(f.payload);
    const hasMention = /@[A-Za-z][A-Za-z0-9_-]*/.test(d);
    if (!(s === 'note' || hasMention)) continue;
    const k = f.source_agent + '|' + d.slice(0, 80);
    if (seen.has(k)) continue; seen.add(k);
    out.push({ ...f, _detail: d });
    if (out.length >= 8) break;
  }
  return out;
}

function projectsBlock(projects, cycles, facts) {
  // attach last activity per project (by client_slug match against subject_id)
  const lastBySlug = new Map();
  for (const f of facts) { const s = f.subject_id || ''; if (s && !lastBySlug.has(s)) lastBySlug.set(s, f); }
  return projects.map(p => {
    const last = lastBySlug.get(p.client_slug) || lastBySlug.get(p.id);
    let lastTxt = '—';
    if (last) lastTxt = `${who(last.source_agent)}: ${esc(detailOf(last.payload).slice(0, 70))} · ${ago(last.created_at)} ago`;
    return { ...p, lastTxt };
  });
}

function row(f) {
  const target = NAME[f.subject_id];
  const cname = clientName(f.subject_id);
  let verb = ({ status_update: 'updated', work_order: 'sent a work order', question: 'asked', decision: 'made a decision', task: 'added a task', creative_brief: 'shared a brief', client_feedback: 'logged feedback', objective: 'set an objective' }[f.fact_type]) || ('posted ' + f.fact_type);
  let subj = '';
  if (target) {
    if (f.fact_type === 'work_order' || f.fact_type === 'task') subj = ` to <b>${esc(target)}</b>`;
    else if (f.fact_type === 'question') { verb = 'asked'; subj = ` <b>${esc(target)}</b>`; }
    else if (f.fact_type === 'status_update') { verb = 'updated'; subj = ` <b>${esc(target)}</b>`; }
    else subj = ` about <b>${esc(target)}</b>`;
  } else if (cname) {
    subj = ` about <b>${esc(cname)}</b>`;
  } else if (f.subject_id && !isUUID(f.subject_id)) {
    subj = ` about <b>${esc(expandSlugs(title(f.subject_id)))}</b>`;
  }
  // For Alex's decisions/comments, replace the raw-UUID detail with something readable.
  let rawDetail = detailOf(f.payload);
  if (f.source_agent === 'alex' && /^re ca-mesh [0-9a-f-]+:/i.test(rawDetail)) rawDetail = rawDetail.replace(/^re ca-mesh [0-9a-f-]+:\s*/i, 'Comment: ');
  const detail = renderMentions(expandSlugs(rawDetail));
  return `<div class="row"><div class="line"><b>${esc(who(f.source_agent))}</b> ${verb}${subj}</div>${detail ? `<div class="d">${detail}</div>` : ''}<div class="m">${ago(f.created_at)} ago</div></div>`;
}

async function render() {
  let d; try { d = snapshot(); } catch (e) { return `<pre>supervisor error: ${esc(e.message)}</pre>`; }
  const caQueued = await caInbox();
  // CA's queued mesh WOs go to the TOP of "what needs you" — they're stuck until you approve / open a session.
  const caItems = caQueued.map(m => ({ kind: 'ca-mesh', from: m.from, to: 'code-architect', detail: m.title, age: m.created_at, fact_id: m.message_id, action: m.action, status: m.status }));
  // Drop items Alex has already decided on (approved/rejected/dismissed). Heuristic items use fact_id; ca-mesh items use message_id — both stored as subject_id on the decision fact.
  const allNeeds = dropDecided([...caItems, ...needsYou(d.facts)], d.decided);
  const buckets = bucketByAge(allNeeds);
  const needs = buckets.fresh;
  const aged  = buckets.aged;
  const notes = notesFeed(d.facts);
  const proj = projectsBlock(d.projects, d.cycles, d.facts);
  const feed = activityFeed(d.facts);

  const notesHtml = notes.length
    ? notes.map(n => `<div class="note"><div class="nhd"><b>${esc(who(n.source_agent))}</b><span class="nag">${ago(n.created_at)} ago</span></div><div class="ntx">${renderMentions(n._detail)}</div></div>`).join('')
    : `<div class="empty">No recent notes. (Any agent can drop one with <code>board-note &lt;from&gt; "&lt;text&gt;" --for=…</code>.)</div>`;

  const renderCard = n => {
    const badge = n.kind === 'question'  ? '<span class="tg q">QUESTION</span>'
                : n.kind === 'work_order'? '<span class="tg w">WORK ORDER</span>'
                : n.kind === 'ca-mesh'   ? '<span class="tg ca">QUEUED FOR CA</span>'
                :                          '<span class="tg c">CFO DRAFT</span>';
    const dk = esc(n.kind);
    const di = esc(String(n.fact_id || ''));
    const at = ageTag(n.age);
    const ctx = pickContext(n, d.facts);
    const ctxHtml = ctx ? `<div class="cx">↳ <b>${esc(ctx.who)}</b> ${esc(ago(ctx.age))} ago: <i>${esc(ctx.detail)}</i></div>` : '';
    return `<div class="need ${at.cls}"><div class="nh">${badge}<span class="ag ${at.cls}">${esc(at.txt)} ago</span></div><div class="nd">${cardSentence(n)}</div>${ctxHtml}<div class="na"><button class="ok" data-kind="${dk}" data-id="${di}" data-action="approve">Approve</button><button class="rj" data-kind="${dk}" data-id="${di}" data-action="reject">Reject</button><button class="dm" data-kind="${dk}" data-id="${di}" data-action="dismiss">Dismiss</button><button class="cm" data-kind="${dk}" data-id="${di}" data-action="comment">Comment</button></div></div>`;
  };
  const needsHtml = needs.length
    ? needs.map(renderCard).join('')
    : `<div class="empty">Nothing fresh on your desk. The fleet's running unattended.</div>`;
  const agedHtml = aged.length
    ? `<details class="aged"><summary>Older — review or dismiss · ${aged.length} item${aged.length === 1 ? '' : 's'}</summary><div class="needs aged-needs">${aged.map(renderCard).join('')}</div></details>`
    : '';

  const projHtml = proj.length
    ? proj.map(p => `<div class="proj"><div class="pn">${esc(p.name || p.id)}</div><div class="pm">${esc(p.client_slug || '—')} · stage <b>${esc(String(p.stage ?? '–'))}/10</b> · <span class="ps">${esc(p.status)}</span></div><div class="pl">${p.lastTxt}</div></div>`).join('')
    : `<div class="empty">No active projects in Conductor.</div>`;

  const feedHtml = feed.length ? feed.map(row).join('') : `<div class="empty">No recent semantic activity.</div>`;

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="30">
<title>The Board — Supervisor</title><style>
:root{--bg:#0a0d12;--card:#151b25;--brief:#0c1016;--border:#232c3a;--text:#e6edf3;--text-2:#aab6c4;--muted:#7d8a99;--dim:#5a6573;--accent:#6ea8fe;--green:#4ade80;--yellow:#facc15;--orange:#fb923c;--red:#f87171;--purple:#c084fc;--teal:#5eead4;}
*{box-sizing:border-box;margin:0;padding:0}body{background:var(--bg);color:var(--text);font-family:-apple-system,"SF Pro Text",sans-serif;line-height:1.5;padding:30px 22px 70px;max-width:1100px;margin:0 auto}
.eyebrow{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:2px;color:var(--green);display:flex;align-items:center;gap:9px;margin-bottom:10px}
.eyebrow .live{width:8px;height:8px;border-radius:50%;background:var(--green);box-shadow:0 0 8px rgba(74,222,128,.5);animation:b 1.6s infinite}@keyframes b{50%{opacity:.35}}
h1{font-size:30px;font-weight:800;letter-spacing:-.7px;background:linear-gradient(180deg,#fff,#b8c5d3);-webkit-background-clip:text;background-clip:text;color:transparent}
.sub{font-size:14px;color:var(--text-2);margin:8px 0 22px;max-width:840px}.sub a{color:var(--accent);text-decoration:none}
h2{font-size:11.5px;font-weight:700;text-transform:uppercase;letter-spacing:1.4px;color:var(--text-2);margin:28px 0 11px;display:flex;align-items:center;gap:10px}h2::after{content:"";flex:1;height:1px;background:linear-gradient(90deg,var(--border),transparent)}h2 .c{font-size:11px;color:var(--muted);font-family:"JetBrains Mono",monospace;letter-spacing:0;text-transform:none}

.needs{display:grid;grid-template-columns:1fr 1fr;gap:10px}
@media(max-width:780px){.needs{grid-template-columns:1fr}}
.need{background:linear-gradient(135deg,rgba(250,204,21,.07),rgba(250,204,21,.02));border:1px solid rgba(250,204,21,.28);border-left:3px solid var(--yellow);border-radius:11px;padding:13px 16px}
.nh{font-size:12.5px;color:var(--text-2);display:flex;align-items:center;gap:8px;flex-wrap:wrap}.nh .ag{margin-left:auto;color:var(--muted);font-family:"JetBrains Mono",monospace;font-size:11px}
.tg{font-size:10px;font-weight:800;letter-spacing:.6px;padding:2px 7px;border-radius:20px}
.tg.q{background:rgba(56,189,248,.15);color:#38bdf8} .tg.w{background:rgba(250,204,21,.15);color:var(--yellow)} .tg.c{background:rgba(94,234,212,.15);color:var(--teal)} .tg.ca{background:rgba(251,146,60,.16);color:var(--orange)}
.nh .st{margin-left:6px;font-family:"JetBrains Mono",monospace;font-size:10px;color:var(--orange);text-transform:uppercase}
.nd{font-size:14px;color:var(--text);margin:7px 0;line-height:1.45}.nd b{color:var(--text);font-weight:700}
.cnt{display:inline-block;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;padding:1px 7px;border-radius:20px;background:var(--brief);border:1px solid var(--border-b);color:var(--accent);margin-left:4px;vertical-align:middle}
.cx{font-size:12px;color:var(--text-2);margin:4px 0 6px;padding-left:8px;border-left:2px solid var(--border-b);line-height:1.4}.cx b{color:var(--text);font-weight:600}.cx i{color:var(--muted);font-style:normal}
.ag.hot{color:var(--green)}.ag.warm{color:var(--yellow)}.ag.cold{color:var(--red);font-weight:700}
.need.warm{border-left-color:var(--yellow)}.need.cold{border-left-color:var(--red);opacity:.9}
details.aged{margin-top:14px;background:var(--card);border:1px solid var(--border);border-radius:11px}
details.aged summary{cursor:pointer;padding:11px 17px;font-size:13px;color:var(--text-2);font-weight:600;list-style:none;display:flex;align-items:center;gap:8px}
details.aged summary::-webkit-details-marker{display:none}
details.aged summary::before{content:"▸";color:var(--muted);font-size:11px;transition:transform .15s}
details[open].aged summary::before{transform:rotate(90deg)}
.aged-needs{padding:0 13px 13px}.aged-needs .need{opacity:.7}
.na{display:flex;gap:6px;margin-top:6px}
.na{display:flex;gap:6px;margin-top:6px;align-items:center}
.na button{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;padding:5px 12px;border-radius:6px;border:1px solid;background:transparent;cursor:pointer;font-family:inherit;transition:background .15s}
.na button:hover{background:rgba(255,255,255,.06)}
.na button:disabled{cursor:wait;opacity:.55}
.na .ok{color:var(--green);border-color:rgba(74,222,128,.45)}.na .ok:hover{background:rgba(74,222,128,.10)}
.na .rj{color:var(--red);border-color:rgba(248,113,113,.4)}.na .rj:hover{background:rgba(248,113,113,.10)}
.na .dm{color:var(--muted);border-color:var(--border-b)}.na .dm:hover{background:rgba(125,138,153,.10)}
.na .cm{color:var(--text-2);border-color:var(--border)}
.na .dn{font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.6px;padding:5px 10px;border-radius:6px;background:rgba(74,222,128,.13);color:var(--green)}
.na .dn.x{background:rgba(248,113,113,.13);color:var(--red)}
.na .dn.d{background:rgba(125,138,153,.13);color:var(--muted)}
.na .dn.c{background:rgba(110,168,254,.13);color:var(--accent)}

.projs{display:grid;grid-template-columns:1fr 1fr 1fr;gap:9px}
@media(max-width:780px){.projs{grid-template-columns:1fr 1fr}}
@media(max-width:520px){.projs{grid-template-columns:1fr}}
.proj{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:12px 14px}
.pn{font-size:13.5px;font-weight:800}.pm{font-size:11.5px;color:var(--muted);margin:3px 0 7px;font-family:"JetBrains Mono",monospace}
.pm .ps{color:var(--green);text-transform:uppercase;font-size:10px}
.pl{font-size:12px;color:var(--text-2)}

.row{background:var(--card);border:1px solid var(--border);border-radius:9px;padding:9px 13px;margin-bottom:6px;display:grid;grid-template-columns:1fr auto;gap:8px;align-items:start}
.row .line{font-size:13.5px;grid-column:1}.row .d{font-size:12.5px;color:var(--text-2);font-style:italic;grid-column:1;margin-top:2px}
.row .m{font-size:11px;color:var(--muted);font-family:"JetBrains Mono",monospace;grid-column:2;grid-row:1 / span 2}

.empty{color:var(--muted);text-align:center;padding:24px 14px;font-size:13px;background:var(--brief);border:1px dashed var(--border);border-radius:10px}
.empty code{font-family:"JetBrains Mono",monospace;font-size:11.5px;background:var(--card);border:1px solid var(--border);border-radius:5px;padding:1px 6px;color:var(--teal)}
.notes{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-bottom:6px}
@media(max-width:780px){.notes{grid-template-columns:1fr}}
.note{background:var(--card);border:1px solid var(--border);border-left:3px solid var(--teal);border-radius:10px;padding:11px 14px}
.nhd{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text-2)}.nhd .nag{margin-left:auto;font-family:"JetBrains Mono",monospace;color:var(--muted);font-size:11px}
.ntx{font-size:13.5px;color:var(--text);margin-top:5px;line-height:1.45}
.mn{color:var(--accent);font-weight:700;background:rgba(110,168,254,.10);padding:0 5px;border-radius:4px}
.foot{margin-top:30px;font-size:11px;color:var(--dim);font-family:"JetBrains Mono",monospace;text-align:center}
</style></head><body>
<div class="eyebrow"><span class="live"></span>Live · supervisor view · refreshes every 30s</div>
<h1>The Board — what needs you.</h1>
<p class="sub">The agency's live operating picture. <b>Lead with what's on your desk</b>; the fleet keeps running below. Diagnostic firehose is at <a href="http://${esc(HOST)}:3350">:3350</a>.</p>

<h2>What needs you <span class="c">${needs.length} open${aged.length ? ` · ${aged.length} older` : ''}</span></h2>
<div class="needs">${needsHtml}</div>
${agedHtml}

<h2>Recent notes · FYI <span class="c">${notes.length}</span></h2>
<div class="notes">${notesHtml}</div>

<h2>Active projects <span class="c">${proj.length}</span></h2>
<div class="projs">${projHtml}</div>

<h2>Real activity · agents talking <span class="c">filtered</span></h2>
<div>${feedHtml}</div>

<div class="foot">The Board · supervisor · ${esc(new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York' }))} ET · v2.2 — buttons live (delegation + no-cache)</div>
<div id="cl" style="position:fixed;left:0;right:0;bottom:0;background:#0c1016;color:#aab6c4;font-family:JetBrains Mono,monospace;font-size:11.5px;padding:7px 14px;border-top:1px solid #232c3a;z-index:99;display:flex;gap:14px"><span id="clt">supervisor ready — click any button</span></div>
<script>
// SUPERVISOR_ACTION token embedded server-side so the browser sends it back as the X-Supervisor-Action
// header on every /action POST. Without this the endpoint is anonymous (DA-a critical fix).
window.__SUP_TOK = ${JSON.stringify(supervisorActionToken())};
(function(){
  function log(m){ var n=document.getElementById('clt'); if(n){ var ts=new Date().toLocaleTimeString(); n.textContent='['+ts+'] '+m; } console.log('[supervisor]', m); }
  log('JS loaded, click handler armed (delegation, auth-bound)');

  document.body.addEventListener('click', async function(e){
    var btn = e.target.closest('button[data-action]');
    if (!btn) return;
    e.preventDefault();
    var kind   = btn.getAttribute('data-kind');
    var id     = btn.getAttribute('data-id');
    var action = btn.getAttribute('data-action');
    log('clicked '+action+' on '+kind+' '+(id||'').slice(0,8));
    var card = btn.closest('.need');
    var comment = '';
    if (action === 'comment'){ comment = prompt('Comment:'); if (!comment){ log('cancelled'); return; } }
    var siblings = Array.prototype.slice.call(btn.parentElement.querySelectorAll('button'));
    siblings.forEach(function(b){ b.disabled = true; });
    var orig = btn.textContent; btn.textContent = '…';
    try {
      log('posting /action…');
      var r = await fetch('/action', { method:'POST', headers:{'content-type':'application/json', 'x-supervisor-action': window.__SUP_TOK || ''}, body: JSON.stringify({ kind: kind, id: id, action: action, comment: comment }) });
      var j = {}; try { j = await r.json(); } catch(_){}
      log('server returned '+r.status+' ok='+(j.ok===true));
      if (j.ok) {
        var label = action === 'approve' ? '✓ approved' : action === 'reject' ? '✕ rejected' : action === 'dismiss' ? '— dismissed' : '+ commented';
        var cls   = action === 'approve' ? 'dn'        : action === 'reject' ? 'dn x'      : action === 'dismiss' ? 'dn d'         : 'dn c';
        btn.parentElement.innerHTML = '<span class="'+cls+'">'+label+'</span><span style="margin-left:auto;font-size:10px;color:#7d8a99;font-family:JetBrains Mono,monospace">fact '+(j.fact_id?j.fact_id.slice(0,8):'')+'</span>';
        if (card) card.style.opacity = '0.55';
        log('OK — fact '+(j.fact_id||'?').slice(0,8)+'; reloading in 1.8s');
        setTimeout(function(){ location.reload(); }, 1800);
      } else {
        siblings.forEach(function(b){ b.disabled = false; }); btn.textContent = orig;
        log('FAILED '+(j.error||r.status));
        alert('Failed: '+(j.error||('status '+r.status)));
      }
    } catch (err) {
      siblings.forEach(function(b){ b.disabled = false; }); btn.textContent = orig;
      log('threw: '+err.message);
      alert('Error: '+err.message);
    }
  });
})();
</script>
</body></html>`;
}

// v2 action surface — the buttons POST here. Click Approve → posts a 'decision' fact via the
// gateway as 'alex' (server-side identity, no spoofing). Click Comment → posts a status_update.
async function readBody(req, max = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let len = 0; const chunks = [];
    req.on('data', c => { len += c.length; if (len > max) { req.destroy(); reject(new Error('body too large')); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (_) { reject(new Error('bad json')); } });
    req.on('error', reject);
  });
}
// Resolve the decided fact's provenance so a supervisor_decision can carry TRUSTED context
// (subject_source_agent + draft_ref) — a consumer reads this instead of a separate fact-fetch endpoint
// (§12.2). ca-mesh items carry a mesh message_id (not a board fact) → no row → empty context.
// Deterministic, UUID-shaped action id derived from the idempotency key — STABLE across re-clicks so the
// published fact body is byte-identical. A fresh UUID per click made re-approval a "same key + different
// body" request → the gateway's (key + request-hash) idempotency returns 409 instead of a clean idempotent
// 200 (Codex Phase-3 finding #1). Re-clicking Approve on the same item IS the same logical action.
function stableActionId(key) {
  const h = createHash('sha256').update(key).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

function lookupSubjectContext(id) {
  try {
    const db = new DatabaseSync(BOARD_DB, { readOnly: true });
    try {
      const row = db.prepare('SELECT source_agent, payload FROM facts WHERE fact_id = ?').get(String(id));
      if (!row) return {};
      const ctx = { subject_source_agent: row.source_agent };
      try { const p = JSON.parse(row.payload); if (p && typeof p.draft_ref === 'string') ctx.draft_ref = p.draft_ref; } catch (_) {}
      return ctx;
    } finally { db.close(); }
  } catch (_) { return {}; }
}

async function postSupervisorAction({ kind, id, action, comment }) {
  if (!['approve', 'reject', 'comment', 'dismiss'].includes(action)) throw new Error('unknown action');
  const safeKind = String(kind || 'item').slice(0, 32);
  const safeId   = String(id || '').slice(0, 80);
  let body;
  if (action === 'comment') {
    if (!comment || !String(comment).trim()) throw new Error('comment required');
    body = {
      fact_type: 'status_update', visibility: 'internal', data_class: 'internal',
      subject_type: safeKind, subject_id: safeId,
      payload: { status: 'comment', detail: `re ${safeKind} ${safeId.slice(0,12)}: ${String(comment).slice(0, 400)}` },
      idempotency_key: `alex:comment:${safeId}`.slice(0, 180),
    };
  } else {
    // approve/reject/dismiss → an AUTHORIZATION-GRADE `supervisor_decision` (§12.5). Only the alex+supervise
    // token may publish this fact_type (gateway forgery-gate). Distinct `alex:sd:` idempotency prefix so a
    // re-approval is NOT shadowed by a legacy `decision` fact's `alex:<action>:` key (that collision → 409).
    const context = lookupSubjectContext(safeId);
    const idemKey = `alex:sd:${action}:${safeId}`.slice(0, 180);
    body = {
      fact_type: 'supervisor_decision', visibility: 'internal', data_class: 'internal',
      subject_type: safeKind, subject_id: safeId,
      payload: {
        decision: action, subject_fact_id: safeId, supervisor_action_id: stableActionId(idemKey),
        rationale: `Alex ${action}d ${safeKind} ${safeId.slice(0, 40)} via supervisor`,
        ...(Object.keys(context).length ? { context } : {}),
      },
      idempotency_key: idemKey,
    };
  }
  const r = await fetch(GATEWAY_URL + '/publish', {
    method: 'POST',
    headers: { 'authorization': 'Bearer ' + supervisorToken(), 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  let j = {}; try { j = await r.json(); } catch (_) {}
  // For ca-mesh approve/reject/dismiss: also tell mesh-api to mark the original WO complete/rejected so it leaves CA's inbox.
  // Non-fatal — the decision fact on the Board is already the authoritative record.
  if (r.status === 200 && safeKind === 'ca-mesh' && (action === 'approve' || action === 'reject' || action === 'dismiss')) {
    const meshStatus = action === 'approve' ? 'completed' : 'rejected';
    try {
      await fetch(`http://127.0.0.1:3341/messages/${encodeURIComponent(safeId)}/status`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: meshStatus, actor: 'alex' }),
        signal: AbortSignal.timeout(3000),
      });
    } catch (_) { /* swallow — Board fact is the record */ }
  }
  return { ok: r.status === 200, status: r.status, ...j };
}

http.createServer(async (req, res) => {
  if (req.url === '/health') { res.writeHead(200); return res.end('ok'); }
  if (req.method === 'POST' && req.url === '/action') {
    if (!actionAuthOK(req)) {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'unauthorized — supervisor action token missing or invalid' }));
    }
    try {
      const out = await postSupervisorAction(await readBody(req));
      res.writeHead(out.ok ? 200 : 400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(out));
    } catch (e) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store, no-cache, must-revalidate', 'pragma': 'no-cache' });
  res.end(await render());
}).listen(PORT, HOST, () => console.log(`[supervisor] live on ${HOST}:${PORT}`));

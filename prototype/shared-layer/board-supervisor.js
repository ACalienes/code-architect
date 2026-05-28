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

const HOME = process.env.HOME;
const BOARD_DB     = process.env.BOARD_DB     || `${HOME}/.kameha/kameha-mesh.db`;
const CONDUCTOR_DB = process.env.CONDUCTOR_DB || `${HOME}/.kameha/conductor.db`;
const PORT = Number(process.env.SUPERVISOR_PORT || 3352);
const HOST = process.env.SUPERVISOR_HOST || '100.64.114.13';

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ago = ts => { const s = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000); if (s < 60) return Math.floor(s) + 's'; if (s < 3600) return Math.floor(s / 60) + 'm'; if (s < 86400) return Math.floor(s / 3600) + 'h'; return Math.floor(s / 86400) + 'd'; };
const NAME = { kai: 'Kai', cfo: 'CFO', enso: 'Enso', acd: 'ACD', nami: 'NAMI', framer: 'Framer', conductor: 'Conductor', 'lead-engine': 'Lead Engine', 'offer-architect': 'Offer Architect', 'code-architect': 'Code Architect', 'pitch-deck': 'Pitch Deck', kmg: 'KMG', 'dag-repo': 'DAG', 'tdb-repo': 'Dental Boutique', chronicle: 'Chronicle' };
const who = a => NAME[a] || a || '—';
const title = slug => String(slug || '').replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
const detailOf = p => { try { const o = JSON.parse(p || '{}'); return o.detail || o.text || o.task || o.summary || o.content || o.status || ''; } catch (_) { return ''; } };
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
    return { facts, projects, cycles };
  } finally { b.close(); }
}

// What needs you: open questions (no resolution yet), recent work_orders not yet completed,
// CFO drafts (invoices/payments). Heuristic v1; the consumption layer will tighten it.
function needsYou(facts) {
  const items = [];
  const completedSubjects = new Set();
  // a 'reply: ... complete' or status_update with 'done' against a subject signals completion
  for (const f of facts) {
    const d = detailOf(f.payload).toLowerCase();
    if (f.fact_type === 'status_update' && (d.includes('complete') || d.includes('done') || d.startsWith('reply'))) completedSubjects.add(f.subject_id + '|' + f.source_agent);
  }
  for (const f of facts.slice(0, 90)) {
    if (f.fact_type === 'question') {
      items.push({ kind: 'question', from: f.source_agent, to: f.subject_id, detail: detailOf(f.payload), age: f.created_at, fact_id: f.fact_id });
    } else if (f.fact_type === 'work_order') {
      // skip if there's a recent 'done/complete' going the other way for the same pair
      if (!completedSubjects.has(f.source_agent + '|' + f.subject_id)) items.push({ kind: 'work_order', from: f.source_agent, to: f.subject_id, detail: detailOf(f.payload), age: f.created_at, fact_id: f.fact_id });
    } else if (f.source_agent === 'cfo' && /draft|invoice|payment|estimate/i.test(detailOf(f.payload))) {
      items.push({ kind: 'cfo-draft', from: 'cfo', to: 'alex', detail: detailOf(f.payload), age: f.created_at, fact_id: f.fact_id });
    }
  }
  // dedupe by (kind|from|to|detail) — keep newest
  const seen = new Set(); const dedup = [];
  for (const it of items) { const k = `${it.kind}|${it.from}|${it.to}|${it.detail.slice(0, 80)}`; if (!seen.has(k)) { seen.add(k); dedup.push(it); } }
  return dedup.slice(0, 12);
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
  let verb = ({ status_update: 'updated', work_order: 'sent a work order', question: 'asked', decision: 'made a decision', task: 'added a task', creative_brief: 'shared a brief', client_feedback: 'logged feedback', objective: 'set an objective' }[f.fact_type]) || ('posted ' + f.fact_type);
  let subj = '';
  if (target) {
    if (f.fact_type === 'work_order' || f.fact_type === 'task') subj = ` to <b>${esc(target)}</b>`;
    else if (f.fact_type === 'question') { verb = 'asked'; subj = ` <b>${esc(target)}</b>`; }
    else if (f.fact_type === 'status_update') { verb = 'updated'; subj = ` <b>${esc(target)}</b>`; }
    else subj = ` about <b>${esc(target)}</b>`;
  } else if (f.subject_id) subj = ` about <b>${esc(title(f.subject_id))}</b>`;
  const detail = renderMentions(detailOf(f.payload));
  return `<div class="row"><div class="line"><b>${esc(who(f.source_agent))}</b> ${verb}${subj}</div>${detail ? `<div class="d">${detail}</div>` : ''}<div class="m">${ago(f.created_at)} ago</div></div>`;
}

async function render() {
  let d; try { d = snapshot(); } catch (e) { return `<pre>supervisor error: ${esc(e.message)}</pre>`; }
  const caQueued = await caInbox();
  // CA's queued mesh WOs go to the TOP of "what needs you" — they're stuck until you approve / open a session.
  const caItems = caQueued.map(m => ({ kind: 'ca-mesh', from: m.from, to: 'code-architect', detail: m.title, age: m.created_at, fact_id: m.message_id, action: m.action, status: m.status }));
  const needs = [...caItems, ...needsYou(d.facts)];
  const notes = notesFeed(d.facts);
  const proj = projectsBlock(d.projects, d.cycles, d.facts);
  const feed = activityFeed(d.facts);

  const notesHtml = notes.length
    ? notes.map(n => `<div class="note"><div class="nhd"><b>${esc(who(n.source_agent))}</b><span class="nag">${ago(n.created_at)} ago</span></div><div class="ntx">${renderMentions(n._detail)}</div></div>`).join('')
    : `<div class="empty">No recent notes. (Any agent can drop one with <code>board-note &lt;from&gt; "&lt;text&gt;" --for=…</code>.)</div>`;

  const needsHtml = needs.length
    ? needs.map(n => {
        const head = n.kind === 'question' ? `<span class="tg q">QUESTION</span> <b>${esc(who(n.from))}</b> → <b>${esc(who(n.to))}</b>`
          : n.kind === 'work_order' ? `<span class="tg w">WORK ORDER</span> <b>${esc(who(n.from))}</b> → <b>${esc(who(n.to))}</b>`
          : n.kind === 'ca-mesh'    ? `<span class="tg ca">CA WO · QUEUED</span> <b>${esc(who(n.from))}</b> → <b>Code Architect</b><span class="st">${esc(n.status||'')}</span>`
          : `<span class="tg c">CFO DRAFT</span> <b>CFO</b> needs your nod`;
        return `<div class="need"><div class="nh">${head}<span class="ag">${ago(n.age)} ago</span></div><div class="nd">${esc(n.detail) || '—'}</div><div class="na"><button class="ok" title="v2 wires this through the gateway">Approve</button><button class="rj">Reject</button><button class="cm">Comment</button></div></div>`;
      }).join('')
    : `<div class="empty">Nothing waiting on you right now. The fleet's running unattended.</div>`;

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
.nd{font-size:13.5px;color:var(--text);margin:7px 0;font-style:italic}
.na{display:flex;gap:6px;margin-top:6px}
.na button{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;padding:5px 12px;border-radius:6px;border:1px solid;background:transparent;cursor:not-allowed;font-family:inherit;opacity:.55}
.na .ok{color:var(--green);border-color:rgba(74,222,128,.45)}.na .rj{color:var(--red);border-color:rgba(248,113,113,.4)}.na .cm{color:var(--text-2);border-color:var(--border)}

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

<h2>What needs you <span class="c">${needs.length} open</span></h2>
<div class="needs">${needsHtml}</div>

<h2>Recent notes · FYI <span class="c">${notes.length}</span></h2>
<div class="notes">${notesHtml}</div>

<h2>Active projects <span class="c">${proj.length}</span></h2>
<div class="projs">${projHtml}</div>

<h2>Real activity · agents talking <span class="c">filtered</span></h2>
<div>${feedHtml}</div>

<div class="foot">The Board · supervisor · ${esc(new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York' }))} ET · v1 read-only · approve/reject lands in v2</div>
</body></html>`;
}

http.createServer(async (req, res) => {
  if (req.url === '/health') { res.writeHead(200); return res.end('ok'); }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(await render());
}).listen(PORT, HOST, () => console.log(`[supervisor] live on ${HOST}:${PORT}`));

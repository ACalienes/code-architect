'use strict';
/**
 * The Board — live ledger view (plain-English). A zero-dep HTTP server (node:http + node:sqlite)
 * that reads kameha-mesh.db and renders, in real time, every post on The Board as a sentence:
 * WHO posted WHAT (the actual content) and WHO picked it up. No jargon — built so Alex can read it.
 *
 *   pm2 start board-ledger.js --name board-ledger    # serves on :3350
 *   open http://100.64.114.13:3350  (over Tailscale)
 */
const http = require('node:http');
const { DatabaseSync } = require('node:sqlite');

const DB = process.env.HOME + '/.kameha/kameha-mesh.db';
const PORT = process.env.LEDGER_PORT || 3350;
const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

const ago = ts => {
  const s = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 60) return Math.floor(s) + 's ago';
  if (s < 3600) return Math.floor(s / 60) + ' min ago';
  if (s < 86400) return Math.floor(s / 3600) + ' hr ago';
  return Math.floor(s / 86400) + ' days ago';
};
// Plain display names for agents.
const NAME = { kai: 'Kai', cfo: 'CFO', enso: 'Enso', acd: 'ACD', nami: 'NAMI', framer: 'Framer',
  conductor: 'Conductor', 'lead-engine': 'Lead Engine', 'offer-architect': 'Offer Architect',
  'code-architect': 'Code Architect', 'pitch-deck': 'Pitch Deck', kmg: 'KMG',
  'dag-repo': 'DAG', 'tdb-repo': 'Dental Boutique', chronicle: 'Chronicle', 'mesh-adapter': 'Mesh Bridge', alex: 'Alex' };
const who = a => NAME[a] || a || 'someone';
// Plain phrasing per fact type.
const KIND = {
  status_update: { icon: '📊', verb: 'posted a status update', color: '#6ea8fe' },
  decision:      { icon: '✅', verb: 'made a decision',        color: '#4ade80' },
  creative_brief:{ icon: '🎨', verb: 'shared a creative brief', color: '#c084fc' },
  work_order:    { icon: '📋', verb: 'sent a work order',       color: '#facc15' },
  client_feedback:{ icon: '💬', verb: 'logged client feedback', color: '#5eead4' },
  objective:     { icon: '🎯', verb: 'set an objective',        color: '#fbbf24' },
  question:      { icon: '❓', verb: 'asked a question',         color: '#38bdf8' },
  task:          { icon: '☑️', verb: 'added a task',            color: '#a78bfa' },
};
const title = slug => String(slug || '').replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
const detailOf = payloadStr => {
  let p = {}; try { p = JSON.parse(payloadStr || '{}'); } catch (_) { return ''; }
  return p.detail || p.text || p.status || p.note || '';
};

function snapshot() {
  const db = new DatabaseSync(DB, { readOnly: true });
  try {
    const facts = db.prepare(
      'SELECT fact_id, fact_type, source_agent, subject_id, payload, created_at, revoked_at FROM facts ORDER BY created_at DESC LIMIT 40'
    ).all();
    const recipStmt = db.prepare('SELECT recipient_agent FROM deliveries WHERE fact_id = ? ORDER BY recipient_agent');
    for (const f of facts) f.recipients = recipStmt.all(f.fact_id).map(r => r.recipient_agent);
    const factCount = db.prepare('SELECT COUNT(*) n FROM facts WHERE revoked_at IS NULL').get().n;
    const agents = db.prepare('SELECT DISTINCT agent FROM subscriptions ORDER BY agent').all().map(r => r.agent);
    return { facts, factCount, agents };
  } finally { db.close(); }
}

function row(f) {
  const k = KIND[f.fact_type] || { icon: '•', verb: 'posted ' + f.fact_type, color: '#7d8a99' };
  // Conversation-aware phrasing: when subject_id is an agent name, render directed talk
  // ("Kai sent a work order to CFO", "Kai asked CFO") instead of "about <topic>".
  const target = NAME[f.subject_id];
  let verb = k.verb, subj;
  if (target) {
    if (f.fact_type === 'question')         { verb = 'asked';            subj = ` <b>${esc(target)}</b>`; }
    else if (f.fact_type === 'work_order')  {                             subj = ` to <b>${esc(target)}</b>`; }
    else if (f.fact_type === 'task')        { verb = 'assigned a task';  subj = ` to <b>${esc(target)}</b>`; }
    else if (f.fact_type === 'status_update'){ verb = 'updated';          subj = ` <b>${esc(target)}</b>`; }
    else                                    {                             subj = ` about <b>${esc(target)}</b>`; }
  } else {
    subj = f.subject_id ? ` about <b>${esc(title(f.subject_id))}</b>` : '';
  }
  const detail = detailOf(f.payload);
  const recips = f.recipients || [];
  let delivery;
  if (f.revoked_at) delivery = `<span class="warn">↩ later removed</span>`;
  else if (recips.length === 0) delivery = `<span class="warn">⚠ no agent was subscribed — nobody received it (but it's recorded here, so nothing vanishes silently)</span>`;
  else delivery = `→ delivered to <b>${recips.length}</b> ${recips.length === 1 ? 'agent' : 'agents'}: ${recips.map(who).map(esc).join(', ')}`;
  return `<div class="row${f.revoked_at ? ' dim' : ''}">
    <div class="ic" style="background:${k.color}1f;border-color:${k.color}55">${k.icon}</div>
    <div class="body">
      <div class="line"><b>${esc(who(f.source_agent))}</b> ${esc(verb)}${subj}</div>
      ${detail ? `<div class="detail">“${esc(detail)}”</div>` : ''}
      <div class="meta">${delivery} <span class="t">· ${esc(ago(f.created_at))}</span></div>
    </div></div>`;
}

function render() {
  let d; try { d = snapshot(); } catch (e) { return `<pre>ledger error: ${esc(e.message)}</pre>`; }
  const feed = d.facts.length ? d.facts.map(row).join('') : '<div class="empty">Nothing posted to The Board yet. When an agent posts something, it shows up here.</div>';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="5">
<title>The Board — live</title><style>
:root{--bg:#0a0d12;--card:#151b25;--brief:#0c1016;--border:#232c3a;--text:#e6edf3;--text2:#aab6c4;--muted:#7d8a99;--green:#4ade80;}
*{box-sizing:border-box;margin:0;padding:0}body{background:var(--bg);color:var(--text);font-family:-apple-system,"SF Pro Text",sans-serif;line-height:1.5;padding:30px 22px 70px;max-width:840px;margin:0 auto}
.eyebrow{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:2px;color:var(--green);display:flex;align-items:center;gap:9px;margin-bottom:10px}
.eyebrow .live{width:8px;height:8px;border-radius:50%;background:var(--green);box-shadow:0 0 8px rgba(74,222,128,.5);animation:b 1.6s infinite}@keyframes b{50%{opacity:.35}}
h1{font-size:27px;font-weight:800;letter-spacing:-.6px}
.what{background:var(--card);border:1px solid var(--border);border-radius:11px;padding:14px 17px;margin:14px 0 8px;font-size:13.5px;color:var(--text2)}
.what b{color:var(--text)}
.count{font-size:12.5px;color:var(--muted);margin:14px 0 10px}.count b{color:var(--text)}
.row{display:flex;gap:13px;background:var(--card);border:1px solid var(--border);border-radius:11px;padding:13px 15px;margin-bottom:8px}
.row.dim{opacity:.55}
.ic{width:34px;height:34px;border-radius:9px;border:1px solid;display:flex;align-items:center;justify-content:center;font-size:17px;flex-shrink:0}
.body{flex:1;min-width:0}
.line{font-size:14.5px}.line b{font-weight:700}
.detail{font-size:13.5px;color:var(--text2);margin:4px 0;font-style:italic}
.meta{font-size:12px;color:var(--muted);margin-top:3px}.meta b{color:var(--text2)}
.meta .t{color:var(--muted)}.warn{color:#fb923c}
.empty{color:var(--muted);text-align:center;padding:40px;font-size:14px}
.foot{margin-top:26px;font-size:11px;color:var(--muted);font-family:"JetBrains Mono",monospace;text-align:center}
</style></head><body>
<div class="eyebrow"><span class="live"></span>Live · updates every 5 seconds on its own</div>
<h1>The Board — what your agents are sharing</h1>
<div class="what"><b>What this is:</b> The Board is the shared notepad your agents post to and read from. Every line below is one thing an agent posted — and who picked it up. If you see posts landing and being delivered to agents, the system is working. Newest at the top.</div>
<div class="count"><b>${d.factCount}</b> posts currently on The Board · <b>${d.agents.length}</b> agents connected and listening</div>
${feed}
<div class="foot">The Board · live · refreshed ${esc(new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York' }))} ET</div>
</body></html>`;
}

http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200); return res.end('ok'); }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(render());
}).listen(PORT, () => console.log(`[board-ledger] live ledger on :${PORT} (reading ${DB})`));

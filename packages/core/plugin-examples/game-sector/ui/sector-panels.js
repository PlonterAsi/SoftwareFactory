'use strict';
/* ---------------- panels (DOM, refreshed a few times a second) ---------------- */
const ICON = {
  refinery: '<rect x="3" y="4" width="16" height="15" rx="2" fill="none" stroke="#4fd1c1" stroke-width="1.5"/><circle cx="9" cy="12" r="3.5" fill="none" stroke="#4fd1c1" stroke-width="1.5"/><rect x="14" y="5" width="3" height="8" fill="#4fd1c1"/>',
  barracks: '<rect x="2" y="6" width="18" height="12" rx="2" fill="none" stroke="#a99bff" stroke-width="1.5"/><path d="M5 9h3M10 9h3M15 9h2" stroke="#a99bff" stroke-width="2"/><rect x="9" y="13" width="4" height="5" fill="#a99bff"/>',
  reactor: '<circle cx="11" cy="11" r="8" fill="none" stroke="#a99bff" stroke-width="1.5"/><circle cx="11" cy="11" r="3" fill="#a99bff"/>',
  app: '<rect x="3" y="3" width="16" height="16" rx="2" fill="none" stroke="#8fd47a" stroke-width="1.5"/><path d="M6 7h3M11 7h3M6 11h3M11 11h3" stroke="#8fd47a" stroke-width="2"/><path d="M3 16h16" stroke="#8fd47a" stroke-width="1.5"/>',
  turret: '<circle cx="11" cy="12" r="6" fill="none" stroke="#4fd1c1" stroke-width="1.5"/><path d="M11 12l7-7" stroke="#4fd1c1" stroke-width="2.5"/>',
  feature: '<rect x="2" y="7" width="10" height="10" rx="1" fill="none" stroke="#8fd47a" stroke-width="1.5"/><rect x="13" y="10" width="6" height="6" fill="#8fd47a"/>',
  archive: '<path d="M7 3h8l4 4v8l-4 4H7l-4-4V7z" fill="none" stroke="#4fd1c1" stroke-width="1.5"/><path d="M8 8v6M11 8v6M14 8v6" stroke="#4fd1c1" stroke-width="1.6"/>',
  dock: '<rect x="2" y="5" width="18" height="12" rx="2" fill="none" stroke="#4fd1c1" stroke-width="1.5"/><rect x="5" y="9" width="3" height="4" fill="#4fd1c1"/><path d="M10 9h3v4h-3zM15 9h2v4h-2z" fill="none" stroke="#4fd1c1"/>',
  scout: '<path d="M18 11L5 5l3 6-3 6z" fill="#a99bff"/>', constructor: '<rect x="5" y="5" width="12" height="12" fill="#a99bff"/><rect x="9" y="9" width="4" height="4" fill="#0b0d10"/>',
  warden: '<path d="M19 11l-8-7-8 7 8 7z" fill="#a99bff"/>', judge: '<circle cx="11" cy="11" r="5" fill="#a99bff"/><circle cx="11" cy="11" r="8" fill="none" stroke="#a99bff" stroke-width="1.5"/>',
};
function renderBuildBar() {
  const box = $('#buildBar'); box.querySelectorAll('.bb').forEach((b) => b.remove());
  for (const kind of BUILD_ORDER) {
    const k = KINDS[kind], locked = S && S.rankI < k.rank;
    const b = document.createElement('button'); b.className = 'bb' + (locked ? ' lock' : '') + (mode === 'build:' + kind ? ' on' : ''); b.dataset.kind = kind;
    b.innerHTML = '<svg viewBox="0 0 22 22">' + ICON[kind] + '</svg><span class="n">' + k.name + ' <kbd>' + k.key.toUpperCase() + '</kbd></span><span class="c">' + (locked ? RANKS[k.rank].n : money(k.cost) + (k.bp ? ' · ' + k.bp + ' bp' : '')) + '</span>';
    b.title = k.sf; b.addEventListener('click', () => startBuild(kind));
    box.appendChild(b);
  }
}
function renderTrainBar() {
  const box = $('#trainBar'); box.querySelectorAll('.bb').forEach((b) => b.remove());
  for (const type of TRAIN_ORDER) {
    const k = UNITS[type], locked = S && S.rankI < k.rank;
    const queued = S ? S.trainQ.filter((q) => q.type === type).length : 0;
    const b = document.createElement('button'); b.className = 'bb' + (locked ? ' lock' : ''); b.dataset.unit = type;
    b.innerHTML = '<svg viewBox="0 0 22 22">' + ICON[type] + '</svg><span class="n">' + k.name + ' <kbd>' + k.key.toUpperCase() + '</kbd></span><span class="c">' + (locked ? RANKS[k.rank].n : k.model + ' · ' + k.power + ' slot' + (k.power > 1 ? 's' : '') + (queued ? ' · +' + queued : '')) + '</span>';
    b.title = k.sf; b.addEventListener('click', () => train(type));
    box.appendChild(b);
  }
}
function renderMissions() {
  const act = MISSIONS.filter((m) => !S.done.has(m.id)).slice(0, 3);
  const last = MISSIONS.filter((m) => S.done.has(m.id)).slice(-1);
  $('#misCount').textContent = S.done.size + ' of ' + MISSIONS.length;
  $('#missions').innerHTML = [...last, ...act].map((m) => {
    const [v, n] = m.p(), d = S.done.has(m.id);
    return '<div class="mis' + (d ? ' done' : '') + '"><div class="mt">' + m.t + '<span>' + (d ? 'done' : '+' + m.r) + '</span></div><p>' + m.d + '</p><div class="bar"><i style="width:' + Math.round(Math.min(1, v / n) * 100) + '%"></i></div></div>';
  }).join('') || '<div class="mis done"><div class="mt">All missions done</div><p>Keep building, or start a new base.</p></div>';
}
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function renderSel() {
  const box = $('#sel');
  sel = sel.filter((o) => S.structs.includes(o) || S.units.includes(o) || S.bugs.includes(o) || S.signals.includes(o));
  let h = '<h3>Selected</h3>';
  if (!sel.length) h += '<div class="empty">Click a building or an agent. Drag to select several agents. Right-click gives orders.</div>';
  else if (sel.length > 1) {
    const c = {}; sel.forEach((u) => { c[u.type] = (c[u.type] || 0) + 1; });
    h += '<div class="st">' + sel.length + ' agents</div><div class="sf">' + Object.entries(c).map(([k, v]) => v + ' ' + UNITS[k].name + (v > 1 ? 's' : '')).join(', ') + '. Right-click: Scouts carry ideas, Constructors build, Wardens fight and repair, everyone moves.</div>';
  } else {
    const o = sel[0];
    if (o.type) {
      const k = UNITS[o.type];
      const task = !o.powered ? 'Waiting for a free slot' : o.task === 'no budget' ? 'Stopped at the budget cap' : o.order ? ({ move: 'Moving', attack: 'Attacking a bug', repair: 'Repairing', build: 'Building', carry: 'Fetching an idea' }[o.order.type]) : ({ fetch: 'Fetching a loose idea', deliver: 'Carrying an idea to the Refinery', holding: 'Holding an idea: no Refinery yet', 'store full': 'Waiting: Blueprint store is full (12)', build: 'Building ' + (byId(o.target)?.name || ''), fight: 'Fighting a bug', repair: 'Repairing ' + (byId(o.target)?.name || ''), review: 'Reviewing ' + (byId(o.target)?.name || '') }[o.task] || (o.holdT > 0 ? 'Holding position' : 'Idle near the Command Center'));
      h += '<div class="st">' + k.name + '</div><div class="sf"><b>In SoftwareFactory:</b> ' + k.sf + '</div><dl class="kv"><dt>Doing</dt><dd>' + esc(task) + '</dd><dt>Model</dt><dd>' + k.model + '</dd><dt>Rank</dt><dd>' + unitRank(o) + ' · ' + o.xp + ' jobs done</dd>' + (o.carry ? '<dt>Carrying</dt><dd>"' + esc(o.carry) + '"</dd>' : '') + '</dl>';
    } else if (o.kind) {
      const k = KINDS[o.kind];
      let state = o.state === 'breached' ? 'Breached: needs a Warden' : o.state === 'building' && !k.project ? 'Setting up ' + Math.round(o.prog * 100) + '%' : o.online ? 'Online' : o.linked ? 'Linked' : 'Not connected: press C, then click it and a connected building';
      if (o.kind === 'app') state = ({ spec: 'Writing the spec', gate: 'Plan ready: needs your OK', build: 'Building', test: 'Testing', wave: 'Release wave', repairs: 'Breached during release: repair to ship', shipped: o.state === 'breached' ? 'Shipped, now breached' : 'Shipped' }[o.phase]) + (['spec', 'build', 'test'].includes(o.phase) ? ' ' + Math.round(o.prog * 100) + '%' : '') + (!o.linked ? ' · not connected' : '');
      h += '<div class="st">' + esc(o.name) + (o.kind === 'app' ? ' · App' : '') + '</div><div class="sf"><b>In SoftwareFactory:</b> ' + k.sf + '</div><dl class="kv"><dt>State</dt><dd>' + esc(state) + '</dd><dt>Integrity</dt><dd>' + Math.round(o.integ) + '%</dd><dt>Links</dt><dd>' + S.conduits.filter((c) => c.a === o.id || c.b === o.id).length + ' conduits</dd>';
      if (o.kind === 'refinery') h += '<dt>Queue</dt><dd>' + o.queue + ' ideas</dd>';
      if (o.kind === 'app' && o.real) h += '<dt>Real project</dt><dd>' + esc(o.real.status) + '</dd><dt>Open tickets</dt><dd>' + o.real.open + (o.real.bugs ? ' · ' + o.real.bugs + ' bug' + (o.real.bugs > 1 ? 's' : '') : '') + '</dd><dt>For your look</dt><dd>' + o.real.look + '</dd>';
      if (o.kind === 'app' && o.workers) h += '<dt>Crew</dt><dd>' + o.workers + ' Constructor' + (o.workers > 1 ? 's' : '') + '</dd>';
      h += '</dl><div class="acts">';
      if (o.kind === 'barracks') h += TRAIN_ORDER.filter((t) => S.rankI >= UNITS[t].rank).map((t) => '<button class="btn" data-train="' + t + '">Train ' + UNITS[t].name + '</button>').join('');
      if (o.kind === 'archive') {
        if (S.beacons.some((b) => b.type === 'rift')) h += '<span class="empty">A rule conflict blocks research. Resolve it first.</span>';
        else if (S.researching) h += '<span class="empty">Researching ' + RESEARCH[S.researching.id].name + ' ' + Math.round(S.researching.t * 10) + '%</span>';
        else h += Object.entries(RESEARCH).filter(([id]) => !S.research[id]).map(([id, r]) => '<button class="btn" data-research="' + id + '" title="' + r.d + '"' + (S.data < r.cost || !o.online ? ' disabled' : '') + '>' + r.name + ' · ' + r.cost + ' data</button>').join('') || '<span class="empty">All research done.</span>';
      }
      if (o.kind === 'app' && o.real && CAN_ORDER) h += '<button class="btn" data-order="1" title="Opens a real ticket in this project. Free.">Give an order</button>';
      if (o.state === 'breached') h += '<button class="btn" data-send="repair">Send nearest Warden</button>';
      if (o.phase === 'gate') h += '<button class="btn" data-gate="1">Review the plan</button>';
      if (!o.linked && o.kind !== 'hq') h += '<button class="btn" data-connect="1">Connect it</button>';
      h += '</div>';
    } else if (o.hp !== undefined) {
      h += '<div class="st">Bug</div><div class="sf"><b>In SoftwareFactory:</b> a bug ticket' + (o.wave ? ' from a release test (an edge case)' : ' reported against ' + esc(o.from)) + '. Clearing it is a fix run.</div><dl class="kv"><dt>Size</dt><dd>' + Math.round(o.hp) + ' of ' + Math.round(o.max) + '</dd><dt>Age</dt><dd>' + Math.round(o.age) + 's, it grows if left alone</dd></dl><div class="acts"><button class="btn" data-send="attack">Send nearest Warden</button></div>';
    } else if (o.text) {
      h += '<div class="st">Loose idea</div><div class="sf"><b>In SoftwareFactory:</b> a note or request waiting to be sorted. A Scout carries it to the Refinery, which turns it into a ticket.</div><dl class="kv"><dt>Says</dt><dd>"' + esc(o.text) + '"</dd></dl>';
    }
  }
  box.innerHTML = h;
  box.querySelectorAll('[data-train]').forEach((b) => b.addEventListener('click', () => train(b.dataset.train)));
  box.querySelectorAll('[data-research]').forEach((b) => b.addEventListener('click', () => { const id = b.dataset.research; if (S.data >= RESEARCH[id].cost) { S.data -= RESEARCH[id].cost; S.researching = { id, t: 0 }; log('Researching ' + RESEARCH[id].name + '.', ''); selDirty = true; } }));
  box.querySelectorAll('[data-send]').forEach((b) => b.addEventListener('click', () => {
    const o = sel[0], w = nearest(S.units, o, 1e9, (u) => u.type === 'warden');
    if (!w) { toast('No Warden yet: train one (V)', 'bad'); return; }
    w.order = b.dataset.send === 'repair' ? { type: 'repair', id: o.id } : { type: 'attack', id: o.id }; w.holdT = 0;
  }));
  box.querySelectorAll('[data-order]').forEach((b) => b.addEventListener('click', () => openOrder(sel[0])));
  box.querySelectorAll('[data-gate]').forEach((b) => b.addEventListener('click', () => { const i = S.beacons.findIndex((x) => x.sid === sel[0].id); if (i >= 0) { gateIdx = i; gateDirty = true; } }));
  box.querySelectorAll('[data-connect]').forEach((b) => b.addEventListener('click', () => { const o = sel[0]; setMode('connect'); connectFrom = o; updateHint(); }));
}
function currentBeacon() { if (!S.beacons.length) return null; gateIdx = Math.min(gateIdx, S.beacons.length - 1); return S.beacons[gateIdx]; }
function renderGate() {
  const b = currentBeacon(), g = $('#gate');
  if (!b) { g.hidden = true; return; }
  g.hidden = false;
  $('#gCount').textContent = S.beacons.length > 1 ? (gateIdx + 1) + ' of ' + S.beacons.length + ' · Tab for next' : '';
  if (b.type === 'plan') {
    $('#gKind').textContent = 'Your OK: plan'; $('#gTitle').textContent = b.title;
    $('#gBody').textContent = b.body + ' Build run already held in your budget.';
    $('#gRow').innerHTML = '<button class="btn ok" id="gOk">Approve<kbd>Enter</kbd></button><input id="gNote" placeholder="Note for the agent (optional)" maxlength="120"><button class="btn" id="gBack">Send back<kbd>⌫</kbd></button>';
    $('#gOk').onclick = () => decide(b, 'approve');
    $('#gBack').onclick = () => decide(b, 'back', $('#gNote').value.trim());
  } else {
    $('#gKind').textContent = 'Rule conflict'; $('#gTitle').textContent = b.title;
    $('#gBody').textContent = 'These two project rules contradict each other. Keep one; research is blocked until you do.';
    $('#gRow').innerHTML = '<button class="btn ok" id="gA">Keep: ' + esc(b.a) + '<kbd>Enter</kbd></button><button class="btn" id="gB">Keep: ' + esc(b.b) + '</button>';
    $('#gA').onclick = () => decide(b, 'a'); $('#gB').onclick = () => decide(b, 'b');
  }
}
let last = {};
function setText(id, v) { if (last[id] !== v) { last[id] = v; document.getElementById(id).textContent = v; } }
function renderHud() {
  const p = power();
  setText('rCr', money(S.credits) + ' / ' + money(CAP));
  document.querySelector('.res .cr').classList.toggle('low', !!(S.credits < 0.5));
  setText('rPw', p.used + '/' + p.cap);
  setText('rBp', String(S.blueprints)); setText('rDt', String(S.data)); setText('rBc', String(S.beacons.length)); setText('rRn', String(S.renown));
  const r = RANKS[S.rankI], nx = RANKS[S.rankI + 1];
  setText('rRank', r.n);
  document.getElementById('rRankBar').style.width = (nx ? Math.round((S.renown - r.at) / (nx.at - r.at) * 100) : 100) + '%';
  setText('clock', 'Day ' + S.day + ' ' + timeStr());
  if (feedDirty) { feedDirty = false; $('#feed').innerHTML = S.feed.slice(0, 14).map((f) => '<div><time>' + f.t + '</time><span class="' + f.cls + '">' + esc(f.text) + '</span></div>').join(''); }
  if (gateDirty) { gateDirty = false; renderGate(); }
  const tq = S.trainQ.map((q) => q.type).join(',');
  if (tq !== last.tq) { last.tq = tq; renderTrainBar(); }
  renderMissions();
  // build bar: mark what you cannot afford right now
  document.querySelectorAll('#buildBar .bb').forEach((b) => { const k = KINDS[b.dataset.kind]; b.classList.toggle('cant', !!(S.rankI >= k.rank && (S.credits + 1e-9 < k.cost || (k.bp && S.blueprints < k.bp)))); });
}
function showEnd() {
  const m = Math.round(S.t / 60);
  $('#endTitle').textContent = S.name + ' secured';
  $('#endSub').textContent = 'Two apps shipped and both release waves held, in about ' + m + ' minute' + (m === 1 ? '' : 's') + ' of play. Rank: ' + RANKS[S.rankI].n + ', ' + S.renown + ' renown.';
  const rows = [
    ['Projects created', S.stats.projects], ['Loose ideas sorted into tickets', S.stats.refined], ['Apps shipped', S.stats.shipped], ['Plans you approved', S.approvals], ['Plans you sent back', S.sendBacks],
    ['Bugs fixed', S.stats.bugs], ['Breaches repaired', S.stats.repairs], ['Agents set up', Object.values(S.stats.trained).reduce((a, b) => a + b, 0) + 1], ['Agent runs paid for', S.runs], ['Real tickets opened', S.orders || 0], ['Practice budget spent', money(S.spent)],
  ];
  $('#rcpt').innerHTML = rows.map(([a, b]) => '<dt>' + a + '</dt><dd>' + b + '</dd>').join('');
  $('#end').hidden = false; S.paused = true;
}

/* ---------------- loop ---------------- */
let lastT = 0, acc = 0, hudT = 0, miniT = 0;
function frame(now) {
  requestAnimationFrame(frame);
  if (document.hidden || !S) { lastT = now; return; }
  if (!lastT) lastT = now;
  const el = (now - lastT) / 1000;
  if (el < 1 / 32) return;          // about 30 frames a second, never more
  lastT = now;
  const step = Math.min(0.1, el);
  if (!S.paused && $('#menu').hidden && $('#end').hidden) {
    const n = S.speed; for (let i = 0; i < n; i++) update(step);
  }
  if (hold) { hold.t += step; if (hold.t >= hold.need) { const g = hold; hold = null; const s = place(ghost.kind, g.gx, g.gy); if (s) { S.lastPlaced = s; if (s.kind !== 'feature') { setMode('connect'); connectFrom = s; S.lastPlaced = s; updateHint(); } else setMode(null); sel = [s]; selDirty = true; } } }
  draw(now);
  hudT += step; miniT += step;
  if (hudT > 0.2) { hudT = 0; renderHud(); if (selDirty || sel.length) { selDirty = false; renderSelThrottled(); } updateHint(); }
  if (miniT > 0.2) { miniT = 0; drawMini(); }
}
let selKey = '';
function renderSelThrottled() {
  const o = sel[0];
  const key = sel.map((x) => x.id).join(',') + '|' + (o ? [o.state, o.phase, Math.round((o.prog || 0) * 20), Math.round(o.integ || 0), o.task, o.order && o.order.type, o.queue, o.xp, o.linked, o.hp && Math.round(o.hp), S.researching && Math.round(S.researching.t), S.data, S.beacons.length, S.rankI].join(',') : '');
  if (key === selKey) return; selKey = key; renderSel();
}
lastT = 0;
new ResizeObserver(resize).observe($('#stage'));

/* ---------------- bases menu ---------------- */
function bases() { try { return JSON.parse(localStorage.getItem('sector.bases') || '[]'); } catch { return []; } }
function saveBases(list) { try { localStorage.setItem('sector.bases', JSON.stringify(list)); } catch { /* storage may be off in the sandbox */ } }
function renderBases() {
  const list = bases();
  $('#baseList').innerHTML = list.length ? list.slice(-4).reverse().map((b) => '<div class="base-row"><span>' + esc(b.name) + '<br><small>' + esc(b.folder) + '</small></span><small>' + esc(b.when) + '</small></div>').join('') : '<div class="base-row"><span style="color:var(--muted)">No bases yet. Start one below.</span></div>';
  $('#resumeBtn').hidden = !S;
}
$('#startBtn').addEventListener('click', () => {
  const name = $('#nbName').value.trim() || 'Home base', folder = $('#nbFolder').value.trim() || 'C:\\Factories\\home-base';
  const list = bases(); list.push({ name, folder, when: new Date().toISOString().slice(0, 16).replace('T', ' ') }); saveBases(list.slice(-8));
  newGame(name, folder); $('#baseName').textContent = name; $('#menu').hidden = true; setSpeed(1); S.paused = false;
});
$('#resumeBtn').addEventListener('click', () => { $('#menu').hidden = true; });
$('#menuBtn').addEventListener('click', () => { renderBases(); $('#menu').hidden = false; });
$('#keepBtn').addEventListener('click', () => { $('#end').hidden = true; S.paused = false; });
$('#againBtn').addEventListener('click', () => { $('#end').hidden = true; renderBases(); $('#menu').hidden = false; });
$('#nbName').addEventListener('input', (e) => { $('#nbFolder').value = 'C:\\Factories\\' + (e.target.value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'base'); });

/* ---------------- the real factory ----------------
   With records:read the map is named after what is really there: each App you place is one of
   your projects (most open work first), and the loose ideas Scouts carry are your open tickets.
   It only reads. Without the permission, or outside SoftwareFactory, the practice data stays. */
let REAL = null;
/* Orders from the map: with the `actions` permission and ticket.open, an App that stands for a real
   project can be given an order. It opens a ticket there and nothing else; working it stays a choice
   made in SoftwareFactory, so an order never spends. Every order lands in the feed and the receipt. */
let CAN_ORDER = false, orderApp = null, orderBusy = false, wasPaused = false;
function openOrder(app) {
  if (!app || !app.real) return;
  orderApp = app; wasPaused = S.paused; S.paused = true;
  $('#orderFor').textContent = app.real.name; $('#orderText').value = ''; $('#orderMsg').textContent = '';
  $('#order').hidden = false; $('#orderText').focus();
}
function closeOrder() { $('#order').hidden = true; if (S) S.paused = wasPaused; orderApp = null; }
function sendOrder() {
  const title = $('#orderText').value.trim();
  if (orderBusy || !orderApp) return;
  if (title.length < 3) { $('#orderMsg').textContent = 'Say what should be done first.'; return; }
  const kind = (document.querySelector('input[name=orderKind]:checked') || {}).value || 'request';
  const app = orderApp; orderBusy = true; $('#orderMsg').textContent = 'Sending…';
  sf.act('ticket.open', { title: title, kind: kind, project: app.real.id }).then((t) => {
    orderBusy = false; app.real.open++; if (kind === 'bug') app.real.bugs++;
    S.orders = (S.orders || 0) + 1;
    log('Order sent: ' + (t && t.key ? t.key + ' ' : '') + '"' + title + '" is now a real ticket in ' + app.real.name + '.', 'g');
    floatText(app.x, app.y - app.r - 10, (t && t.key) || 'ticket', COL.teal);
    closeOrder(); selDirty = true;
  }, (e) => { orderBusy = false; $('#orderMsg').textContent = 'Not sent: ' + String(e && e.message || e).slice(0, 160); });
}
$('#orderSend').addEventListener('click', sendOrder);
$('#orderCancel').addEventListener('click', closeOrder);
function loadReal() {
  const note = (t) => { $('#intel').textContent = t; };
  if (!window.sf || !sf.records) { note('Practice run: this page is not connected to a factory, so the names are made up.'); return; }
  Promise.all([sf.records('projects', { limit: 200 }), sf.records('tickets', { limit: 2000 }), sf.records('agents', { limit: 200 })]).then(([projects, tickets, agents]) => {
    const open = tickets.filter((t) => t.status !== 'closed' && t.status !== 'rejected');
    const rows = projects.filter((p) => p.status !== 'archived').map((p) => {
      const mine = open.filter((t) => t.project === p.id);
      return { id: p.id, name: p.name, summary: p.summary || '', status: p.status, open: mine.length, bugs: mine.filter((t) => t.kind === 'bug').length, look: mine.filter((t) => t.status === 'built').length };
    }).sort((a, b) => b.open - a.open);
    REAL = { projects: rows, tickets: open, agents: agents.filter((a) => !a.retired) };
    if (rows.length) APPS = rows.map((r) => ({ n: r.name, plan: (r.summary || 'A project in your factory.').slice(0, 220) + (r.open ? ' Open work: ' + r.open + ' ticket' + (r.open > 1 ? 's' : '') + '.' : ''), real: r }));
    const ideas = open.filter((t) => t.status === 'open' && t.level !== 'epic').map((t) => (t.key + ' ' + t.title).slice(0, 60));
    if (ideas.length >= 3) IDEAS = ideas;
    note('Reading your factory: ' + rows.length + ' project' + (rows.length === 1 ? '' : 's') + ', ' + open.length + ' open ticket' + (open.length === 1 ? '' : 's') + ', ' + REAL.agents.length + ' agents. Apps you place are your projects and loose ideas are your open tickets. Select an App and press Give an order to open a real ticket in it.');
    CAN_ORDER = !!sf.act;
    $('#dataNote').textContent = 'Your real projects and tickets · orders open real tickets · spends nothing';
  }).catch((e) => { note('Practice run: could not read your factory (' + String(e && e.message || e).slice(0, 80) + '), so the names are made up.'); });
}

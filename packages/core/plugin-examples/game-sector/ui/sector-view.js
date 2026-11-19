'use strict';
/* ---------------- view: camera, input ---------------- */
const cv = $('#cv'), ctx = cv.getContext('2d'), mini = $('#mini'), mctx = mini.getContext('2d');
const cam = { x: 0, y: 0, z: 1 };
let vw = 800, vh = 500, dpr = 1;
let sel = [], mode = null, ghost = null, hover = null, mouse = { x: 0, y: 0, wx: 0, wy: 0, in: false };
let drag = null, hold = null, connectFrom = null;
let feedDirty = true, selDirty = true, gateDirty = true, gateIdx = 0;
let terrain = null;

function resize() {
  const r = $('#stage').getBoundingClientRect();
  dpr = Math.min(2, window.devicePixelRatio || 1);
  const cx = cam.x + vw / 2 / cam.z, cy = cam.y + vh / 2 / cam.z;
  vw = Math.max(200, r.width); vh = Math.max(200, r.height);
  cv.width = Math.round(vw * dpr); cv.height = Math.round(vh * dpr);
  if (S) centerOn(cx, cy); else clampCam();
}
function centerOn(x, y) { cam.x = x - vw / 2 / cam.z; cam.y = y - vh / 2 / cam.z; clampCam(); }
function clampCam() { cam.x = clamp(cam.x, -80, W - vw / cam.z + 80); cam.y = clamp(cam.y, -80, H - vh / cam.z + 80); }
const toWorld = (sx, sy) => ({ x: sx / cam.z + cam.x, y: sy / cam.z + cam.y });

function buildTerrain() {
  terrain = document.createElement('canvas'); terrain.width = W; terrain.height = H;
  const t = terrain.getContext('2d');
  t.fillStyle = '#0a0c0f'; t.fillRect(0, 0, W, H);
  let seed = 7; const r = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 70; i++) { // soft ground patches
    t.fillStyle = r() > 0.5 ? 'rgba(20,26,31,.22)' : 'rgba(8,10,12,.3)';
    t.beginPath(); t.ellipse(r() * W, r() * H, 60 + r() * 200, 40 + r() * 140, r() * 3, 0, Math.PI * 2); t.fill();
  }
  t.strokeStyle = 'rgba(79,209,193,.045)'; t.lineWidth = 1.2; // contour lines
  for (let i = 0; i < 26; i++) {
    const cx = r() * W, cy = r() * H, rr = 50 + r() * 160;
    for (let k = 0; k < 3; k++) { t.beginPath(); t.ellipse(cx, cy, rr + k * 22, (rr + k * 22) * (0.55 + r() * 0.3), r() * 3, 0, Math.PI * 2); t.stroke(); }
  }
  t.strokeStyle = 'rgba(255,255,255,.028)'; t.lineWidth = 1;
  t.beginPath(); for (let x = 0; x <= W; x += CELL) { t.moveTo(x + .5, 0); t.lineTo(x + .5, H); } for (let y = 0; y <= H; y += CELL) { t.moveTo(0, y + .5); t.lineTo(W, y + .5); } t.stroke();
  t.strokeStyle = 'rgba(255,255,255,.05)';
  t.beginPath(); for (let x = 0; x <= W; x += CELL * 5) { t.moveTo(x + .5, 0); t.lineTo(x + .5, H); } for (let y = 0; y <= H; y += CELL * 5) { t.moveTo(0, y + .5); t.lineTo(W, y + .5); } t.stroke();
  for (let i = 0; i < 90; i++) { // rocks, kept away from the centre
    const x = r() * W, y = r() * H; if (Math.hypot(x - W / 2, y - H / 2) < 380) continue;
    const s = 4 + r() * 10; t.fillStyle = 'rgba(32,38,46,.9)'; t.beginPath();
    for (let k = 0; k < 6; k++) { const a = k / 6 * Math.PI * 2; t.lineTo(x + Math.cos(a) * s * (0.7 + r() * 0.5), y + Math.sin(a) * s * (0.7 + r() * 0.5)); }
    t.fill(); t.fillStyle = 'rgba(255,255,255,.04)'; t.fillRect(x - s / 3, y - s / 2, s / 2, 2);
  }
  t.strokeStyle = 'rgba(255,107,94,.18)'; t.setLineDash([6, 8]); t.strokeRect(8, 8, W - 16, H - 16); t.setLineDash([]);
}

function hitTest(wx, wy) {
  for (const u of S.units) if (Math.hypot(u.x - wx, u.y - wy) < 11) return { kind: 'unit', o: u };
  for (const b of S.bugs) if (Math.hypot(b.x - wx, b.y - wy) < 12) return { kind: 'bug', o: b };
  for (const g of S.signals) if (Math.hypot(g.x - wx, g.y - wy) < 11) return { kind: 'signal', o: g };
  const gx = Math.floor(wx / CELL), gy = Math.floor(wy / CELL);
  if (gx >= 0 && gy >= 0 && gx < COLS && gy < ROWS && occ[gy * COLS + gx]) { const s = byId(occ[gy * COLS + gx]); if (s) return { kind: 'struct', o: s }; }
  return null;
}
function setMode(m) {
  mode = m; connectFrom = null; hold = null;
  if (m && m.startsWith('build:')) { const k = m.slice(6); ghost = { kind: k }; } else ghost = null;
  cv.style.cursor = m ? 'crosshair' : 'default';
  renderBuildBar();
  $('#connectBtn').classList.toggle('on', m === 'connect');
  updateHint();
}
function startBuild(kind) {
  const k = KINDS[kind];
  if (S.rankI < k.rank) { toast(k.name + ' unlocks at ' + RANKS[k.rank].n, 'bad'); return; }
  setMode(mode === 'build:' + kind ? null : 'build:' + kind);
}
function updateHint() {
  const h = $('#hint'); let t = '';
  if (ghost) {
    const k = KINDS[ghost.kind];
    const why = ghost.gx !== undefined ? canPlace(ghost.kind, ghost.gx, ghost.gy) : '';
    t = why ? k.name + ': ' + why : k.name + ': click and hold to spend ' + money(k.cost) + (k.bp ? ' and ' + k.bp + ' Blueprint' + (k.bp > 1 ? 's' : '') : '') + '. Esc cancels.';
  } else if (mode === 'connect') t = connectFrom ? 'Connect ' + connectFrom.name + ' to… (click another building, Esc to stop)' : 'Connect: click a building, then another one nearby';
  h.textContent = t; h.hidden = !t;
}

cv.addEventListener('contextmenu', (e) => e.preventDefault());
cv.addEventListener('pointerdown', (e) => {
  const r = cv.getBoundingClientRect(), sx = e.clientX - r.left, sy = e.clientY - r.top, w = toWorld(sx, sy);
  cv.setPointerCapture(e.pointerId);
  if (e.button === 1 || (e.button === 0 && e.altKey)) { drag = { pan: true, sx, sy, cx: cam.x, cy: cam.y }; return; }
  if (e.button === 2) {
    if (mode) { setMode(null); return; }
    return order(w);
  }
  if (ghost) {
    if (ghost.gx === undefined) return;
    const why = canPlace(ghost.kind, ghost.gx, ghost.gy);
    if (why) { toast(why, 'bad'); return; }
    hold = { t: 0, need: 0.55, gx: ghost.gx, gy: ghost.gy };
    return;
  }
  if (mode === 'connect') {
    const h = hitTest(w.x, w.y);
    if (!h || h.kind !== 'struct') return;
    if (!connectFrom) { connectFrom = h.o; updateHint(); return; }
    const why = connect(connectFrom, h.o);
    if (why) toast(why, 'bad'); else { floatText(h.o.x, h.o.y - h.o.r, 'connected', COL.teal); connectFrom = null; if (S.lastPlaced) { S.lastPlaced = null; setMode(null); } }
    updateHint(); return;
  }
  drag = { sx, sy, ex: sx, ey: sy, box: false };
});
cv.addEventListener('pointermove', (e) => {
  const r = cv.getBoundingClientRect(), sx = e.clientX - r.left, sy = e.clientY - r.top;
  mouse.x = sx; mouse.y = sy; mouse.in = true;
  const w = toWorld(sx, sy); mouse.wx = w.x; mouse.wy = w.y;
  if (drag && drag.pan) { cam.x = drag.cx - (sx - drag.sx) / cam.z; cam.y = drag.cy - (sy - drag.sy) / cam.z; clampCam(); return; }
  if (drag) { drag.ex = sx; drag.ey = sy; if (Math.abs(sx - drag.sx) + Math.abs(sy - drag.sy) > 6) drag.box = true; }
  if (ghost) {
    const k = KINDS[ghost.kind];
    const gx = Math.round(w.x / CELL - k.size / 2), gy = Math.round(w.y / CELL - k.size / 2);
    if (gx !== ghost.gx || gy !== ghost.gy) { ghost.gx = gx; ghost.gy = gy; if (hold) hold = null; updateHint(); }
  }
  const h = hitTest(w.x, w.y); hover = h ? h.o : null;
});
cv.addEventListener('pointerleave', () => { mouse.in = false; hover = null; });
cv.addEventListener('pointerup', (e) => {
  if (hold) { hold = null; return; }
  if (!drag) return;
  const d = drag; drag = null;
  if (d.pan) return;
  const add = e.shiftKey;
  if (d.box) {
    const a = toWorld(Math.min(d.sx, d.ex), Math.min(d.sy, d.ey)), b = toWorld(Math.max(d.sx, d.ex), Math.max(d.sy, d.ey));
    const got = S.units.filter((u) => u.x >= a.x && u.x <= b.x && u.y >= a.y && u.y <= b.y);
    sel = add ? [...new Set([...sel, ...got])] : got;
  } else {
    const w = toWorld(d.sx, d.sy), h = hitTest(w.x, w.y);
    if (!h) sel = add ? sel : [];
    else if (add && h.kind === 'unit') sel = sel.includes(h.o) ? sel.filter((x) => x !== h.o) : [...sel.filter((x) => x.type), h.o];
    else sel = [h.o];
  }
  selDirty = true;
});
cv.addEventListener('wheel', (e) => {
  e.preventDefault();
  const r = cv.getBoundingClientRect(), sx = e.clientX - r.left, sy = e.clientY - r.top, before = toWorld(sx, sy);
  cam.z = clamp(cam.z * (e.deltaY < 0 ? 1.12 : 1 / 1.12), 0.5, 1.6);
  cam.x = before.x - sx / cam.z; cam.y = before.y - sy / cam.z; clampCam();
}, { passive: false });

function order(w) {
  const units = sel.filter((x) => x.type);
  if (!units.length) return;
  const h = hitTest(w.x, w.y);
  let n = 0;
  units.forEach((u, i) => {
    u.holdT = 0;
    if (h && h.kind === 'signal' && u.type === 'scout') { u.order = { type: 'carry', id: h.o.id }; n++; }
    else if (h && h.kind === 'bug' && u.type === 'warden') { u.order = { type: 'attack', id: h.o.id }; n++; }
    else if (h && h.kind === 'struct' && h.o.state === 'breached' && u.type === 'warden') { u.order = { type: 'repair', id: h.o.id }; n++; }
    else if (h && h.kind === 'struct' && u.type === 'constructor' && KINDS[h.o.kind].project && (h.o.state === 'building' || ['spec', 'build', 'test'].includes(h.o.phase))) { u.order = { type: 'build', id: h.o.id }; n++; }
    else { const a = i * 2.4, rr = i ? 14 + i * 4 : 0; u.order = { type: 'move', x: w.x + Math.cos(a) * rr, y: w.y + Math.sin(a) * rr }; u.task = null; u.target = null; n++; }
  });
  if (n) S.pings = { x: w.x, y: w.y, t: 0 };
}

window.addEventListener('keydown', (e) => {
  if (!$('#menu').hidden || !$('#end').hidden) return;
  if (!$('#order').hidden) { if (e.key === 'Escape') closeOrder(); if (e.key === 'Enter') sendOrder(); return; }
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input') { if (e.key === 'Enter') { const b = currentBeacon(); if (b && b.type === 'plan') decide(b, 'back', e.target.value.trim()); e.target.blur(); } if (e.key === 'Escape') e.target.blur(); return; }
  const k = e.key.toLowerCase();
  if (e.code && e.code.startsWith('Digit')) {
    const n = e.code.slice(5);
    if (e.shiftKey) { S.groups[n] = sel.filter((x) => x.type).map((u) => u.id); toast('Group ' + n + ' saved (' + S.groups[n].length + ' agents)'); }
    else if (S.groups[n]) { sel = S.groups[n].map(byId).filter(Boolean); selDirty = true; if (sel[0]) centerOn(sel[0].x, sel[0].y); }
    e.preventDefault(); return;
  }
  if (k === ' ' || k === 'p') { S.paused = !S.paused; $('#pauseBtn').classList.toggle('on', S.paused); $('#pauseBtn').textContent = S.paused ? 'Paused' : 'Pause'; e.preventDefault(); return; }
  if (k === 'escape') { if (mode) setMode(null); else { sel = []; selDirty = true; } return; }
  if (k === 'tab') { e.preventDefault(); if (S.beacons.length) { gateIdx = (gateIdx + 1) % S.beacons.length; gateDirty = true; const b = S.beacons[gateIdx], s = byId(b.sid); if (s) centerOn(s.x, s.y); } return; }
  if (k === 'enter') { const b = currentBeacon(); if (b) decide(b, b.type === 'plan' ? 'approve' : 'a'); return; }
  if (k === 'backspace') { const b = currentBeacon(); if (b && b.type === 'plan') { decide(b, 'back', ($('#gNote') || {}).value || ''); e.preventDefault(); } return; }
  if (k === 'c') { setMode(mode === 'connect' ? null : 'connect'); return; }
  const bk = BUILD_ORDER.find((x) => KINDS[x].key === k); if (bk) { startBuild(bk); return; }
  const tk = TRAIN_ORDER.find((x) => UNITS[x].key === k); if (tk) { train(tk); return; }
  const pan = 60 / cam.z;
  if (k === 'arrowleft') cam.x -= pan; if (k === 'arrowright') cam.x += pan; if (k === 'arrowup') cam.y -= pan; if (k === 'arrowdown') cam.y += pan;
  if (k.startsWith('arrow')) { clampCam(); e.preventDefault(); }
  if (k === '+' || k === '=') setSpeed(Math.min(4, S.speed * 2)); if (k === '-') setSpeed(Math.max(1, S.speed / 2));
});
function setSpeed(v) { S.speed = v; document.querySelectorAll('[data-speed]').forEach((b) => b.classList.toggle('on', +b.dataset.speed === v)); }
document.querySelectorAll('[data-speed]').forEach((b) => b.addEventListener('click', () => setSpeed(+b.dataset.speed)));
$('#pauseBtn').addEventListener('click', () => { S.paused = !S.paused; $('#pauseBtn').classList.toggle('on', S.paused); $('#pauseBtn').textContent = S.paused ? 'Paused' : 'Pause'; });
$('#connectBtn').addEventListener('click', () => setMode(mode === 'connect' ? null : 'connect'));
function miniJump(e) { const r = mini.getBoundingClientRect(); centerOn((e.clientX - r.left) / r.width * W, (e.clientY - r.top) / r.height * H); }
mini.addEventListener('pointerdown', (e) => { miniJump(e); mini.setPointerCapture(e.pointerId); mini.onpointermove = miniJump; });
mini.addEventListener('pointerup', () => { mini.onpointermove = null; });

/* ---------------- drawing ---------------- */
function draw(now) {
  const t = now / 1000;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#07090b'; ctx.fillRect(0, 0, vw, vh);
  // terrain: copy only the visible part
  const sx = Math.max(0, cam.x), sy = Math.max(0, cam.y), sw = Math.min(W, cam.x + vw / cam.z) - sx, sh = Math.min(H, cam.y + vh / cam.z) - sy;
  if (sw > 0 && sh > 0) ctx.drawImage(terrain, sx, sy, sw, sh, (sx - cam.x) * cam.z, (sy - cam.y) * cam.z, sw * cam.z, sh * cam.z);
  ctx.setTransform(dpr * cam.z, 0, 0, dpr * cam.z, -cam.x * cam.z * dpr, -cam.y * cam.z * dpr);

  // lit build area
  const ls = lights();
  ctx.fillStyle = 'rgba(79,209,193,.035)';
  for (const l of ls) { ctx.beginPath(); ctx.arc(l.x, l.y, l.r, 0, Math.PI * 2); ctx.fill(); }
  if (ghost) {
    ctx.strokeStyle = 'rgba(79,209,193,.35)'; ctx.setLineDash([6, 6]); ctx.lineWidth = 1.5;
    for (const l of ls) { ctx.beginPath(); ctx.arc(l.x, l.y, l.r, 0, Math.PI * 2); ctx.stroke(); }
    ctx.setLineDash([]);
  }

  // conduits with flowing dots
  for (const c of S.conduits) {
    const a = byId(c.a), b = byId(c.b); if (!a || !b) continue;
    const live = a.linked && b.linked && (passesPower(a) || passesPower(b));
    ctx.strokeStyle = '#1d232b'; ctx.lineWidth = 7; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    ctx.strokeStyle = live ? 'rgba(79,209,193,.55)' : 'rgba(154,162,173,.25)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    if (live && !REDUCED) {
      const L = dist(a, b), n = Math.max(1, Math.floor(L / 46));
      ctx.fillStyle = COL.teal;
      for (let i = 0; i < n; i++) { const f = ((t * 40 / L) + i / n) % 1; ctx.beginPath(); ctx.arc(a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f, 2.2, 0, Math.PI * 2); ctx.fill(); }
    }
  }
  if (mode === 'connect' && connectFrom && mouse.in) {
    const ok = Math.hypot(mouse.wx - connectFrom.x, mouse.wy - connectFrom.y) <= 9.5 * CELL;
    ctx.strokeStyle = ok ? 'rgba(79,209,193,.8)' : 'rgba(255,107,94,.8)'; ctx.setLineDash([8, 6]); ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(connectFrom.x, connectFrom.y); ctx.lineTo(mouse.wx, mouse.wy); ctx.stroke(); ctx.setLineDash([]);
  }

  // buildings
  for (const s of S.structs) drawStruct(s, t);
  // signals
  for (const g of S.signals) {
    const p = REDUCED ? 0.5 : (Math.sin(t * 3 + g.ph) + 1) / 2;
    ctx.fillStyle = 'rgba(79,209,193,' + (0.10 + p * 0.12) + ')'; ctx.beginPath(); ctx.arc(g.x, g.y, 10 + p * 4, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#d9fbf6'; ctx.beginPath(); ctx.moveTo(g.x, g.y - 6); ctx.lineTo(g.x + 4.5, g.y); ctx.lineTo(g.x, g.y + 6); ctx.lineTo(g.x - 4.5, g.y); ctx.closePath(); ctx.fill();
    if (hover === g) label(g.x, g.y - 16, '"' + g.text + '"', COL.ink);
  }
  // bugs
  for (const b of S.bugs) drawBug(b, t);
  // agents
  for (const u of S.units) drawUnit(u, t);
  // shots
  for (const sh of S.shots) { ctx.strokeStyle = sh.c; ctx.globalAlpha = 1 - sh.t / 0.18; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(sh.x1, sh.y1); ctx.lineTo(sh.x2, sh.y2); ctx.stroke(); ctx.globalAlpha = 1; }
  // beacons
  for (const b of S.beacons) {
    const s = byId(b.sid); if (!s) continue;
    const bob = REDUCED ? 0 : Math.sin(t * 4) * 3, y = s.y - s.r - 26 + bob;
    const cur = b === currentBeacon();
    if (!REDUCED) { const p = (t * 1.2) % 1; ctx.strokeStyle = 'rgba(245,177,76,' + (1 - p) * 0.6 + ')'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(s.x, s.y, s.r + 6 + p * 26, 0, Math.PI * 2); ctx.stroke(); }
    ctx.fillStyle = COL.amber; ctx.beginPath(); ctx.moveTo(s.x, y - 11); ctx.lineTo(s.x + 9, y); ctx.lineTo(s.x, y + 11); ctx.lineTo(s.x - 9, y); ctx.closePath(); ctx.fill();
    if (cur) { ctx.strokeStyle = COL.ink; ctx.lineWidth = 1.5; ctx.stroke(); }
    ctx.fillStyle = COL.bg; ctx.font = '700 12px ' + getComputedStyle(document.body).fontFamily; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('!', s.x, y + 1);
  }
  // wave warnings
  for (const s of S.structs) if (s.wave && s.wave.t > 0) {
    const [fx, fy] = s.wave.from;
    ctx.strokeStyle = 'rgba(255,107,94,.5)'; ctx.setLineDash([10, 10]); ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(fx, fy); ctx.lineTo(s.x, s.y); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(255,107,94,.18)'; ctx.beginPath(); ctx.arc(fx, fy, 60, 0, Math.PI * 2); ctx.fill();
    label(fx, fy - 70, 'Release wave in ' + Math.ceil(s.wave.t) + 's', COL.red);
  }
  // order ping
  if (S.pings) { S.pings.t += 1 / 30; const p = S.pings; if (p.t < 0.5) { ctx.strokeStyle = 'rgba(169,155,255,' + (1 - p.t * 2) + ')'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(p.x, p.y, 6 + p.t * 30, 0, Math.PI * 2); ctx.stroke(); } }
  // floating labels
  for (const f of S.floats) { ctx.globalAlpha = 1 - f.t / 1.8; label(f.x, f.y, f.text, f.color, true); ctx.globalAlpha = 1; }
  // placement ghost
  if (ghost && ghost.gx !== undefined && mouse.in) drawGhost();

  // screen space: selection box, off-screen wave arrows
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (drag && drag.box) { ctx.strokeStyle = COL.violet; ctx.fillStyle = 'rgba(169,155,255,.08)'; ctx.lineWidth = 1; const x = Math.min(drag.sx, drag.ex), y = Math.min(drag.sy, drag.ey), w = Math.abs(drag.ex - drag.sx), h = Math.abs(drag.ey - drag.sy); ctx.fillRect(x, y, w, h); ctx.strokeRect(x + .5, y + .5, w, h); }
  for (const s of S.structs) if (s.wave) edgeArrow(s.wave.from[0], s.wave.from[1], COL.red);
  for (const b of S.beacons) { const s = byId(b.sid); if (s) edgeArrow(s.x, s.y, COL.amber); }
}
function edgeArrow(wx, wy, color) {
  const sx = (wx - cam.x) * cam.z, sy = (wy - cam.y) * cam.z;
  if (sx > 0 && sy > 0 && sx < vw && sy < vh) return;
  const cx = vw / 2, cy = vh / 2, a = Math.atan2(sy - cy, sx - cx);
  const m = 22, x = clamp(sx, m, vw - m), y = clamp(sy, m + 30, vh - m);
  ctx.save(); ctx.translate(x, y); ctx.rotate(a); ctx.fillStyle = color;
  ctx.beginPath(); ctx.moveTo(12, 0); ctx.lineTo(-6, -8); ctx.lineTo(-2, 0); ctx.lineTo(-6, 8); ctx.closePath(); ctx.fill(); ctx.restore();
}
let FONT = 'system-ui';
function label(x, y, text, color, bold) {
  ctx.font = (bold ? '600 ' : '500 ') + '12px ' + FONT; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const w = ctx.measureText(text).width + 10;
  ctx.fillStyle = 'rgba(11,13,16,.78)'; ctx.fillRect(x - w / 2, y - 8, w, 16);
  ctx.fillStyle = color; ctx.fillText(text, x, y + 0.5);
}
function poly(cx, cy, r, n, rot) { ctx.beginPath(); for (let i = 0; i < n; i++) { const a = rot + i / n * Math.PI * 2; ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r); } ctx.closePath(); }
function rrect(x, y, w, h, r) { ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x, y, w, h, r) : ctx.rect(x, y, w, h); }

function drawStruct(s, t) {
  const k = KINDS[s.kind], x = s.x, y = s.y, r = s.r - 4;
  const isSel = sel.includes(s), isHover = hover === s;
  const built = s.state !== 'building' && !(k.project && s.phase !== 'shipped' && s.phase !== 'repairs' && s.phase !== 'wave');
  const dark = s.state === 'breached' || (built && !s.online && s.kind !== 'hq');
  // footprint shadow
  ctx.fillStyle = 'rgba(0,0,0,.35)'; rrect(x - r + 3, y - r + 5, r * 2, r * 2, 6); ctx.fill();
  if (isSel || isHover) { ctx.strokeStyle = isSel ? COL.ink : 'rgba(242,240,235,.4)'; ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]); rrect(x - r - 6, y - r - 6, r * 2 + 12, r * 2 + 12, 8); ctx.stroke(); ctx.setLineDash([]); }

  if (!built && s.kind !== 'hq') { drawScaffold(s, t); }
  else {
    const accent = s.state === 'breached' ? COL.red : dark ? COL.mute : s.kind === 'reactor' || s.kind === 'barracks' ? COL.violet : (k.project ? COL.green : COL.teal);
    ctx.globalAlpha = dark && s.state !== 'breached' ? 0.55 : 1;
    if (s.kind === 'hq') {
      poly(x, y, r + 6, 6, Math.PI / 6); ctx.fillStyle = '#1c232b'; ctx.fill(); ctx.strokeStyle = '#3a4552'; ctx.lineWidth = 2; ctx.stroke();
      poly(x, y - 3, r - 8, 6, Math.PI / 6); ctx.fillStyle = '#26303b'; ctx.fill();
      poly(x, y - 5, r - 22, 6, Math.PI / 6); ctx.fillStyle = '#303c49'; ctx.fill();
      const p = REDUCED ? 0.6 : (Math.sin(t * 2) + 1) / 2;
      ctx.fillStyle = 'rgba(79,209,193,' + (0.25 + p * 0.25) + ')'; ctx.beginPath(); ctx.arc(x, y - 5, 16, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = s.state === 'breached' ? COL.red : COL.teal; ctx.beginPath(); ctx.arc(x, y - 5, 8, 0, Math.PI * 2); ctx.fill();
      for (let i = 0; i < 6; i++) { const a = Math.PI / 6 + i / 6 * Math.PI * 2; ctx.fillStyle = (Math.floor(t * 2) + i) % 6 === 0 && !REDUCED ? COL.ink : 'rgba(79,209,193,.7)'; ctx.beginPath(); ctx.arc(x + Math.cos(a) * (r - 2), y + Math.sin(a) * (r - 2), 2.4, 0, Math.PI * 2); ctx.fill(); }
      if (S.hqLevel >= 2) { ctx.strokeStyle = 'rgba(79,209,193,.5)'; ctx.lineWidth = 1.5; poly(x, y, r + 14, 6, Math.PI / 6); ctx.stroke(); }
    } else if (s.kind === 'refinery') {
      rrect(x - r, y - r, r * 2, r * 2, 6); ctx.fillStyle = '#1b2229'; ctx.fill(); ctx.strokeStyle = '#323c47'; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.fillStyle = '#26303a'; ctx.beginPath(); ctx.arc(x - 8, y + 2, r * 0.55, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = accent; ctx.lineWidth = 3; ctx.beginPath(); const sp = s.online && s.queue > 0 && !REDUCED ? t * 3 : 0; ctx.arc(x - 8, y + 2, r * 0.38, sp, sp + Math.PI * 1.2); ctx.stroke();
      ctx.fillStyle = '#2d3843'; ctx.fillRect(x + r * 0.45, y - r + 4, 10, r * 1.1);
      ctx.fillStyle = accent; ctx.fillRect(x + r * 0.45, y - r + 4, 10, 3);
      if (s.queue) label(x, y + r + 24, S.blueprints >= BP_CAP ? 'store full: use Blueprints' : s.queue + ' in queue', S.blueprints >= BP_CAP ? COL.amber : COL.teal);
    } else if (s.kind === 'barracks') {
      rrect(x - r, y - r * 0.8, r * 2, r * 1.6, 5); ctx.fillStyle = '#1d2229'; ctx.fill(); ctx.strokeStyle = '#353d48'; ctx.lineWidth = 1.5; ctx.stroke();
      for (let i = 0; i < 4; i++) { ctx.fillStyle = i < S.units.length ? 'rgba(169,155,255,.55)' : '#2a313b'; ctx.fillRect(x - r + 7 + i * (r * 2 - 14) / 4, y - r * 0.55, (r * 2 - 14) / 4 - 4, 8); }
      ctx.fillStyle = '#2a313b'; ctx.fillRect(x - 8, y + r * 0.3, 16, r * 0.5); ctx.fillStyle = accent; ctx.fillRect(x - 8, y + r * 0.3, 16, 2);
      if (S.trainQ.length && s.online) { const q = S.trainQ[0]; ctx.fillStyle = COL.violet; ctx.fillRect(x - r, y + r * 0.8 + 4, r * 2 * (q.t / UNITS[q.type].train), 3); }
    } else if (s.kind === 'reactor') {
      ctx.fillStyle = '#1b2027'; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); ctx.strokeStyle = '#353d48'; ctx.lineWidth = 2; ctx.stroke();
      ctx.strokeStyle = accent; ctx.lineWidth = 2; ctx.setLineDash([4, 5]); ctx.lineDashOffset = REDUCED ? 0 : -t * 12; ctx.beginPath(); ctx.arc(x, y, r * 0.7, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]); ctx.lineDashOffset = 0;
      const p = REDUCED ? 0.5 : (Math.sin(t * 3) + 1) / 2; ctx.fillStyle = s.online ? 'rgba(169,155,255,' + (0.5 + p * 0.4) + ')' : '#3a424d'; ctx.beginPath(); ctx.arc(x, y, r * 0.32, 0, Math.PI * 2); ctx.fill();
    } else if (s.kind === 'app') {
      rrect(x - r, y - r, r * 2, r * 2, 5); ctx.fillStyle = '#1a2026'; ctx.fill(); ctx.strokeStyle = '#34404b'; ctx.lineWidth = 1.5; ctx.stroke();
      rrect(x - r + 6, y - r + 6, r * 2 - 12, r * 2 - 18, 3); ctx.fillStyle = '#222a33'; ctx.fill();
      for (let i = 0; i < 9; i++) { const cx = x - r + 12 + (i % 3) * (r * 2 - 24) / 3, cy = y - r + 12 + Math.floor(i / 3) * (r * 2 - 30) / 3; ctx.fillStyle = s.online ? (i + Math.floor(t)) % 4 === 0 && !REDUCED ? 'rgba(143,212,122,.9)' : 'rgba(143,212,122,.45)' : '#323a44'; ctx.fillRect(cx, cy, (r * 2 - 24) / 3 - 5, (r * 2 - 30) / 3 - 5); }
      ctx.fillStyle = accent; ctx.fillRect(x - r, y + r - 6, r * 2, 3);
    } else if (s.kind === 'feature') {
      rrect(x - r, y - r, r * 2, r * 2, 4); ctx.fillStyle = '#1e252d'; ctx.fill(); ctx.strokeStyle = accent; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.fillStyle = s.online ? 'rgba(143,212,122,.6)' : '#333b45'; ctx.fillRect(x - 5, y - 5, 10, 10);
    } else if (s.kind === 'turret') {
      ctx.fillStyle = '#1c2229'; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); ctx.strokeStyle = '#38424d'; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.save(); ctx.translate(x, y); ctx.rotate(s.aim); ctx.fillStyle = accent; ctx.fillRect(0, -2.5, r + 4, 5); ctx.restore();
      ctx.fillStyle = '#2b333d'; ctx.beginPath(); ctx.arc(x, y, r * 0.5, 0, Math.PI * 2); ctx.fill();
      if (isSel) { ctx.strokeStyle = 'rgba(79,209,193,.25)'; ctx.beginPath(); ctx.arc(x, y, 150 * (countOnline('dock') ? 1.4 : 1), 0, Math.PI * 2); ctx.stroke(); }
    } else if (s.kind === 'archive') {
      poly(x, y, r, 8, Math.PI / 8); ctx.fillStyle = '#1c2229'; ctx.fill(); ctx.strokeStyle = '#38424d'; ctx.lineWidth = 1.5; ctx.stroke();
      for (let i = 0; i < 4; i++) { ctx.fillStyle = i % 2 ? '#2e3742' : accent; ctx.globalAlpha *= 0.85; ctx.fillRect(x - 14 + i * 7, y - 12, 5, 24); ctx.globalAlpha = dark ? 0.55 : 1; }
      if (S.researching) { ctx.strokeStyle = COL.teal; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(x, y, r + 4, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * S.researching.t / 10); ctx.stroke(); }
    } else if (s.kind === 'dock') {
      rrect(x - r, y - r * 0.85, r * 2, r * 1.7, 5); ctx.fillStyle = '#1c2128'; ctx.fill(); ctx.strokeStyle = '#38424d'; ctx.lineWidth = 1.5; ctx.stroke();
      for (let i = 0; i < 3; i++) { ctx.fillStyle = i === 0 ? accent : '#2b333d'; ctx.fillRect(x - r + 8 + i * (r * 2 - 16) / 3, y - 8, (r * 2 - 16) / 3 - 6, 16); }
    }
    ctx.globalAlpha = 1;
    if (s.state === 'breached') {
      const fl = REDUCED ? 0.5 : (Math.sin(t * 10) + 1) / 2;
      ctx.strokeStyle = 'rgba(255,107,94,' + (0.5 + fl * 0.5) + ')'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(x - 10, y - 10); ctx.lineTo(x + 10, y + 10); ctx.moveTo(x + 10, y - 10); ctx.lineTo(x - 10, y + 10); ctx.stroke();
    }
  }
  if (s.flash > 0) { ctx.strokeStyle = 'rgba(143,212,122,' + s.flash + ')'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(x, y, s.r + 10 + (1 - s.flash) * 30, 0, Math.PI * 2); ctx.stroke(); }
  // integrity
  if (s.integ < 100) { const w = s.r * 2 - 8; ctx.fillStyle = '#2a1416'; ctx.fillRect(x - w / 2, y - s.r - 8, w, 4); ctx.fillStyle = s.integ > 70 ? COL.green : s.integ > 30 ? COL.amber : COL.red; ctx.fillRect(x - w / 2, y - s.r - 8, w * s.integ / 100, 4); }
  // name and status
  let name = s.kind === 'feature' ? 'Feature' : s.name;
  if (s.kind === 'app' && s.phase !== 'shipped') name += ' · ' + ({ spec: 'spec', gate: 'needs your OK', build: 'build', test: 'test', wave: 'release wave', repairs: 'needs repair' }[s.phase] || '');
  label(x, y + s.r + 9, name, s.state === 'breached' ? COL.red : s.phase === 'gate' ? COL.amber : COL.ink2);
  if (s.kind !== 'hq' && !s.linked && (s.state !== 'building' || k.project || true) && s.kind !== 'feature') {
    if (!s.linked) label(x, y - s.r - 18, 'not connected: press C', COL.amber);
  }
}
function drawScaffold(s, t) {
  const k = KINDS[s.kind], x = s.x, y = s.y, r = s.r - 4;
  ctx.strokeStyle = 'rgba(79,209,193,.55)'; ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]); rrect(x - r, y - r, r * 2, r * 2, 5); ctx.stroke(); ctx.setLineDash([]);
  ctx.save(); rrect(x - r, y - r, r * 2, r * 2, 5); ctx.clip();
  ctx.strokeStyle = 'rgba(79,209,193,.12)'; ctx.lineWidth = 1;
  ctx.beginPath(); for (let i = -r * 2; i < r * 2; i += 9) { ctx.moveTo(x + i, y - r); ctx.lineTo(x + i + r * 2, y + r); } ctx.stroke();
  let f = s.prog;
  if (k.project && s.kind === 'app') { const done = { spec: 0, gate: 1, build: 1, test: 2, wave: 3 }[s.phase] || 0; f = (done + (s.phase === 'gate' || s.phase === 'wave' ? 0 : s.prog)) / 3; }
  ctx.fillStyle = 'rgba(79,209,193,.16)'; ctx.fillRect(x - r, y + r - r * 2 * f, r * 2, r * 2 * f);
  ctx.restore();
  if (s.kind === 'app') {
    const ph = ['spec', 'build', 'test', 'ship'], cur = { spec: 0, gate: 0, build: 1, test: 2, wave: 3 }[s.phase];
    for (let i = 0; i < 4; i++) { ctx.fillStyle = i < cur ? COL.green : i === cur ? (s.phase === 'gate' ? COL.amber : COL.teal) : '#2a313b'; ctx.fillRect(x - r + i * (r * 2) / 4 + 1, y - r - 2, (r * 2) / 4 - 2, 3); }
    if (s.phase !== 'gate' && s.phase !== 'wave') { ctx.fillStyle = COL.teal; ctx.fillRect(x - r, y + r + 1, r * 2 * s.prog, 2); }
    if (s.linked && !s.workers && ['spec', 'build', 'test'].includes(s.phase)) label(x, y, S.units.some((u) => u.type === 'constructor') ? 'waiting for a Constructor' : 'needs a Constructor (X)', COL.amber);
  } else {
    ctx.fillStyle = COL.teal; ctx.fillRect(x - r, y + r + 1, r * 2 * s.prog, 2);
    ctx.font = '500 12px ' + FONT; ctx.fillStyle = COL.ink2; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(Math.round(s.prog * 100) + '%', x, y);
  }
}
function drawBug(b, t) {
  const sz = 5 + (b.max / 60) * 7, x = b.x, y = b.y, a = Math.atan2((byId(b.target)?.y || y) - y, (byId(b.target)?.x || x) - x);
  ctx.save(); ctx.translate(x, y); ctx.rotate(a);
  ctx.strokeStyle = b.wave ? '#ff8a7f' : COL.red; ctx.lineWidth = 1.4;
  for (let i = -1; i <= 1; i++) { const w = REDUCED ? 0 : Math.sin(b.ph + i) * 2.5; ctx.beginPath(); ctx.moveTo(i * sz * 0.5, 0); ctx.lineTo(i * sz * 0.5 + w, -sz - 3); ctx.moveTo(i * sz * 0.5, 0); ctx.lineTo(i * sz * 0.5 - w, sz + 3); ctx.stroke(); }
  ctx.fillStyle = b.wave ? '#c9473e' : '#b8382f'; ctx.beginPath(); ctx.ellipse(0, 0, sz * 1.2, sz * 0.8, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = COL.red; ctx.beginPath(); ctx.arc(sz * 1.1, 0, sz * 0.45, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
  if (b.hp < b.max - 0.5) { ctx.fillStyle = '#2a1416'; ctx.fillRect(x - 9, y - sz - 8, 18, 3); ctx.fillStyle = COL.red; ctx.fillRect(x - 9, y - sz - 8, 18 * Math.max(0, b.hp / b.max), 3); }
  if (sel.includes(b) || hover === b) { ctx.strokeStyle = COL.ink; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(x, y, sz + 6, 0, Math.PI * 2); ctx.stroke(); }
}
function drawUnit(u, t) {
  const x = u.x, y = u.y, isSel = sel.includes(u);
  if (isSel) { ctx.strokeStyle = COL.ink; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.ellipse(x, y + 3, 11, 6, 0, 0, Math.PI * 2); ctx.stroke(); }
  ctx.fillStyle = 'rgba(0,0,0,.4)'; ctx.beginPath(); ctx.ellipse(x + 1, y + 5, 7, 3.5, 0, 0, Math.PI * 2); ctx.fill();
  const c = u.powered ? COL.violet : '#5b5670';
  ctx.save(); ctx.translate(x, y);
  ctx.fillStyle = c; ctx.strokeStyle = '#e9e5ff'; ctx.lineWidth = 1;
  if (u.type === 'scout') { ctx.rotate(u.face); ctx.beginPath(); ctx.moveTo(8, 0); ctx.lineTo(-6, -6); ctx.lineTo(-3, 0); ctx.lineTo(-6, 6); ctx.closePath(); ctx.fill(); }
  else if (u.type === 'constructor') { ctx.fillRect(-6, -6, 12, 12); ctx.fillStyle = COL.bg; ctx.fillRect(-2, -2, 4, 4); if (u.state === 'working' && !REDUCED) { ctx.rotate(t * 6); ctx.strokeStyle = COL.teal; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(0, 0, 10, 0, 1.4); ctx.stroke(); } }
  else if (u.type === 'warden') { ctx.rotate(u.face); ctx.beginPath(); ctx.moveTo(8, 0); ctx.lineTo(0, -7); ctx.lineTo(-8, 0); ctx.lineTo(0, 7); ctx.closePath(); ctx.fill(); ctx.fillStyle = COL.bg; ctx.fillRect(1, -1.5, 6, 3); }
  else if (u.type === 'judge') { ctx.beginPath(); ctx.arc(0, 0, 7, 0, Math.PI * 2); ctx.fill(); ctx.strokeStyle = '#e9e5ff'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(0, 0, 10, 0, Math.PI * 2); ctx.stroke(); }
  ctx.restore();
  if (u.carry) { ctx.fillStyle = '#d9fbf6'; ctx.beginPath(); ctx.moveTo(x, y - 15); ctx.lineTo(x + 3.5, y - 11); ctx.lineTo(x, y - 7); ctx.lineTo(x - 3.5, y - 11); ctx.closePath(); ctx.fill(); }
  if (u.xp >= 5) { ctx.strokeStyle = COL.amber; ctx.lineWidth = 1.5; for (let i = 0; i < (u.xp >= 15 ? 2 : 1); i++) { ctx.beginPath(); ctx.moveTo(x + 7, y + 8 + i * 3); ctx.lineTo(x + 9.5, y + 6 + i * 3); ctx.lineTo(x + 12, y + 8 + i * 3); ctx.stroke(); } }
  if (!u.powered) label(x, y - 18, 'no slot', COL.red);
  else if (u.task === 'no budget') label(x, y - 18, 'budget cap', COL.amber);
  if (hover === u && !isSel) label(x, y - 18, UNITS[u.type].name, COL.violet);
}
function drawGhost() {
  const k = KINDS[ghost.kind], why = canPlace(ghost.kind, ghost.gx, ghost.gy);
  const x0 = ghost.gx * CELL, y0 = ghost.gy * CELL, sz = k.size * CELL;
  ctx.fillStyle = why ? 'rgba(255,107,94,.18)' : 'rgba(79,209,193,.16)'; ctx.fillRect(x0, y0, sz, sz);
  ctx.strokeStyle = why ? COL.red : COL.teal; ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]); ctx.strokeRect(x0 + 1, y0 + 1, sz - 2, sz - 2); ctx.setLineDash([]);
  const cx = x0 + sz / 2, cy = y0 + sz / 2;
  label(cx, y0 - 12, k.name + ' · ' + money(k.cost) + (k.bp ? ' + ' + k.bp + ' bp' : ''), why ? COL.red : COL.ink);
  // nearest connectable building, as a hint
  if (!why) {
    const n = nearest(S.structs, { x: cx, y: cy }, 9.5 * CELL, (s) => s.linked);
    if (n) { ctx.strokeStyle = 'rgba(79,209,193,.4)'; ctx.setLineDash([4, 6]); ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(n.x, n.y); ctx.stroke(); ctx.setLineDash([]); }
  }
  if (hold) {
    ctx.strokeStyle = COL.amber; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(cx, cy, sz / 2 + 6, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, hold.t / hold.need)); ctx.stroke();
    label(cx, cy, 'spending ' + money(k.cost), COL.amber, true);
  }
}
function drawMini() {
  const sx = mini.width / W, sy = mini.height / H;
  mctx.clearRect(0, 0, mini.width, mini.height);
  mctx.fillStyle = 'rgba(79,209,193,.08)';
  for (const l of lights()) { mctx.beginPath(); mctx.arc(l.x * sx, l.y * sy, l.r * sx, 0, Math.PI * 2); mctx.fill(); }
  mctx.strokeStyle = 'rgba(79,209,193,.5)'; mctx.lineWidth = 1;
  for (const c of S.conduits) { const a = byId(c.a), b = byId(c.b); if (a && b) { mctx.beginPath(); mctx.moveTo(a.x * sx, a.y * sy); mctx.lineTo(b.x * sx, b.y * sy); mctx.stroke(); } }
  for (const s of S.structs) { mctx.fillStyle = s.state === 'breached' ? COL.red : s.kind === 'hq' ? COL.teal : s.online ? COL.ink2 : '#59616c'; const z = s.size * CELL * sx; mctx.fillRect(s.x * sx - z / 2, s.y * sy - z / 2, z, z); }
  mctx.fillStyle = COL.teal; for (const g of S.signals) mctx.fillRect(g.x * sx - 1, g.y * sy - 1, 2, 2);
  mctx.fillStyle = COL.violet; for (const u of S.units) mctx.fillRect(u.x * sx - 1, u.y * sy - 1, 2.5, 2.5);
  mctx.fillStyle = COL.red; for (const b of S.bugs) mctx.fillRect(b.x * sx - 1.5, b.y * sy - 1.5, 3, 3);
  mctx.fillStyle = COL.amber; for (const b of S.beacons) { const s = byId(b.sid); if (s) { mctx.beginPath(); mctx.arc(s.x * sx, s.y * sy - 6, 3, 0, Math.PI * 2); mctx.fill(); } }
  mctx.strokeStyle = COL.ink; mctx.strokeRect(cam.x * sx + .5, cam.y * sy + .5, vw / cam.z * sx, vh / cam.z * sy);
}


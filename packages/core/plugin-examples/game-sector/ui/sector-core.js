'use strict';
'use strict';
/* ============================================================
   Sector v2. Two layers: this file is the GAME layer running on a
   FAKE bridge (simulated SF data). Each game object carries an
   `sf` line saying which real SoftwareFactory record it stands for.
   ============================================================ */
const $ = (s) => document.querySelector(s);
const CELL = 40, COLS = 52, ROWS = 36, W = COLS * CELL, H = ROWS * CELL;
const COL = { bg: '#0b0d10', s1: '#0f1216', s2: '#14181d', s3: '#1a1f26', s4: '#20262e', s5: '#2a313b', ink: '#f2f0eb', ink2: '#c4c9d1', mute: '#9aa2ad', teal: '#4fd1c1', amber: '#f5b14c', green: '#8fd47a', red: '#ff6b5e', violet: '#a99bff' };
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
const GAME_HOUR = 6;          // real seconds per game hour at 1x
const CAP = 4;                // daily Budget cap in practice dollars
const BP_CAP = 12;            // Blueprint store: a ticket backlog has a sensible size

const KINDS = {
  hq:       { name: 'Command Center', sf: 'SoftwareFactory itself. Its level sets how big the base can grow.', size: 3, light: 7 },
  refinery: { name: 'Refinery', sf: 'The Order Engine. It sorts loose ideas into tickets (Blueprints).', size: 2, cost: 0.40, key: 'r', rank: 0, light: 4, build: 6 },
  barracks: { name: 'Barracks', sf: 'The Agent Bay, where agents are set up.', size: 2, cost: 0.30, key: 'b', rank: 0, light: 4, build: 6 },
  reactor:  { name: 'Reactor', sf: 'Agent slots: how many agents may run at once. +2 slots.', size: 2, cost: 0.50, key: 'e', rank: 0, light: 4, build: 6 },
  app:      { name: 'App', sf: 'A project: a real program with a UI, built by agent runs.', size: 2, cost: 1.20, bp: 3, key: 'a', rank: 0, light: 4, project: true },
  turret:   { name: 'Test Turret', sf: 'A test suite. It catches bugs that come near, at no agent cost.', size: 1, cost: 0.30, key: 't', rank: 1, light: 3, build: 4 },
  feature:  { name: 'Feature', sf: 'A feature added to a shipped app: one ticket, one build run.', size: 1, cost: 0.40, bp: 2, key: 'f', rank: 1, light: 3, project: true },
  archive:  { name: 'Archive', sf: 'Project rules (the Brain). Research here adds rules and abilities.', size: 2, cost: 0.60, key: 'h', rank: 2, light: 4, build: 8 },
  dock:     { name: 'Plugin Dock', sf: 'Plugins. Mounts a smoke scanner: turrets reach further, waves show early. +2 slots.', size: 2, cost: 0.80, key: 'g', rank: 3, light: 4, build: 8 },
};
const BUILD_ORDER = ['refinery', 'barracks', 'reactor', 'app', 'turret', 'feature', 'archive', 'dock'];
const UNITS = {
  scout:       { name: 'Scout', model: 'Haiku', job: 'Carries loose ideas to the Refinery', sf: 'An intake agent on Haiku. About $0.01 per idea carried.', speed: 96, power: 1, rank: 0, key: 'z', train: 3 },
  constructor: { name: 'Constructor', model: 'Sonnet', job: 'Raises Apps and Features: spec, build, test', sf: 'A builder agent on Sonnet. Its work is the build run you paid for when you placed the App.', speed: 62, power: 1, rank: 0, key: 'x', train: 4 },
  warden:      { name: 'Warden', model: 'Sonnet', job: 'Hunts bugs and repairs breaches', sf: 'A test-and-fix agent on Sonnet. About $0.03 per bug fixed, $0.10 per repair.', speed: 74, power: 1, rank: 0, key: 'v', train: 4 },
  judge:       { name: 'Judge', model: 'Opus', job: 'Reviews an app in test: its release wave is 40% smaller', sf: 'A review agent on Opus, the quality gate. About $0.15 per review. Uses 2 slots.', speed: 58, power: 2, rank: 2, key: 'j', train: 5 },
};
const TRAIN_ORDER = ['scout', 'constructor', 'warden', 'judge'];
const RANKS = [
  { n: 'Cadet', at: 0, unlock: '' },
  { n: 'Lieutenant', at: 40, unlock: 'Test Turret and Feature' },
  { n: 'Captain', at: 120, unlock: 'Archive and Judge' },
  { n: 'Commander', at: 220, unlock: 'Plugin Dock, Command Center level 2 (+2 slots)' },
  { n: 'Admiral', at: 360, unlock: 'Nothing new: a title for a well-run factory' },
];
let APPS = [
  { n: 'Recipe Box', plan: 'Three screens: recipes, one recipe, shopping list. Saves on this computer. Add, edit and delete everything from the app.' },
  { n: 'Habit Tracker', plan: 'A week grid with a tick per habit, streak view and reminders. Saves locally. Full add, edit and delete.' },
  { n: 'Word Counter', plan: 'Paste or open a file, see words, reading time and top words. History of past counts with delete.' },
  { n: 'Trip Planner', plan: 'Days, places and a packing list. Map preview. Export to PDF.' },
  { n: 'Budget Book', plan: 'Monthly categories, entries and a chart. Import a bank CSV.' },
];
let IDEAS = ['Dark mode for Recipe Box', 'Export habits to CSV', 'Shopping list sharing', 'Faster app start', 'Undo for deletes', 'Weekly summary email', 'Tags on recipes', 'Keyboard shortcuts', 'Print a recipe card', 'Reminder at 9pm', 'Count words in PDFs', 'Bigger text option', 'Backup to a folder', 'Search everything', 'Ask before closing unsaved', 'Photo per recipe', 'Streak freeze day', 'Sort by most used', 'Import from old app', 'Show reading time'];
const RIFTS = [
  ['Always ask before spending', 'Retry failed builds on its own'],
  ['Tests must pass before review', 'Review first, test after'],
  ['Keep every old ticket', 'Archive tickets idle for 30 days'],
];
const RESEARCH = {
  autosort: { name: 'Auto-sort', d: 'Refinery works twice as fast', cost: 15 },
  lint:     { name: 'Lint module', d: 'Fewer bugs: spawns slower, waves 2 smaller', cost: 20 },
  governor: { name: 'Budget governor', d: 'Agent fixes and repairs cost 40% less', cost: 15 },
  fastbuild:{ name: 'Faster builds', d: 'Constructors work 50% faster', cost: 25 },
};
const MISSIONS = [
  { id: 'm1', t: 'Establish the base', d: 'Build a Refinery and a Barracks and connect both to the Command Center (C).', r: 10, p: () => [Math.min(1, countOnline('refinery')) + Math.min(1, countOnline('barracks')), 2] },
  { id: 'm2', t: 'Staff up', d: 'Train a Constructor (X) and a Warden (V) at the Barracks.', r: 10, p: () => [Math.min(1, S.stats.trained.constructor) + Math.min(1, S.stats.trained.warden), 2] },
  { id: 'm3', t: 'First light', d: 'Refine 3 loose ideas into Blueprints.', r: 10, p: () => [Math.min(3, S.stats.refined), 3] },
  { id: 'm4', t: 'Ship your first app', d: 'Place an App (A), approve its plan, let it build, survive its release wave.', r: 20, p: () => [Math.min(1, S.stats.shipped), 1] },
  { id: 'm5', t: 'Hold the line', d: 'Survive a release wave with the app above 70% integrity. Wardens and Test Turrets help.', r: 20, p: () => [Math.min(1, S.stats.cleanWaves), 1] },
  { id: 'm6', t: 'Clean house', d: 'Clear 10 bugs.', r: 15, p: () => [Math.min(10, S.stats.bugs), 10] },
  { id: 'm7', t: 'Expand the grid', d: 'Attach a Feature (F) to a shipped App.', r: 20, p: () => [Math.min(1, S.stats.features), 1] },
  { id: 'm8', t: 'Second release', d: 'Ship a second App and survive its wave. Finish every mission to secure the base.', r: 30, p: () => [Math.min(2, S.stats.shipped), 2], final: true },
];

/* ---------------- state ---------------- */
let S, occ;
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const money = (v) => '$' + v.toFixed(2);

function newGame(name, folder) {
  S = {
    name: name || 'Home base', folder: folder || '', t: 0, clock: 8 * 3600, day: 1, credits: CAP, speed: 1, paused: false,
    structs: [], conduits: [], units: [], signals: [], bugs: [], shots: [], floats: [], beacons: [],
    blueprints: 0, data: 0, renown: 0, rankI: 0, nextId: 1, sigT: 1.5, riftT: 120, waveNo: 0,
    research: {}, researching: null, trainQ: [], appIdx: 0, groups: {}, done: new Set(), ended: false, won: false,
    feed: [], spent: 0, runs: 0, approvals: 0, sendBacks: 0, hqLevel: 1, netDirty: true,
    stats: { trained: { scout: 0, constructor: 0, warden: 0, judge: 0 }, refined: 0, shipped: 0, waves: 0, cleanWaves: 0, bugs: 0, features: 0, repairs: 0, projects: 0, carried: 0 },
  };
  occ = new Int32Array(COLS * ROWS);
  const hq = addStruct('hq', 24, 16);
  hq.state = 'online'; hq.prog = 1;
  addUnit('scout', hq.x - 70, hq.y + 10);
  S.stats.trained.scout = 0;
  for (let i = 0; i < 3; i++) spawnSignal(true);
  sel = []; mode = null; ghost = null;
  cam.z = 1; centerOn(hq.x + 60, hq.y);
  log('Base online. The Command Center is SoftwareFactory itself.', 'g');
  log('A Scout is holding loose ideas but has no Refinery to sort them. Build one with R.', 'a');
  renderMissions(); renderBuildBar(); renderTrainBar(); renderSel();
}

function addStruct(kind, gx, gy) {
  const k = KINDS[kind];
  const s = { id: S.nextId++, kind, gx, gy, size: k.size, x: (gx + k.size / 2) * CELL, y: (gy + k.size / 2) * CELL, r: k.size * CELL / 2,
    state: 'building', prog: 0, integ: 100, linked: false, online: false, name: k.name, flash: 0, cool: 0, aim: 0, workers: 0 };
  if (kind === 'app') { const a = APPS[S.appIdx++ % APPS.length]; s.name = a.n; s.plan = a.plan; s.real = a.real || null; s.phase = 'spec'; s.dataT = 0; s.spawnT = rnd(28, 40); }
  if (kind === 'feature') { s.phase = 'build'; s.name = 'Feature'; }
  if (kind === 'refinery') { s.queue = 0; s.work = 0; }
  for (let y = gy; y < gy + k.size; y++) for (let x = gx; x < gx + k.size; x++) occ[y * COLS + x] = s.id;
  S.structs.push(s); S.netDirty = true;
  return s;
}
function addUnit(type, x, y) {
  const u = { id: S.nextId++, type, x, y, tx: x, ty: y, state: 'idle', task: null, order: null, carry: null, xp: 0, cool: 0, work: 0, face: 0, holdT: 0, powered: true };
  S.units.push(u); return u;
}
function spawnSignal(nearHQ) {
  const hq = S.structs[0];
  for (let tries = 0; tries < 30; tries++) {
    const a = rnd(0, Math.PI * 2), d = nearHQ ? rnd(170, 300) : rnd(320, 820);
    const x = clamp(hq.x + Math.cos(a) * d, 60, W - 60), y = clamp(hq.y + Math.sin(a) * d * 0.8, 60, H - 60);
    const gx = Math.floor(x / CELL), gy = Math.floor(y / CELL);
    if (occ[gy * COLS + gx]) continue;
    S.signals.push({ id: S.nextId++, x, y, text: IDEAS[(S.ideaI = (S.ideaI || 0) + 1) % IDEAS.length], claimed: 0, ph: rnd(0, 6) });
    return;
  }
}
const byId = (id) => S.structs.find((s) => s.id === id) || S.units.find((u) => u.id === id) || S.bugs.find((b) => b.id === id) || S.signals.find((g) => g.id === id);
const countOnline = (kind) => S.structs.filter((s) => s.kind === kind && s.online).length;
const rankOf = (r) => { let i = 0; RANKS.forEach((k, j) => { if (r >= k.at) i = j; }); return i; };
function power() {
  let cap = S.hqLevel >= 2 ? 5 : 3;
  for (const s of S.structs) if (s.online && (s.kind === 'reactor' || s.kind === 'dock')) cap += 2;
  let used = 0; for (const u of S.units) used += UNITS[u.type].power;
  for (const q of S.trainQ) used += UNITS[q.type].power;
  return { cap, used };
}
function spend(v, why) {
  if (S.research.governor && /fix|repair/.test(why)) v *= 0.6;
  if (S.credits + 1e-9 < v) return false;
  S.credits -= v; S.spent += v; S.runs++;
  return true;
}
function log(text, cls) {
  S.feed.unshift({ t: timeStr(), text, cls: cls || '' });
  if (S.feed.length > 40) S.feed.pop();
  feedDirty = true;
}
function floatText(x, y, text, color) { S.floats.push({ x, y, text, color: color || COL.ink, t: 0 }); }
function toast(html, cls, ms) {
  const el = document.createElement('div'); el.className = 'toast ' + (cls || ''); el.innerHTML = html;
  $('#toasts').appendChild(el); setTimeout(() => el.remove(), ms || 2600);
  while ($('#toasts').children.length > 3) $('#toasts').firstChild.remove();
}
function timeStr() { const h = Math.floor(S.clock / 3600), m = Math.floor((S.clock % 3600) / 60); return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0'); }
function gainRenown(v, why, x, y) {
  S.renown += v;
  if (x !== undefined) floatText(x, y - 20, '+' + v + ' renown', COL.teal);
  const ri = rankOf(S.renown);
  if (ri > S.rankI) {
    S.rankI = ri; const r = RANKS[ri];
    toast('Promoted to <b>' + r.n + '</b>. Unlocked: ' + r.unlock, 'big', 4600);
    log('Promoted to ' + r.n + '. Unlocked: ' + r.unlock + '.', 'g');
    if (ri >= 3 && S.hqLevel < 2) { S.hqLevel = 2; S.structs[0].flash = 1; log('Command Center upgraded to level 2: +2 agent slots, wider build area.', 'g'); }
    renderBuildBar(); renderTrainBar();
  }
}

/* ---------------- network: conduits carry power from the Command Center ---------------- */
function recomputeNet() {
  const adj = new Map(); S.structs.forEach((s) => adj.set(s.id, []));
  for (const c of S.conduits) { adj.get(c.a)?.push(c.b); adj.get(c.b)?.push(c.a); }
  const map = new Map(S.structs.map((s) => [s.id, s]));
  S.structs.forEach((s) => { s.linked = false; });
  const hq = S.structs[0];
  if (hq.state !== 'breached') {
    hq.linked = true; const q = [hq];
    while (q.length) {
      const s = q.shift();
      for (const nid of adj.get(s.id)) { const n = map.get(nid); if (!n || n.linked) continue; n.linked = true; if (passesPower(n)) q.push(n); }
    }
  }
  S.structs.forEach((s) => { s.online = s.linked && s.state === 'online'; });
  S.netDirty = false;
}
function passesPower(s) { return s.state === 'online' && (!KINDS[s.kind].project || s.phase === 'shipped'); }
function lights() {
  const out = [];
  for (const s of S.structs) {
    if (s.kind === 'hq') out.push({ x: s.x, y: s.y, r: (KINDS.hq.light + (S.hqLevel - 1) * 2) * CELL });
    else if (s.online && passesPower(s)) out.push({ x: s.x, y: s.y, r: KINDS[s.kind].light * CELL });
  }
  return out;
}

/* ---------------- placement ---------------- */
function canPlace(kind, gx, gy) {
  const k = KINDS[kind];
  if (gx < 1 || gy < 1 || gx + k.size > COLS - 1 || gy + k.size > ROWS - 1) return 'Off the map';
  for (let y = gy; y < gy + k.size; y++) for (let x = gx; x < gx + k.size; x++) if (occ[y * COLS + x]) return 'Something is already there';
  const cx = (gx + k.size / 2) * CELL, cy = (gy + k.size / 2) * CELL;
  if (!lights().some((l) => Math.hypot(l.x - cx, l.y - cy) <= l.r)) return 'Outside the lit area: build near the Command Center or a connected building';
  if (kind === 'feature' && !parentApp(gx, gy)) return 'A Feature must touch a shipped App';
  if (k.bp && S.blueprints < k.bp) return 'Needs ' + k.bp + ' Blueprint' + (k.bp > 1 ? 's' : '') + ' (sort loose ideas at the Refinery)';
  if (S.credits + 1e-9 < k.cost) return 'Over today\'s budget: refills at 08:00';
  return '';
}
function parentApp(gx, gy) {
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const x = gx + dx, y = gy + dy; if (x < 0 || y < 0 || x >= COLS || y >= ROWS) continue;
    const s = byId(occ[y * COLS + x]); if (s && s.kind === 'app' && s.phase === 'shipped') return s;
  }
  return null;
}
function place(kind, gx, gy) {
  const why = canPlace(kind, gx, gy); if (why) { toast(why, 'bad'); return null; }
  const k = KINDS[kind];
  spend(k.cost, 'build ' + kind);
  if (k.bp) S.blueprints -= k.bp;
  const s = addStruct(kind, gx, gy);
  if (kind === 'feature') { const p = parentApp(gx, gy); s.parent = p.id; s.name = 'Feature of ' + p.name; S.conduits.push({ a: p.id, b: s.id }); }
  if (k.project) { S.stats.projects++; log((kind === 'app' ? 'Placed ' + s.name + ' (App): a new project. ' : 'Placed a Feature: a new ticket on ' + byId(s.parent).name + '. ') + money(k.cost) + ' held for its build run.', ''); }
  else log('Building a ' + k.name + ' (' + money(k.cost) + ').', '');
  S.netDirty = true;
  return s;
}
function connect(a, b) {
  if (a === b) return 'Pick a different building';
  if (S.conduits.some((c) => (c.a === a.id && c.b === b.id) || (c.a === b.id && c.b === a.id))) return 'Already connected';
  if (dist(a, b) > 9.5 * CELL) return 'Too far: conduits reach about 9 squares';
  S.conduits.push({ a: a.id, b: b.id }); S.netDirty = true;
  log('Connected ' + a.name + ' and ' + b.name + ' (a dependency between them).', '');
  return '';
}

/* ---------------- simulation ---------------- */
function update(dt) {
  S.t += dt;
  const prevClock = S.clock;
  S.clock += dt * 3600 / GAME_HOUR;
  if (S.clock >= 24 * 3600) { S.clock -= 24 * 3600; S.day++; }
  if (prevClock < 8 * 3600 && S.clock >= 8 * 3600 || (S.clock < prevClock && S.clock >= 8 * 3600)) {
    S.credits = CAP; log('08:00, day ' + S.day + ': budget refilled to ' + money(CAP) + '.', 'g'); toast('Morning: budget refilled to ' + money(CAP));
  }
  if (S.netDirty) recomputeNet();

  // loose ideas drift in from the edges
  S.sigT -= dt;
  if (S.sigT <= 0) { S.sigT = rnd(6, 9); if (S.signals.length < 12) spawnSignal(false); }

  updateStructs(dt);
  updateTraining(dt);
  updateUnits(dt);
  updateBugs(dt);
  for (const sh of S.shots) sh.t += dt; S.shots = S.shots.filter((sh) => sh.t < 0.18);
  for (const f of S.floats) { f.t += dt; f.y -= dt * 18; } S.floats = S.floats.filter((f) => f.t < 1.8);
  checkMissions();
}

function updateStructs(dt) {
  for (const s of S.structs) {
    if (s.flash > 0) s.flash = Math.max(0, s.flash - dt);
    const k = KINDS[s.kind];
    // self-building facilities (setup, not agent runs) need a connection to progress
    if (s.state === 'building' && !k.project) {
      if (!s.linked) continue;
      s.prog += dt / k.build;
      if (s.prog >= 1) { s.prog = 1; s.state = 'online'; s.flash = 1; S.netDirty = true; log(k.name + ' is online.', 'g'); floatText(s.x, s.y - s.r, k.name + ' online', COL.green); }
      continue;
    }
    if (s.state === 'online' && s.integ < 100 && !S.bugs.some((b) => b.att === s.id)) s.integ = Math.min(100, s.integ + dt * 0.8);
    if (s.kind === 'refinery' && s.online && s.queue > 0 && S.blueprints < BP_CAP) {
      s.work += dt * (S.research.autosort ? 2 : 1);
      if (s.work >= 7) { s.work = 0; s.queue--; S.blueprints++; S.data++; S.stats.refined++; floatText(s.x, s.y - s.r, '+1 blueprint', COL.teal); log('Refinery sorted an idea into a ticket (+1 Blueprint, +1 Data).', ''); }
    }
    if (s.kind === 'turret' && s.online) {
      s.cool -= dt;
      const range = 150 * (countOnline('dock') ? 1.4 : 1);
      const b = nearest(S.bugs, s, range);
      if (b) { s.aim = Math.atan2(b.y - s.y, b.x - s.x); if (s.cool <= 0) { s.cool = 0.8; hitBug(b, 9, s); S.shots.push({ x1: s.x, y1: s.y, x2: b.x, y2: b.y, t: 0, c: COL.teal }); } }
    }
    if (s.kind === 'app') updateApp(s, dt);
    if (s.kind === 'feature' && s.phase === 'build' && s.state === 'building' && s.prog >= 1) {
      s.state = 'online'; s.phase = 'shipped'; s.flash = 1; S.netDirty = true; S.stats.features++;
      const p = byId(s.parent); log('Feature shipped on ' + (p ? p.name : 'an app') + ': its data output is up 50%.', 'g');
      floatText(s.x, s.y - 20, 'Feature shipped', COL.green); gainRenown(10, 'feature', s.x, s.y);
    }
  }
  // research
  if (S.researching) {
    const arc = S.structs.find((s) => s.kind === 'archive' && s.online);
    if (arc && !S.beacons.some((b) => b.type === 'rift')) {
      S.researching.t += dt;
      if (S.researching.t >= 10) { S.research[S.researching.id] = true; log('Research done: ' + RESEARCH[S.researching.id].name + ' (a new project rule).', 'g'); toast('Research done: <b>' + RESEARCH[S.researching.id].name + '</b>', 'big'); S.researching = null; selDirty = true; }
    }
  }
  // rifts: rule conflicts appear once the Archive exists
  if (countOnline('archive')) {
    S.riftT -= dt;
    if (S.riftT <= 0 && !S.beacons.some((b) => b.type === 'rift')) {
      S.riftT = rnd(110, 150);
      const arc = S.structs.find((s) => s.kind === 'archive');
      const pair = pick(RIFTS);
      addBeacon({ type: 'rift', sid: arc.id, title: 'Two project rules conflict', a: pair[0], b: pair[1] });
      log('Rule conflict in the Archive: research is blocked until you pick one.', 'a');
    }
  }
}

function updateApp(s, dt) {
  // phases: spec -> gate (your OK) -> build -> test -> wave -> shipped
  const work = workRate(s);
  if (s.phase === 'spec' || s.phase === 'build' || s.phase === 'test') {
    if (!s.linked) return;
    const len = { spec: 20, build: 36, test: 16 }[s.phase];
    s.prog += dt * work / len;
    if (s.phase === 'test' && !s.testBug && s.prog > 0.45) { s.testBug = true; spawnBug(s, false); log('Testing ' + s.name + ' found a bug.', 'b'); }
    if (s.prog >= 1) {
      s.prog = 0;
      if (s.phase === 'spec') { s.phase = 'gate'; addBeacon({ type: 'plan', sid: s.id, title: s.name, body: s.plan }); log(s.name + ': plan is ready. Your OK is needed before building.', 'a'); toast('<b>' + s.name + '</b>: plan ready for your OK', '', 2600); }
      else if (s.phase === 'build') { s.phase = 'test'; log(s.name + ': built. Testing now.', ''); }
      else if (s.phase === 'test') {
        s.phase = 'wave'; S.waveNo++; s.waveIdx = S.waveNo;
        const judged = S.units.some((u) => u.type === 'judge' && u.task === 'review' && u.target === s.id);
        let n = 7 + (S.waveNo - 1) * 8;
        if (judged) { n = Math.round(n * 0.6); spend(0.15, 'review'); log('A Judge reviewed ' + s.name + ': its release wave is 40% smaller.', 'v'); }
        if (S.research.lint) n = Math.max(3, n - 2);
        s.wave = { n, left: n, spawned: 0, t: countOnline('dock') ? 14 : 9, every: 0.55, min: s.integ, ids: new Set() };
        const wa = rnd(0, Math.PI * 2), wd = rnd(520, 640);
        s.wave.from = [clamp(s.x + Math.cos(wa) * wd, 40, W - 40), clamp(s.y + Math.sin(wa) * wd, 40, H - 40)];
        log('Release wave incoming for ' + s.name + ': ' + n + ' edge cases. Hold it above 70%.', 'b');
        toast('<b>Release wave</b> for ' + s.name + ' in ' + Math.round(s.wave.t) + 's', 'bad', 3400);
      }
    }
  }
  if (s.phase === 'wave') {
    const w = s.wave;
    if (w.t > 0) { w.t -= dt; return; }
    w.every -= dt;
    if (w.spawned < w.n && w.every <= 0) {
      w.every = 0.55; w.spawned++;
      const b = spawnBugAt(w.from[0] + rnd(-60, 60), w.from[1] + rnd(-60, 60), true, s.id);
      w.ids.add(b.id);
    }
    w.min = Math.min(w.min, s.integ);
    if (w.spawned >= w.n && ![...w.ids].some((id) => S.bugs.some((b) => b.id === id))) {
      S.stats.waves++;
      const clean = w.min > 70;
      if (clean) S.stats.cleanWaves++;
      gainRenown(15, 'wave', s.x, s.y);
      log('Wave survived for ' + s.name + ' (lowest integrity ' + Math.round(w.min) + '%).', clean ? 'g' : 'a');
      s.wave = null;
      if (s.state === 'breached') { s.phase = 'repairs'; log(s.name + ' is breached: a Warden must repair it before it can ship.', 'b'); }
      else shipApp(s);
    }
  }
  if (s.phase === 'repairs' && s.state === 'online') shipApp(s);
  if (s.phase === 'shipped' && s.online) {
    const feats = S.structs.filter((f) => f.kind === 'feature' && f.parent === s.id && f.online).length;
    s.dataT += dt * (1 + 0.5 * feats);
    if (s.dataT >= 8) { s.dataT = 0; S.data++; floatText(s.x, s.y - s.r, '+1 data', COL.ink2); }
    s.spawnT -= dt;
    if (s.spawnT <= 0) { s.spawnT = rnd(30, 46) * (S.research.lint ? 1.6 : 1); spawnBug(s, false); log('A bug report came in for ' + s.name + '.', 'b'); }
  }
}
function shipApp(s) {
  s.phase = 'shipped'; s.state = 'online'; s.flash = 1.4; S.stats.shipped++; S.netDirty = true;
  log(s.name + ' shipped. It runs, has a UI, and earns Data.', 'g');
  toast('<b>' + s.name + '</b> shipped', 'big', 3200);
  floatText(s.x, s.y - s.r - 10, s.name + ' shipped', COL.green);
  gainRenown(30, 'ship', s.x, s.y);
}
function workRate(s) {
  const ws = S.units.filter((u) => u.type === 'constructor' && u.task === 'build' && u.target === s.id && u.state === 'working' && u.powered);
  let r = 0; ws.forEach((u, i) => { r += (i === 0 ? 1 : 0.6) * unitBonus(u); });
  if (S.research.fastbuild) r *= 1.5;
  s.workers = ws.length;
  return r;
}
const unitBonus = (u) => (u.xp >= 15 ? 1.4 : u.xp >= 5 ? 1.2 : 1);
const unitRank = (u) => (u.xp >= 15 ? 'Elite' : u.xp >= 5 ? 'Veteran' : 'Recruit');

function updateTraining(dt) {
  if (!S.trainQ.length) return;
  const bar = S.structs.find((s) => s.kind === 'barracks' && s.online);
  if (!bar) return;
  const q = S.trainQ[0]; q.t += dt;
  if (q.t >= UNITS[q.type].train) {
    S.trainQ.shift();
    const u = addUnit(q.type, bar.x + rnd(-10, 10), bar.y + bar.r + 14);
    S.stats.trained[q.type]++;
    log(UNITS[q.type].name + ' ready (an agent on ' + UNITS[q.type].model + ').', 'v');
    floatText(u.x, u.y - 14, UNITS[q.type].name + ' ready', COL.violet);
  }
}
function train(type) {
  const k = UNITS[type];
  if (S.rankI < k.rank) { toast(k.name + ' unlocks at ' + RANKS[k.rank].n, 'bad'); return; }
  if (!S.structs.some((s) => s.kind === 'barracks')) { toast('Build a Barracks first (B)', 'bad'); return; }
  const p = power();
  if (p.used + k.power > p.cap) { toast('No free agent slots: build a Reactor (E)', 'bad'); return; }
  S.trainQ.push({ type, t: 0 });
  renderTrainBar();
}

function updateUnits(dt) {
  // slots: if power drops, the newest agents wait
  const p = power(); let used = 0;
  for (const u of S.units) { used += UNITS[u.type].power; u.powered = used <= p.cap; }
  for (const u of S.units) {
    u.cool -= dt;
    if (!u.powered) { u.state = 'waiting'; continue; }
    if (u.order) runOrder(u, dt); else runAuto(u, dt);
  }
}
function moveTo(u, x, y, dt, near) {
  const d = Math.hypot(x - u.x, y - u.y);
  if (d <= (near || 4)) return true;
  const sp = UNITS[u.type].speed * unitBonus(u) * dt;
  u.face = Math.atan2(y - u.y, x - u.x);
  u.x += (x - u.x) / d * Math.min(sp, d); u.y += (y - u.y) / d * Math.min(sp, d);
  u.state = 'moving';
  return Math.hypot(x - u.x, y - u.y) <= (near || 4);
}
function nearest(list, from, max, filt) {
  let best = null, bd = max || 1e9;
  for (const o of list) { if (filt && !filt(o)) continue; const d = dist(o, from); if (d < bd) { bd = d; best = o; } }
  return best;
}
function homeSpot(u) {
  const hq = S.structs[0], i = S.units.indexOf(u);
  const a = i * 0.9 + 2.4;
  return { x: hq.x + Math.cos(a) * (hq.r + 40 + (i % 3) * 16), y: hq.y + Math.sin(a) * (hq.r + 40 + (i % 3) * 16) };
}
function idle(u, dt) { const h = homeSpot(u); u.task = null; u.target = null; if (moveTo(u, h.x, h.y, dt, 6)) u.state = 'idle'; }

function runAuto(u, dt) {
  if (u.holdT > 0) { u.holdT -= dt; if (u.type === 'warden') wardenFight(u, dt, 160); else u.state = 'idle'; return; }
  if (u.type === 'scout') return scoutAuto(u, dt);
  if (u.type === 'constructor') return constructorAuto(u, dt);
  if (u.type === 'warden') return wardenAuto(u, dt);
  if (u.type === 'judge') return judgeAuto(u, dt);
}
function scoutAuto(u, dt) {
  if (u.carry) {
    const ref = nearest(S.structs, u, 1e9, (s) => s.kind === 'refinery' && s.online);
    if (!ref) { idle(u, dt); u.task = 'holding'; return; }
    u.task = 'deliver'; u.target = ref.id;
    if (moveTo(u, ref.x, ref.y, dt, ref.r + 6)) deliver(u, ref);
    return;
  }
  if (S.blueprints >= BP_CAP && !u.order) { u.task = 'store full'; return idle(u, dt), void (u.task = 'store full'); }
  let g = u.target && S.signals.find((x) => x.id === u.target && x.claimed === u.id);
  if (!g) { g = nearest(S.signals, u, 1e9, (x) => !x.claimed); if (g) { g.claimed = u.id; u.target = g.id; } }
  if (!g) return idle(u, dt);
  u.task = 'fetch';
  if (moveTo(u, g.x, g.y, dt, 6)) pickUp(u, g);
}
function pickUp(u, g) { u.carry = g.text; S.signals = S.signals.filter((x) => x !== g); u.target = null; }
function deliver(u, ref) {
  if (!spend(0.01, 'carry')) { u.state = 'idle'; u.task = 'no budget'; return; }
  ref.queue++; S.stats.carried++; u.xp++;
  log('Scout brought "' + u.carry + '" to the Refinery.', 'v');
  u.carry = null; u.target = null;
}
function constructorAuto(u, dt) {
  let s = u.target && byId(u.target);
  const needs = (x) => x && KINDS[x.kind]?.project && x.linked && ((x.kind === 'app' && ['spec', 'build', 'test'].includes(x.phase)) || (x.kind === 'feature' && x.state === 'building'));
  if (!needs(s)) {
    const sites = S.structs.filter(needs);
    if (!sites.length) return idle(u, dt);
    const cnt = (x) => S.units.filter((v) => v !== u && v.type === 'constructor' && v.target === x.id).length;
    sites.sort((a, b) => cnt(a) - cnt(b) || dist(a, u) - dist(b, u));
    s = sites[0]; u.target = s.id;
  }
  u.task = 'build';
  buildAt(u, s, dt);
}
function buildAt(u, s, dt) {
  const i = S.units.filter((v) => v.target === s.id && v.type === 'constructor').indexOf(u);
  const a = (i * 1.3) + 0.6, rr = s.r + 12;
  if (moveTo(u, s.x + Math.cos(a) * rr, s.y + Math.sin(a) * rr, dt, 5)) {
    u.state = 'working'; u.face = Math.atan2(s.y - u.y, s.x - u.x);
    if (s.kind === 'feature') { s.prog += dt * unitBonus(u) * (S.research.fastbuild ? 1.5 : 1) / 8; if (s.prog >= 1) u.xp++; }
    u.work += dt; if (u.work > 12) { u.work = 0; u.xp++; }
  }
}
function wardenAuto(u, dt) {
  if (wardenFight(u, dt, 520)) return;
  const br = nearest(S.structs, u, 1e9, (s) => s.state === 'breached');
  if (br) { u.task = 'repair'; return repairAt(u, br, dt); }
  u.task = null; idle(u, dt);
}
function wardenFight(u, dt, reach) {
  // defend: nearest bug close to any building, or close to me
  let b = u.target && S.bugs.find((x) => x.id === u.target);
  if (!b) b = nearest(S.bugs, u, reach);
  if (!b) { if (u.task === 'fight') { u.task = null; u.target = null; } return false; }
  u.task = 'fight'; u.target = b.id;
  if (dist(u, b) > 105) moveTo(u, b.x, b.y, dt, 100);
  else {
    u.state = 'fighting'; u.face = Math.atan2(b.y - u.y, b.x - u.x);
    if (u.cool <= 0) { u.cool = 0.65 / unitBonus(u); hitBug(b, 12, u); S.shots.push({ x1: u.x, y1: u.y, x2: b.x, y2: b.y, t: 0, c: COL.violet }); }
  }
  return true;
}
function repairAt(u, s, dt) {
  if (moveTo(u, s.x, s.y, dt, s.r + 10)) {
    u.state = 'working'; u.work += dt;
    if (u.work >= 4) {
      u.work = 0;
      if (!spend(0.10, 'repair')) { u.task = 'no budget'; return; }
      s.state = 'online'; s.integ = 60; s.flash = 1; S.netDirty = true; S.stats.repairs++; u.xp++;
      log('Warden repaired ' + s.name + ' (a fix run).', 'g'); gainRenown(3, 'repair', s.x, s.y);
      u.target = null; u.order = null;
    }
  }
}
function judgeAuto(u, dt) {
  const s = nearest(S.structs, u, 1e9, (x) => x.kind === 'app' && x.phase === 'test');
  if (!s) return idle(u, dt);
  u.task = 'review'; u.target = s.id;
  if (moveTo(u, s.x - s.r - 14, s.y - s.r - 6, dt, 5)) u.state = 'working';
}
function runOrder(u, dt) {
  const o = u.order;
  if (o.type === 'move') { if (moveTo(u, o.x, o.y, dt, 5)) { u.order = null; u.holdT = 10; u.state = 'idle'; } return; }
  if (o.type === 'carry') {
    if (u.type !== 'scout') { u.order = null; return; }
    const g = S.signals.find((x) => x.id === o.id);
    if (!g || u.carry) { u.order = null; return; }
    S.signals.forEach((x) => { if (x.claimed === u.id && x !== g) x.claimed = 0; });
    g.claimed = u.id; u.target = g.id; u.order = null; return;
  }
  if (o.type === 'attack') {
    const b = S.bugs.find((x) => x.id === o.id);
    if (!b || u.type !== 'warden') { u.order = null; return; }
    u.target = b.id; if (!wardenFight(u, dt, 99999)) u.order = null; return;
  }
  if (o.type === 'build') {
    const s = byId(o.id);
    if (!s || u.type !== 'constructor') { u.order = null; return; }
    u.target = s.id; u.order = null; return;
  }
  if (o.type === 'repair') {
    const s = byId(o.id);
    if (!s || s.state !== 'breached' || u.type !== 'warden') { u.order = null; return; }
    u.task = 'repair'; repairAt(u, s, dt); return;
  }
  u.order = null;
}

/* bugs: real bug tickets. They grow if left alone and crawl along conduits. */
function spawnBug(s, wave) { const a = rnd(0, Math.PI * 2); return spawnBugAt(s.x + Math.cos(a) * (s.r + 18), s.y + Math.sin(a) * (s.r + 18), wave, s.id, s.name); }
function spawnBugAt(x, y, wave, target, from) {
  const hp = wave ? 24 + S.waveNo * 6 : 22;
  const b = { id: S.nextId++, x, y, hp, max: hp, wave, target, att: 0, ph: rnd(0, 6), speed: wave ? rnd(36, 44) : rnd(18, 24), from: from || 'a release test', age: 0 };
  S.bugs.push(b); return b;
}
function hitBug(b, dmg, by) {
  b.hp -= dmg;
  if (b.hp <= 0 && S.bugs.includes(b)) {
    S.bugs = S.bugs.filter((x) => x !== b);
    S.stats.bugs++;
    if (by && by.type === 'warden') { by.xp++; if (!spend(0.03, 'fix')) by.task = 'no budget'; }
    floatText(b.x, b.y, 'fixed', COL.green);
    gainRenown(2, 'bug', b.x, b.y);
    if (by && by.target === b.id) { by.target = null; if (by.order) by.order = null; }
  }
}
function updateBugs(dt) {
  for (const b of S.bugs) {
    b.ph += dt * 8; b.age += dt;
    if (!b.wave && b.max < 60) { b.max += dt * 0.6; b.hp += dt * 0.6; }
    let t = byId(b.target);
    if (!t || !t.x || t.kind === undefined || t.state === 'breached') {
      // crawl along a conduit to a neighbour, else to the nearest building
      const from = t && t.kind ? t : null;
      let next = null;
      if (from) {
        const ns = S.conduits.filter((c) => c.a === from.id || c.b === from.id).map((c) => byId(c.a === from.id ? c.b : c.a)).filter((n) => n && n.state !== 'breached');
        next = ns.length ? pick(ns) : null;
      }
      if (!next) next = nearest(S.structs, b, 1e9, (s) => s.state !== 'breached');
      if (!next) continue;
      b.target = next.id; t = next;
    }
    const d = dist(b, t);
    if (d > t.r + 4) { b.att = 0; b.x += (t.x - b.x) / d * b.speed * dt; b.y += (t.y - b.y) / d * b.speed * dt; }
    else {
      b.att = t.id;
      t.integ -= dt * (b.wave ? 5 : 3.5) * (b.max / 30);
      if (t.integ <= 0) {
        t.integ = 0; t.state = 'breached'; S.netDirty = true; t.flash = 1;
        log(t.name + ' is breached (like a failed build). It stops until a Warden repairs it.', 'b');
        toast('<b>' + t.name + '</b> breached', 'bad');
      }
    }
  }
}

/* beacons: decisions only you can make */
function addBeacon(b) { b.id = S.nextId++; S.beacons.push(b); gateDirty = true; }
function decide(b, choice, note) {
  S.beacons = S.beacons.filter((x) => x !== b); gateDirty = true;
  const s = byId(b.sid);
  if (b.type === 'plan' && s) {
    if (choice === 'approve') { s.phase = 'build'; s.prog = 0; S.approvals++; log('Your OK on the plan for ' + s.name + '. Building.', 'g'); }
    else { s.phase = 'spec'; s.prog = 0.6; S.sendBacks++; log('Sent the plan for ' + s.name + ' back' + (note ? ': "' + note + '"' : '') + '. The spec gets another pass.', 'a'); }
  }
  if (b.type === 'rift') { log('Rule kept: "' + (choice === 'a' ? b.a : b.b) + '". Research unblocked.', 'g'); gainRenown(3, 'rift', s.x, s.y); }
}

function checkMissions() {
  for (const m of MISSIONS) {
    if (S.done.has(m.id)) continue;
    const [v, n] = m.p();
    if (v >= n) {
      S.done.add(m.id);
      log('Mission done: ' + m.t + '.', 'g');
      toast('Mission done: <b>' + m.t + '</b> (+' + m.r + ' renown)', 'big', 3200);
      gainRenown(m.r, 'mission');
      if (S.done.size === MISSIONS.length && !S.won) { S.won = true; setTimeout(showEnd, 1600); }
    }
  }
}


// Draws the build list as one page: node scripts/build-loop/picture.mjs <out.html>. See docs/build-loop.md.
import { readFileSync, writeFileSync } from "node:fs";
const list = JSON.parse(readFileSync(new URL("../../build/pieces.json", import.meta.url), "utf8"));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const all = list.steps.flatMap((s) => s.pieces);
const n = (st) => all.filter((p) => p.status === st).length;
const WORD = { proven: "proven on a real ticket", built: "built, proof owed", now: "in work now", next: "next", later: "later", parked: "parked" };
const LOOP = [["Pick", "the one piece in work"], ["Say it", "a few lines: what, and how it is checked"], ["Build", "tests first, settings, create-edit-delete"], ["Check", "types, tests, the feature map"], ["Second eyes", "a reviewer that did not write it"], ["Fix", "at most three rounds"], ["Wire", "reachable in the installed app"], ["Prove", "on a real product, on the laptop"], ["Mark", "next piece becomes the one in work"]];
const piece = (p) => `<li class="p ${p.status}"><span class="dot"></span><span class="pt">${esc(p.title)}${p.status === "now" ? '<em class="here">you are here</em>' : ""}</span><small>${esc(p.status === "later" || p.status === "next" ? p.done : WORD[p.status] + ". " + p.done)}</small></li>`;
const step = (s) => { const d = s.pieces.filter((p) => p.status === "proven" || p.status === "built").length; const live = s.pieces.some((p) => p.status === "now"); return `<section class="step${live ? " live" : ""}"><div class="sh"><span class="num">${s.n}</span><div><h2>${esc(s.title)}</h2><p>${esc(s.line)}</p></div><span class="cnt">${d} of ${s.pieces.length}</span></div><ul>${s.pieces.map(piece).join("")}</ul></section>`; };
const html = `<title>SF Build Map</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Space+Grotesk:wght@500;700&display=swap">
<style>
:root{--bg:#f6f5f1;--panel:#fff;--ink:#1c1b18;--mute:#6b675e;--line:#dcd8cd;--ok:#1f7a4d;--ok-soft:#e3f2e9;--built:#2f5fb3;--built-soft:#e4ecfa;--now:#c2410c;--now-soft:#fdebdd}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#161512;--panel:#201f1b;--ink:#f1eee6;--mute:#a59f92;--line:#3a372f;--ok:#5fc08d;--ok-soft:#1b2d23;--built:#8fb0ee;--built-soft:#1c2637;--now:#f59052;--now-soft:#3a2416;color-scheme:dark}}
:root[data-theme="dark"]{--bg:#161512;--panel:#201f1b;--ink:#f1eee6;--mute:#a59f92;--line:#3a372f;--ok:#5fc08d;--ok-soft:#1b2d23;--built:#8fb0ee;--built-soft:#1c2637;--now:#f59052;--now-soft:#3a2416;color-scheme:dark}
body{background:var(--bg);color:var(--ink);font:15px/1.45 Inter,system-ui,sans-serif}
.wrap{max-width:1040px;margin:0 auto;padding-block:28px 56px;padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px));display:flex;flex-direction:column;gap:22px}
h1,h2{font-family:"Space Grotesk",Inter,sans-serif;margin:0;text-wrap:balance}
h1{font-size:30px}h2{font-size:18px}
p{margin:0;color:var(--mute)}
.tot{display:flex;flex-wrap:wrap;gap:8px}
.tot span{background:var(--panel);border:1px solid var(--line);border-radius:999px;padding:5px 12px;font-weight:500}
.tot b{font-family:"Space Grotesk",sans-serif}
.loop{display:grid;grid-template-columns:repeat(9,minmax(0,1fr));gap:6px;list-style:none;margin:0;padding:0;counter-reset:l}
.loop li{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:9px 8px;min-width:0;counter-increment:l}
.loop li::before{content:counter(l);display:block;font:700 12px "Space Grotesk",sans-serif;color:var(--now)}
.loop b{display:block;font-size:13.5px}.loop small{color:var(--mute);font-size:12px;line-height:1.3;display:block}
@media (max-width:860px){.loop{grid-template-columns:repeat(3,minmax(0,1fr))}}
.step{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:16px}
.step.live{border-color:var(--now);border-width:2px}
.sh{display:flex;gap:12px;align-items:flex-start;margin-bottom:12px}
.sh>div{flex:1;min-width:0}
.num{font:700 22px "Space Grotesk",sans-serif;width:38px;height:38px;border-radius:10px;background:var(--bg);display:grid;place-items:center;flex:none}
.cnt{color:var(--mute);font-weight:500;white-space:nowrap}
ul{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:8px}
.p{border:1px solid var(--line);border-radius:10px;padding:9px 10px 9px 28px;position:relative;min-width:0}
.p .dot{position:absolute;left:10px;top:14px;width:9px;height:9px;border-radius:50%;border:2px solid var(--mute)}
.pt{display:block;font-weight:500}.p small{display:block;color:var(--mute);font-size:12.5px;margin-top:3px}
.p.proven{background:var(--ok-soft);border-color:var(--ok)}.p.proven .dot{background:var(--ok);border-color:var(--ok)}
.p.built{background:var(--built-soft);border-color:var(--built)}.p.built .dot{border-color:var(--built);background:linear-gradient(90deg,var(--built) 50%,transparent 50%)}
.p.now{background:var(--now-soft);border-color:var(--now);border-width:2px}.p.now .dot{background:var(--now);border-color:var(--now)}
.here{display:inline-block;margin-left:8px;font:700 11px "Space Grotesk",sans-serif;letter-spacing:.06em;text-transform:uppercase;color:var(--panel);background:var(--now);border-radius:999px;padding:2px 8px;font-style:normal;vertical-align:middle}
.rule{border-left:3px solid var(--now);padding:4px 0 4px 12px;color:var(--ink)}
</style>
<div class="wrap">
<header style="display:flex;flex-direction:column;gap:10px">
<h1>SoftwareFactory, the whole build on one page</h1>
<p>Every piece from the planning documents, in order. One piece is in work at a time. Each goes round the same loop.</p>
<div class="tot"><span><b>${all.length}</b> pieces</span><span><b>${n("proven")}</b> proven on a real ticket</span><span><b>${n("built")}</b> built, proof owed</span><span><b>1</b> in work now</span></div>
</header>
<ol class="loop">${LOOP.map(([a, b]) => `<li><b>${a}</b><small>${b}</small></li>`).join("")}</ol>
<p class="rule">A piece counts only when it worked on a real ticket of a real product. Work on SoftwareFactory itself never counts.</p>
${list.steps.map(step).join("\n")}
</div>`;
writeFileSync(process.argv[2] ?? "build-map.html", html);

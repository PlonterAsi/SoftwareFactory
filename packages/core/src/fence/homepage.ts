/**
 * The home screen's one page (build step 1, slice 3). Plain HTML, its own small script, nothing fetched from
 * anywhere else. Everything a run or a project wrote reaches the page as text and is set as text, never as HTML.
 * The script uses no template strings, so this file can hold it as one.
 */
export function homePage(key: string): string {
  if (!/^[A-Za-z0-9]+$/.test(key)) throw new Error("the page key must be plain letters and digits");
  return PAGE.replace("__SF_KEY__", key);
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>SoftwareFactory</title>
<style>
:root {
  --bg: #f6f5f1; --card: #ffffff; --ink: #1c1b18; --soft: #55524a; --line: #dedbd2;
  --accent: #1f5fbf; --accent-ink: #ffffff; --good: #1d6b43; --good-bg: #e3f1e8; --wait: #8a5a00; --wait-bg: #fbefd2;
  --bad: #a3271e; --bad-bg: #f9e2df; --calm-bg: #ebe9e2; --work-bg: #e1ebfa;
  --mono: ui-monospace, "Cascadia Mono", Consolas, "SF Mono", Menlo, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #161614; --card: #1f1f1c; --ink: #eceae3; --soft: #b3afa3; --line: #37362f;
    --accent: #7fb0ff; --accent-ink: #0d1b33; --good: #7fd3a2; --good-bg: #1c3527; --wait: #f0c466; --wait-bg: #3a2f12;
    --bad: #ff9c92; --bad-bg: #40201c; --calm-bg: #2a2925; --work-bg: #1b2a44;
  }
}
* { box-sizing: border-box; }
html { background: var(--bg); }
body { margin: 0; background: var(--bg); color: var(--ink); font: 16px/1.5 "Segoe UI", system-ui, -apple-system, sans-serif; }
main { max-width: 780px; margin: 0 auto; padding: 28px 16px 80px; }
header { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 14px; margin-bottom: 22px; }
h1 { font-size: 22px; margin: 0; letter-spacing: -0.01em; }
h2 { font-size: 15px; margin: 34px 0 10px; color: var(--soft); font-weight: 600; }
.where { color: var(--soft); font-size: 15px; overflow-wrap: anywhere; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 16px; }
label { display: block; font-weight: 600; margin-bottom: 6px; }
.hint { color: var(--soft); font-size: 14px; font-weight: 400; }
textarea, input, select { width: 100%; font: inherit; color: var(--ink); background: var(--bg); border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; }
textarea { min-height: 92px; resize: vertical; }
textarea:focus, input:focus, select:focus, button:focus-visible, summary:focus-visible, a:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
.row { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-top: 12px; }
button, a.btn { font: inherit; font-weight: 600; border-radius: 8px; padding: 9px 16px; border: 1px solid var(--line); background: var(--card); color: var(--ink); cursor: pointer; text-decoration: none; display: inline-block; }
button.main { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); }
button.good { background: var(--good); color: var(--card); border-color: var(--good); }
button.stop { background: var(--bad); color: var(--card); border-color: var(--bad); }
button:disabled { opacity: 0.55; cursor: default; }
.msg { font-size: 15px; color: var(--bad); min-height: 1.4em; margin: 8px 0 0; overflow-wrap: anywhere; }
.spoke { display: none; border-color: var(--wait); background: var(--wait-bg); margin-bottom: 14px; }
.spoke.on { display: block; }
.spoke p { margin: 0; overflow-wrap: anywhere; }
.spoke p + p { margin-top: 6px; }
.spoke small { color: var(--soft); }
.now { display: none; border-color: var(--accent); margin-top: 14px; }
.now.on { display: block; }
.now b { font-size: 17px; }
.live { font: 14px/1.5 var(--mono); color: var(--soft); margin: 8px 0 0; overflow-wrap: anywhere; }
.ticket { border-top: 1px solid var(--line); padding: 16px 0; }
.ticket:first-child { border-top: 0; padding-top: 4px; }
.top { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 10px; }
.name { font: 600 14px var(--mono); color: var(--soft); }
.chip { font-size: 13px; font-weight: 600; border-radius: 999px; padding: 2px 10px; background: var(--calm-bg); color: var(--ink); }
.chip.working { background: var(--work-bg); color: var(--accent); }
.chip.proposed { background: var(--wait-bg); color: var(--wait); }
.chip.accepted { background: var(--good-bg); color: var(--good); }
.chip.bad { background: var(--bad-bg); color: var(--bad); }
.sentence { margin: 8px 0 2px; font-size: 17px; overflow-wrap: anywhere; }
.says { margin: 0; color: var(--soft); font-size: 15px; overflow-wrap: anywhere; }
.meta { color: var(--soft); font-size: 14px; margin-left: auto; font-variant-numeric: tabular-nums; }
details { margin-top: 10px; }
summary { cursor: pointer; color: var(--soft); font-size: 14px; font-weight: 600; width: fit-content; border-radius: 6px; }
ol.story { list-style: none; margin: 8px 0 0; padding: 10px 12px; background: var(--bg); border: 1px solid var(--line); border-radius: 8px; font: 13.5px/1.55 var(--mono); max-height: 420px; overflow: auto; }
ol.story li { display: grid; grid-template-columns: 5.2em 6.2em 1fr; gap: 0 8px; }
ol.story .t, ol.story .w { color: var(--soft); }
ol.story .x { overflow-wrap: anywhere; min-width: 0; }
ol.story li.flag .x { color: var(--bad); }
.empty { color: var(--soft); margin: 0; }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.grid .wide { grid-column: 1 / -1; }
.fence { color: var(--soft); font-size: 14px; margin: 14px 0 0; overflow-wrap: anywhere; }
@media (max-width: 560px) { .grid { grid-template-columns: 1fr; } ol.story li { grid-template-columns: 4.6em 1fr; } ol.story .w { display: none; } .meta { margin-left: 0; width: 100%; } }
@media (prefers-reduced-motion: no-preference) { .chip.working::before { content: ""; display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: currentColor; margin-right: 6px; animation: pulse 1.4s ease-in-out infinite; } @keyframes pulse { 50% { opacity: 0.25; } } }
</style>
</head>
<body>
<main>
  <header>
    <h1>SoftwareFactory</h1>
    <span class="where" id="where"></span>
  </header>

  <section class="card spoke" id="spoke" aria-live="polite"></section>

  <section class="card" aria-labelledby="ask-label">
    <label id="ask-label" for="sentence">What should be done? <span class="hint">One ticket, in your own words.</span></label>
    <textarea id="sentence" maxlength="4000"></textarea>
    <div class="row">
      <button class="main" id="start" type="button">Start the run</button>
      <span class="hint" id="start-hint"></span>
    </div>
    <p class="msg" id="ask-msg" role="alert"></p>
  </section>

  <section class="card now" id="now" aria-live="polite">
    <div class="top">
      <b id="now-title">A run is working</b>
      <span class="meta" id="now-time"></span>
    </div>
    <p class="live" id="now-line"></p>
    <div class="row"><button class="stop" id="stop" type="button">Stop</button><span class="hint">Ends everything the run started, inside the room.</span></div>
  </section>

  <h2 id="tickets-title">Tickets</h2>
  <section class="card" aria-labelledby="tickets-title"><div id="tickets"><p class="empty">No tickets yet. Your first sentence starts one.</p></div></section>

  <h2 id="settings-title">Settings</h2>
  <section class="card" aria-labelledby="settings-title">
    <div class="grid">
      <div class="wide"><label for="s-repo">Project on GitHub <span class="hint">owner/name</span></label><input id="s-repo" autocomplete="off" spellcheck="false"></div>
      <div><label for="s-base">Start from branch <span class="hint">empty: the project's main one</span></label><input id="s-base" autocomplete="off" spellcheck="false"></div>
      <div><label for="s-model">Model</label><input id="s-model" autocomplete="off" spellcheck="false"></div>
      <div><label for="s-turns">Most turns in a run</label><input id="s-turns" type="number" min="1" max="500"></div>
      <div><label for="s-minutes">Time limit, minutes</label><input id="s-minutes" type="number" min="1" max="600"></div>
      <div><label for="s-stuck">Call a run silent after, minutes</label><input id="s-stuck" type="number" min="1" max="240"></div>
      <div><label for="s-phone">Lines to your phone</label><select id="s-phone"><option value="none">None, the home screen only</option><option value="ntfy">The ntfy app</option></select></div>
      <div class="wide"><label for="s-topic">ntfy channel name <span class="hint">16 or more letters and digits; whoever knows it can read the lines</span></label><input id="s-topic" autocomplete="off" spellcheck="false"></div>
      <div class="wide"><label for="s-prepare">The run does these first <span class="hint">one per line; they fetch what the checks need</span></label><textarea id="s-prepare" spellcheck="false"></textarea></div>
      <div class="wide"><label for="s-checks">Checks SoftwareFactory runs on the result <span class="hint">one per line, in this order, without network</span></label><textarea id="s-checks" spellcheck="false"></textarea></div>
    </div>
    <div class="row"><button id="save" type="button">Save settings</button><button id="phone-test" type="button">Send a test line to the phone</button><span class="hint" id="save-hint"></span></div>
    <p class="msg" id="set-msg" role="alert"></p>
    <p class="fence" id="fence"></p>
  </section>
</main>
<script>
(function () {
  "use strict";
  var KEY = "__SF_KEY__";
  var $ = function (id) { return document.getElementById(id); };
  var open = {}, nodes = {}, drawn = null, confirming = null, settingsLoaded = false, last = null, busy = false;

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
  function clock(iso) { var d = new Date(iso); return isNaN(d) ? "" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }); }
  function day(iso) { var d = new Date(iso); return isNaN(d) ? "" : d.toLocaleDateString([], { day: "numeric", month: "short" }) + ", " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }); }
  function money(n) { return "$" + Number(n || 0).toFixed(2); }
  function lines(v) { return String(v || "").split(/\\r?\\n/).map(function (x) { return x.trim(); }).filter(Boolean); }
  var CHIP = { working: ["Working", "working"], proposed: ["Waiting for you", "proposed"], accepted: ["Accepted", "accepted"], undone: ["Undone", ""], held: ["Held here", "proposed"], passed: ["Passed", ""], "failed its checks": ["Failed its checks", "bad"], parked: ["Parked", ""], stopped: ["Stopped", ""], crashed: ["Crashed", "bad"], "not started": ["Not started", "bad"], interrupted: ["Interrupted", ""] };

  function post(path, body) {
    return fetch(path, { method: "POST", headers: { "content-type": "application/json", "x-sf-key": KEY }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json().catch(function () { return { ok: false, why: "The answer could not be read." }; }); })
      .catch(function () { return { ok: false, why: "SoftwareFactory is not answering. Is it still open?" }; });
  }

  function ticketNode(t) {
    var box = el("article", "ticket");
    var top = el("div", "top");
    var chip = CHIP[t.state] || [t.state, ""];
    top.appendChild(el("span", "name", t.ticket));
    top.appendChild(el("span", "chip " + chip[1], chip[0]));
    top.appendChild(el("span", "meta", day(t.openedAt) + (t.costUsd ? "  ·  " + money(t.costUsd) : "")));
    box.appendChild(top);
    box.appendChild(el("p", "sentence", t.sentence));
    box.appendChild(el("p", "says", t.says));
    if (t.url || t.canAccept || t.canUndo) {
      var row = el("div", "row");
      if (t.canAccept) {
        if (confirming === t.ticket) {
          var yes = el("button", "good", "Yes, put it in the project");
          yes.type = "button";
          yes.onclick = function () { busy = true; yes.disabled = true; msg.textContent = ""; post("/api/step1/accept", { ticket: t.ticket }).then(function (r) { busy = false; confirming = null; if (!r.ok) { acceptError[t.ticket] = r.why; } else { delete acceptError[t.ticket]; } load(); }); };
          var no = el("button", "", "Not now");
          no.type = "button";
          no.onclick = function () { confirming = null; render(last); };
          // A second click of a double-click lands where Accept was: on "Not now". And Yes wakes up a moment later.
          yes.disabled = true;
          setTimeout(function () { yes.disabled = false; }, 800);
          setTimeout(function () { no.focus(); }, 0);
          row.appendChild(no); row.appendChild(yes);
          box.appendChild(el("p", "says", "SoftwareFactory's checks passed. " + (looked[t.ticket] || "") + " Accepting puts this change into the project."));
        } else {
          var acc = el("button", "good", "Accept");
          acc.type = "button";
          acc.onclick = function () {
            acc.disabled = true;
            post("/api/step1/look", { ticket: t.ticket }).then(function (r) { looked[t.ticket] = r.ok ? r.githubChecks : ""; if (!r.ok) acceptError[t.ticket] = r.why; confirming = r.ok ? t.ticket : null; render(last); });
          };
          row.appendChild(acc);
        }
      }
      if (t.canUndo) {
        if (confirming === "undo " + t.ticket) {
          var uyes = el("button", "stop", "Yes, take it back");
          uyes.type = "button";
          uyes.onclick = function () { busy = true; uyes.disabled = true; post("/api/step1/undo", { ticket: t.ticket }).then(function (r) { busy = false; confirming = null; if (!r.ok) { acceptError[t.ticket] = r.why; } else { delete acceptError[t.ticket]; } load(); }); };
          var uno = el("button", "", "Not now");
          uno.type = "button";
          uno.onclick = function () { confirming = null; render(last); };
          uyes.disabled = true;
          setTimeout(function () { uyes.disabled = false; }, 800);
          setTimeout(function () { uno.focus(); }, 0);
          row.appendChild(uno); row.appendChild(uyes);
          box.appendChild(el("p", "says", "Undo makes a new change that takes this one back and puts it into the project right away, without waiting for GitHub's own checks. Nothing is erased: the project's history keeps both."));
        } else {
          var und = el("button", "", "Undo");
          und.type = "button";
          und.onclick = function () { confirming = "undo " + t.ticket; render(last); };
          row.appendChild(und);
        }
      }
      if (t.url && /^https:\\/\\/github\\.com\\//.test(t.url)) { var a = el("a", "btn", "Open the proposal on GitHub"); a.href = t.url; a.target = "_blank"; a.rel = "noopener noreferrer"; row.appendChild(a); }
      box.appendChild(row);
    }
    var msg = el("p", "msg", acceptError[t.ticket] || "");
    msg.setAttribute("role", "alert");
    if (acceptError[t.ticket]) box.appendChild(msg);
    var det = el("details");
    det.open = !!open[t.ticket];
    det.ontoggle = function () { open[t.ticket] = det.open; };
    det.appendChild(el("summary", "", "The story, " + t.story.length + " lines"));
    var ol = el("ol", "story");
    t.story.forEach(function (s) {
      var li = el("li", s.flagged ? "flag" : "");
      li.appendChild(el("span", "t", clock(s.at))); li.appendChild(el("span", "w", s.who)); li.appendChild(el("span", "x", s.what));
      ol.appendChild(li);
    });
    det.appendChild(ol);
    box.appendChild(det);
    return box;
  }
  var acceptError = {}, looked = {};

  function render(s) {
    if (!s) return;
    last = s;
    $("where").textContent = s.settings.repo ? s.settings.repo : "No project chosen yet";
    var run = s.running;
    $("now").className = "card now" + (run ? " on" : "");
    $("start").disabled = !!run || !s.settings.repo;
    $("start-hint").textContent = run ? "One run at a time for now." : (s.settings.repo ? "" : "Choose the project in Settings first.");
    if (run) {
      var t = null; s.tickets.forEach(function (x) { if (x.ticket === run.ticket) t = x; });
      $("now-title").textContent = "Working on " + (run.ticket || "a new ticket");
      $("now-line").textContent = t && t.story.length ? t.story[t.story.length - 1].what : "Testing the fence first.";
      var secs = Math.max(0, Math.round((Date.now() - new Date(run.startedAt).getTime()) / 1000));
      $("now-time").textContent = Math.floor(secs / 60) + " min " + (secs % 60) + " s";
    }
    var sp = $("spoke");
    while (sp.firstChild) sp.removeChild(sp.firstChild);
    sp.className = "card spoke" + (s.spoke && s.spoke.length ? " on" : "");
    (s.spoke || []).forEach(function (w) { var p = el("p", "", w.line + " "); p.appendChild(el("small", "", day(w.at) + (w.phone === "sent" ? ", also sent to your phone" : ""))); sp.appendChild(p); });
    var list = $("tickets");
    if (!busy) {
      // Only a ticket that changed is drawn again, so an open story keeps its place and a focused button stays focused.
      var order = s.tickets.map(function (t) { return t.ticket; }).join(",");
      if (order !== drawn) {
        drawn = order; nodes = {};
        while (list.firstChild) list.removeChild(list.firstChild);
        if (!s.tickets.length) list.appendChild(el("p", "empty", "No tickets yet. Your first sentence starts one."));
      }
      s.tickets.forEach(function (t) {
        var sig = JSON.stringify(t) + "|" + (confirming === t.ticket || confirming === "undo " + t.ticket) + "|" + (acceptError[t.ticket] || "");
        var had = nodes[t.ticket];
        if (had && had.sig === sig) return;
        var fresh = ticketNode(t);
        if (had) {
          var story = had.node.querySelector("ol.story"), top = story ? story.scrollTop : 0;
          list.replaceChild(fresh, had.node);
          var again = fresh.querySelector("ol.story"); if (again) again.scrollTop = top;
        } else list.appendChild(fresh);
        nodes[t.ticket] = { sig: sig, node: fresh };
      });
    }
    if (!settingsLoaded) {
      settingsLoaded = true;
      $("s-repo").value = s.settings.repo; $("s-base").value = s.settings.base; $("s-model").value = s.settings.model;
      $("s-turns").value = s.settings.maxTurns; $("s-minutes").value = s.settings.timeLimitMinutes;
      $("s-stuck").value = s.settings.stuckMinutes; $("s-phone").value = s.settings.phone; $("s-topic").value = s.settings.ntfyTopic;
      $("s-prepare").value = s.settings.prepare.join("\\n"); $("s-checks").value = s.settings.checks.join("\\n");
    }
    $("fence").textContent = s.fence ? "The room is " + s.fence.room + ". A run may reach only: " + s.fence.netList.join(", ") + ". The fence is tested before every run." : "";
  }

  var pending = false, GONE = "SoftwareFactory is not answering. Is it still open?";
  function load() {
    if (pending) return; pending = true;
    fetch("/api/step1/state").then(function (r) { return r.json(); }).then(function (s) { pending = false; if ($("ask-msg").textContent === GONE) $("ask-msg").textContent = ""; render(s); }).catch(function () { pending = false; $("ask-msg").textContent = GONE; });
  }

  $("start").onclick = function () {
    var text = $("sentence").value;
    $("ask-msg").textContent = "";
    if (!text.trim()) { $("ask-msg").textContent = "Write what you want first."; $("sentence").focus(); return; }
    $("start").disabled = true;
    post("/api/step1/work", { sentence: text }).then(function (r) { if (r.ok) { $("sentence").value = ""; } else { $("ask-msg").textContent = r.why; $("start").disabled = false; } load(); });
  };
  $("stop").onclick = function () { $("stop").disabled = true; post("/api/step1/stop").then(function () { $("stop").disabled = false; load(); }); };
  $("save").onclick = function () {
    $("set-msg").textContent = ""; $("save-hint").textContent = "";
    post("/api/step1/settings", { repo: $("s-repo").value, base: $("s-base").value, model: $("s-model").value, maxTurns: Number($("s-turns").value), timeLimitMinutes: Number($("s-minutes").value), stuckMinutes: Number($("s-stuck").value), phone: $("s-phone").value, ntfyTopic: $("s-topic").value, prepare: lines($("s-prepare").value), checks: lines($("s-checks").value) })
      .then(function (r) { if (r.ok) { $("save-hint").textContent = "Saved."; settingsLoaded = false; load(); } else { $("set-msg").textContent = r.why; } });
  };

  $("phone-test").onclick = function () {
    $("set-msg").textContent = ""; $("save-hint").textContent = "";
    post("/api/step1/phone-test").then(function (r) { if (r.ok) { $("save-hint").textContent = "Sent. Look at your phone."; } else { $("set-msg").textContent = r.why; } });
  };

  load();
  try { var es = new EventSource("/api/step1/events"); es.onmessage = load; } catch (e) { /* the timer below still keeps the page fresh */ }
  // The clock of a working run ticks here; what the run did arrives by itself, and a slow look keeps the page honest.
  setInterval(function () { if (last && last.running) { var secs = Math.max(0, Math.round((Date.now() - new Date(last.running.startedAt).getTime()) / 1000)); $("now-time").textContent = Math.floor(secs / 60) + " min " + (secs % 60) + " s"; } }, 1000);
  setInterval(load, 10000);
})();
</script>
</body>
</html>
`;

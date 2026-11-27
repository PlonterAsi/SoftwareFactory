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
.row select { width: auto; min-height: 44px; }
.ticket textarea { margin-top: 8px; }
.ticket ul.done { margin: 2px 0 0; padding-left: 20px; color: var(--soft); }
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
details.settings { margin-top: 34px; }
details.settings > summary { font-size: 15px; width: auto; }
details.settings[open] > summary { margin-bottom: 14px; }
summary { cursor: pointer; color: var(--soft); font-size: 14px; font-weight: 600; width: fit-content; border-radius: 6px; }
details.road { margin: 10px 0 4px; }
details.road > summary { display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: center; cursor: pointer; list-style: none; padding: 4px 0; }
details.road > summary::-webkit-details-marker { display: none; }
details.road .chip { display: inline-flex; align-items: center; gap: 5px; font-size: 14px; color: var(--soft); }
details.road .chip .mk { width: 18px; height: 18px; border-radius: 50%; display: inline-grid; place-items: center; font-size: 11px; font-weight: 700; border: 2px solid var(--line); background: var(--card); }
details.road .chip.st-done { color: var(--ink); } details.road .chip.st-done .mk { background: var(--good-bg); border-color: var(--good); color: var(--good); }
details.road .chip.st-failed { color: var(--bad); font-weight: 600; } details.road .chip.st-failed .mk { background: var(--bad-bg); border-color: var(--bad); color: var(--bad); }
details.road .chip.st-now { color: var(--accent); font-weight: 600; } details.road .chip.st-now .mk { background: var(--work-bg); border-color: var(--accent); color: var(--accent); }
details.road .chip.st-skipped .mk { background: var(--wait-bg); border-color: var(--wait); color: var(--wait); }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
ol.steps { list-style: none; margin: 12px 0 4px; padding: 0; }
ol.steps > li { display: grid; grid-template-columns: 26px 1fr; gap: 0 10px; position: relative; padding-bottom: 10px; }
ol.steps > li:not(:last-child)::before { content: ""; position: absolute; left: 12px; top: 26px; bottom: 0; width: 2px; background: var(--line); }
ol.steps .mk { width: 26px; height: 26px; border-radius: 50%; display: grid; place-items: center; font-weight: 700; font-size: 14px; border: 2px solid var(--line); background: var(--card); color: var(--soft); }
ol.steps .st-done .mk { background: var(--good-bg); border-color: var(--good); color: var(--good); }
ol.steps .st-failed .mk { background: var(--bad-bg); border-color: var(--bad); color: var(--bad); }
ol.steps .st-now .mk { background: var(--work-bg); border-color: var(--accent); color: var(--accent); }
ol.steps .st-skipped .mk { background: var(--wait-bg); border-color: var(--wait); color: var(--wait); }
ol.steps .bd { min-width: 0; }
ol.steps p { margin: 0; overflow-wrap: anywhere; }
ol.steps .hd { line-height: 26px; }
ol.steps .hd .t { color: var(--soft); font-size: 13.5px; margin-left: 8px; }
ol.steps .pf { font-size: 15px; }
ol.steps .st-not-reached .hd, ol.steps .st-not-reached .pf { color: var(--soft); }
ol.steps .st-failed .pf { color: var(--bad); }
ol.steps .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
ol.steps details.facts { margin-top: 2px; font-size: 14px; }
ol.steps details.facts ul { margin: 4px 0 0; padding-left: 18px; color: var(--soft); overflow-wrap: anywhere; }
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
    <label id="ask-label" for="sentence">What should be done? <span class="hint">One ticket, in your own words. Add as many as you like: they are worked one after another.</span></label>
    <textarea id="sentence" maxlength="4000"></textarea>
    <div class="row">
      <button class="main" id="start" type="button">Add the ticket</button>
      <select id="kind" aria-label="Kind of ticket"><option value="request">Request</option><option value="bug">Bug</option><option value="task">Task</option><option value="idea">Idea</option><option value="plan">Plan</option><option value="question">Question</option></select>
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
  <div class="row" id="queue-row"><button id="hold" type="button">Hold the queue</button><span class="hint" id="queue-hint"></span><button id="show-removed" type="button" hidden></button><button id="issues-now" type="button" hidden>Look at GitHub now</button><span class="hint" id="issues-hint"></span></div>
  <section class="card" aria-labelledby="tickets-title"><div id="tickets"><p class="empty">No tickets yet. Your first sentence starts one.</p></div></section>

  <details class="card settings" id="settings">
    <summary id="settings-title">Settings <span class="hint" id="settings-hint"></span></summary>
    <div class="grid">
      <div class="wide"><label for="s-repo">Project on GitHub <span class="hint">owner/name</span></label><input id="s-repo" autocomplete="off" spellcheck="false"></div>
      <div><label for="s-base">Start from branch <span class="hint">empty: the project's main one</span></label><input id="s-base" autocomplete="off" spellcheck="false"></div>
      <div><label for="s-model">Model</label><input id="s-model" autocomplete="off" spellcheck="false"></div>
      <div><label for="s-turns">Most turns in a run</label><input id="s-turns" type="number" min="1" max="500"></div>
      <div><label for="s-minutes">Time limit, minutes</label><input id="s-minutes" type="number" min="1" max="600"></div>
      <div><label for="s-stuck">Call a run silent after, minutes</label><input id="s-stuck" type="number" min="1" max="240"></div>
      <div><label for="s-gate">Before a run</label><select id="s-gate"><option value="yes">Write the test of done, ask once if unclear</option><option value="no">Start right away</option></select></div>
      <div><label for="s-gate-model">Model that reads the ticket</label><input id="s-gate-model" autocomplete="off" spellcheck="false"></div>
      <div><label for="s-park-wait">Rest after the plan limit, minutes</label><input id="s-park-wait" type="number" min="1" max="1440"></div>
      <div><label for="s-park-returns">A parked ticket comes back by itself, times <span class="hint">0: it waits for you</span></label><input id="s-park-returns" type="number" min="0" max="20"></div>
      <div><label for="s-issues">GitHub issues</label><select id="s-issues"><option value="off">Off</option><option value="in">Your labelled issues become tickets</option><option value="both">Both ways: tickets also get an issue</option></select></div>
      <div><label for="s-issues-label">Issue label <span class="hint">only your own issues with this label come in</span></label><input id="s-issues-label" autocomplete="off" spellcheck="false"></div>
      <div><label for="s-issues-every">Look at GitHub every, minutes</label><input id="s-issues-every" type="number" min="1" max="1440"></div>
      <div><label for="s-update">Updates</label><select id="s-update"><option value="yes">Install by themselves at start</option><option value="no">Never by themselves</option></select></div>
      <div><label for="s-phone">Lines to your phone</label><select id="s-phone"><option value="none">None, the home screen only</option><option value="ntfy">The ntfy app</option></select></div>
      <div class="wide"><label for="s-topic">ntfy channel name <span class="hint">16 or more letters and digits; whoever knows it can read the lines</span></label><input id="s-topic" autocomplete="off" spellcheck="false"></div>
      <div class="wide"><label for="s-prepare">The run does these first <span class="hint">one per line; they fetch what the checks need</span></label><textarea id="s-prepare" spellcheck="false"></textarea></div>
      <div class="wide"><label for="s-checks">Checks SoftwareFactory runs on the result <span class="hint">leave empty and SoftwareFactory finds them in the project; or one per line, in this order</span></label><textarea id="s-checks" spellcheck="false"></textarea></div>
    </div>
    <div class="row"><button id="save" type="button">Save settings</button><button id="phone-test" type="button">Send a test line to the phone</button><span class="hint" id="save-hint"></span></div>
    <p class="msg" id="set-msg" role="alert"></p>
    <p class="fence" id="fence"></p>
  </details>
</main>
<script>
(function () {
  "use strict";
  var KEY = "__SF_KEY__";
  var $ = function (id) { return document.getElementById(id); };
  var open = {}, askedOpen = false, nodes = {}, drawn = null, confirming = null, settingsLoaded = false, last = null, busy = false;

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
  function clock(iso) { var d = new Date(iso); return isNaN(d) ? "" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }); }
  function day(iso) { var d = new Date(iso); return isNaN(d) ? "" : d.toLocaleDateString([], { day: "numeric", month: "short" }) + ", " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }); }
  function money(n) { return "$" + Number(n || 0).toFixed(2); }
  function lines(v) { return String(v || "").split(/\\r?\\n/).map(function (x) { return x.trim(); }).filter(Boolean); }
  var KINDS = { request: "Request", bug: "Bug", task: "Task", idea: "Idea", plan: "Plan", question: "Question" };
  var editing = null, draft = {}, showRemoved = false, answers = {};
  var CHIP = { waiting: ["Waiting", ""], asked: ["A question for you", "proposed"], kept: ["Kept", ""], working: ["Working", "working"], proposed: ["Waiting for you", "proposed"], accepted: ["Accepted", "accepted"], undone: ["Undone", ""], held: ["Held here", "proposed"], passed: ["Passed", ""], "failed its checks": ["Failed its checks", "bad"], parked: ["Parked", ""], stopped: ["Stopped", ""], crashed: ["Crashed", "bad"], "not started": ["Not started", "bad"], interrupted: ["Interrupted", ""] };

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
    top.appendChild(el("span", "chip " + chip[1], t.removed ? "Removed" : chip[0] + (t.place ? ", place " + t.place : "")));
    if (t.kind && t.kind !== "request") top.appendChild(el("span", "meta", KINDS[t.kind] || t.kind));
    top.appendChild(el("span", "meta", day(t.openedAt) + (t.costUsd ? "  ·  " + money(t.costUsd) : "")));
    box.appendChild(top);
    if (editing === t.ticket && !t.canEdit) { editing = null; delete draft[t.ticket]; acceptError[t.ticket] = "It started before your change was saved."; }
    if (editing === t.ticket && t.canEdit) {
      var d0 = draft[t.ticket] || (draft[t.ticket] = { sentence: t.sentence, kind: t.kind });
      var ta = el("textarea"); ta.maxLength = 4000; ta.value = d0.sentence; ta.setAttribute("aria-label", "The ticket in your words");
      ta.oninput = function () { d0.sentence = ta.value; };
      var ks = el("select"); ks.setAttribute("aria-label", "Kind of ticket");
      Object.keys(KINDS).forEach(function (k) { var o = el("option", "", KINDS[k]); o.value = k; ks.appendChild(o); });
      ks.value = d0.kind; ks.onchange = function () { d0.kind = ks.value; };
      var erow = el("div", "row");
      var save = el("button", "main", "Save"); save.type = "button";
      save.onclick = function () { save.disabled = true; post("/api/step1/ticket/edit", { ticket: t.ticket, sentence: d0.sentence, kind: d0.kind }).then(function (r) { if (r.ok) { editing = null; delete draft[t.ticket]; delete acceptError[t.ticket]; } else { acceptError[t.ticket] = r.why; } load(); render(last); }); };
      var cancel = el("button", "", "Cancel"); cancel.type = "button";
      cancel.onclick = function () { editing = null; delete draft[t.ticket]; render(last); };
      erow.appendChild(save); erow.appendChild(ks); erow.appendChild(cancel);
      box.appendChild(ta); box.appendChild(erow);
    } else box.appendChild(el("p", "sentence", t.sentence));
    box.appendChild(el("p", t.state === "asked" ? "sentence" : "says", (t.state === "asked" ? "SoftwareFactory asks before it starts: " : "") + t.says));
    if (t.issue) { var ip = el("p", "says"); if (t.issue.url) { var ia = el("a", "", "Issue #" + t.issue.number + " on GitHub"); ia.href = t.issue.url; ia.target = "_blank"; ia.rel = "noopener noreferrer"; ip.appendChild(ia); } else ip.textContent = "Issue #" + t.issue.number + " on GitHub"; box.appendChild(ip); }
    if (t.returnsAt) box.appendChild(el("p", "says", "It comes back to the queue by itself at " + clock(t.returnsAt) + "."));
    else if (t.state === "parked" && t.parkedFor === "limit") box.appendChild(el("p", "says", "It came back by itself " + t.returns + (t.returns === 1 ? " time" : " times") + " already. Now it waits for you: Work it again sends it."));
    if (t.state === "asked" && !t.removed) {
      var ans = el("textarea"); ans.maxLength = 2000; ans.setAttribute("aria-label", "Your answer"); ans.value = answers[t.ticket] || "";
      ans.oninput = function () { answers[t.ticket] = ans.value; };
      var arow = el("div", "row");
      var send = el("button", "main", "Answer"); send.type = "button";
      send.onclick = function () { send.disabled = true; post("/api/step1/ticket/answer", { ticket: t.ticket, answer: ans.value }).then(function (r) { if (r.ok) { delete answers[t.ticket]; delete acceptError[t.ticket]; } else { acceptError[t.ticket] = r.why; } load(); render(last); }); };
      arow.appendChild(send); arow.appendChild(el("span", "hint", "One answer is enough. It will not ask again."));
      box.appendChild(ans); box.appendChild(arow);
    } else if (t.done && t.done.length && t.state !== "asked") {
      var dl = el("ul", "done");
      t.done.forEach(function (x) { dl.appendChild(el("li", "", x)); });
      box.appendChild(el("p", "says", "Done when:")); box.appendChild(dl);
    }
    if (t.url || t.canAccept || t.canUndo || t.canEdit || t.canAgain || t.canRemove || t.removed) {
      var row = el("div", "row");
      var act = function (path, label, cls) {
        var b = el("button", cls || "", label); b.type = "button";
        b.onclick = function () { b.disabled = true; post("/api/step1/ticket/" + path, { ticket: t.ticket }).then(function (r) { confirming = null; if (!r.ok) { acceptError[t.ticket] = r.why; } else { delete acceptError[t.ticket]; } load(); render(last); }); };
        return b;
      };
      if (t.canAgain) row.appendChild(act("again", "Work it again"));
      if (t.canEdit && editing !== t.ticket) { var ch = el("button", "", "Change"); ch.type = "button"; ch.onclick = function () { editing = t.ticket; render(last); }; row.appendChild(ch); }
      if (t.removed) row.appendChild(act("restore", "Put it back"));
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
      if (t.canRemove) {
        if (confirming === "remove " + t.ticket) {
          var rno = el("button", "", "Keep it"); rno.type = "button"; rno.onclick = function () { confirming = null; render(last); };
          row.appendChild(rno); row.appendChild(act("remove", "Yes, remove it", "stop"));
          setTimeout(function () { rno.focus(); }, 0);
          box.appendChild(el("p", "says", "It leaves the list. The record keeps its story, and you can put it back."));
        } else { var rm = el("button", "", "Remove"); rm.type = "button"; rm.onclick = function () { confirming = "remove " + t.ticket; render(last); }; row.appendChild(rm); }
      }
      if (t.url && /^https:\\/\\/github\\.com\\//.test(t.url)) { var a = el("a", "btn", "Open the proposal on GitHub"); a.href = t.url; a.target = "_blank"; a.rel = "noopener noreferrer"; row.appendChild(a); }
      box.appendChild(row);
    }
    var msg = el("p", "msg", acceptError[t.ticket] || "");
    msg.setAttribute("role", "alert");
    if (acceptError[t.ticket]) box.appendChild(msg);
    if (t.steps && t.steps.length) {
      var road = el("ol", "steps");
      road.setAttribute("aria-label", "The steps of this ticket, each with its proof");
      t.steps.forEach(function (s) {
        var li = el("li", "st-" + s.state.replace(" ", "-"));
        li.appendChild(el("span", "mk", MARK[s.state] || ""));
        var body = el("div", "bd");
        var head = el("p", "hd");
        head.appendChild(el("b", "", s.title));
        head.appendChild(el("span", "sr", " (" + s.state + ") "));
        if (s.at) head.appendChild(el("span", "t", clock(s.at)));
        body.appendChild(head);
        var pr = el("p", "pf", s.proof);
        if (s.url) { pr.appendChild(document.createTextNode(" ")); var a = el("a", "", "Open it on GitHub"); a.href = s.url; a.target = "_blank"; a.rel = "noopener noreferrer"; pr.appendChild(a); }
        body.appendChild(pr);
        if (s.facts.length || s.lines.length) {
          var key = t.ticket + "/" + s.id, more = el("details", "facts");
          more.open = !!open[key];
          more.ontoggle = function () { open[key] = more.open; };
          more.appendChild(el("summary", "", "The proof" + (s.facts.length ? ", " + s.facts.length + (s.facts.length === 1 ? " fact" : " facts") : "")));
          var ul = el("ul");
          s.facts.forEach(function (f) { ul.appendChild(el("li", "", f)); });
          if (s.lines.length) ul.appendChild(el("li", "rec", "Read from the record, " + (s.lines.length === 1 ? "line " : "lines ") + s.lines.join(", ")));
          more.appendChild(ul);
          body.appendChild(more);
        }
        li.appendChild(body);
        road.appendChild(li);
      });
      var rk = t.ticket + "/steps", fold = el("details", "road");
      fold.open = !!open[rk];
      fold.ontoggle = function () { open[rk] = fold.open; };
      var sum = el("summary");
      sum.appendChild(el("span", "sr", "The steps with their proof: "));
      t.steps.forEach(function (s) {
        var c = el("span", "chip st-" + s.state.replace(" ", "-"));
        c.appendChild(el("span", "mk", MARK[s.state] || ""));
        c.appendChild(el("span", "", s.title));
        c.appendChild(el("span", "sr", " (" + s.state + "), "));
        sum.appendChild(c);
      });
      fold.appendChild(sum);
      fold.appendChild(road);
      box.appendChild(fold);
    }
    var det = el("details");
    det.open = !!open[t.ticket];
    det.ontoggle = function () { open[t.ticket] = det.open; };
    det.appendChild(el("summary", "", "Every line of the record, " + t.story.length + (t.story.length === 1 ? " line" : " lines")));
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
  var MARK = { "done": "\u2713", "failed": "!", "now": "\u25B8", "skipped": "\u2013", "not reached": "" };

  function render(s) {
    if (!s) return;
    last = s;
    $("where").textContent = s.settings.repo ? s.settings.repo : "No project chosen yet";
    var run = s.running;
    $("now").className = "card now" + (run ? " on" : "");
    $("start").disabled = !s.settings.repo;
    var waiting = 0, gone = 0; s.tickets.forEach(function (x) { if (x.removed) gone++; else if (x.state === "waiting") waiting++; });
    $("start-hint").textContent = !s.settings.repo ? "Choose the project in Settings first." : (run || waiting ? "It will wait for its turn." : "");
    $("issues-now").hidden = s.settings.issues === "off";
    $("issues-hint").textContent = s.settings.issues === "off" || !s.issuesSeen ? "" : s.issuesSeen.ok ? "GitHub issues looked at " + clock(s.issuesSeen.at) + "." : "GitHub issues could not be read: " + s.issuesSeen.why;
    $("hold").textContent = s.settings.hold ? "Let the queue go" : "Hold the queue";
    $("queue-hint").textContent = s.settings.hold ? "The queue is held. " + waiting + " waiting; nothing new starts until you let it go." : s.resting ? "The queue rests until " + clock(s.resting.until) + ": " + s.resting.why + ". Work it again on a ticket starts sooner." : (waiting ? waiting + " waiting for a turn." : "");
    $("show-removed").hidden = !gone;
    $("show-removed").textContent = showRemoved ? "Hide removed" : "Show removed (" + gone + ")";
    var shown = s.tickets.filter(function (x) { return showRemoved || !x.removed; });
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
      var order = shown.map(function (t) { return t.ticket; }).join(",");
      if (order !== drawn) {
        drawn = order; nodes = {};
        while (list.firstChild) list.removeChild(list.firstChild);
        if (!shown.length) list.appendChild(el("p", "empty", "No tickets yet. Your first sentence starts one."));
      }
      shown.forEach(function (t) {
        var sig = JSON.stringify(t) + "|" + (confirming === t.ticket || confirming === "undo " + t.ticket || confirming === "remove " + t.ticket) + "|" + (editing === t.ticket) + "|" + (acceptError[t.ticket] || "");
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
      $("s-stuck").value = s.settings.stuckMinutes; $("s-update").value = s.settings.autoUpdate ? "yes" : "no"; $("s-gate").value = s.settings.gate ? "yes" : "no"; $("s-gate-model").value = s.settings.gateModel; $("s-park-wait").value = s.settings.parkedWaitMinutes; $("s-park-returns").value = s.settings.parkedReturns; $("s-issues").value = s.settings.issues; $("s-issues-label").value = s.settings.issuesLabel; $("s-issues-every").value = s.settings.issuesEveryMinutes; $("s-phone").value = s.settings.phone; $("s-topic").value = s.settings.ntfyTopic;
      $("s-prepare").value = s.settings.prepare.join("\\n"); $("s-checks").value = s.settings.checks.join("\\n");
    }
    // Settings stay folded when everything a run needs is set; they open by themselves only when the project is missing.
    $("settings-hint").textContent = s.settings.repo ? "Already set. Nothing to fill in." : "Choose the project first.";
    if (!s.settings.repo && !askedOpen) { askedOpen = true; $("settings").open = true; }
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
    post("/api/step1/work", { sentence: text, kind: $("kind").value }).then(function (r) { if (r.ok) { $("sentence").value = ""; } else { $("ask-msg").textContent = r.why; $("start").disabled = false; } load(); });
  };
  $("issues-now").onclick = function () { $("issues-now").disabled = true; post("/api/step1/issues", {}).then(function () { $("issues-now").disabled = false; load(); }); };
  $("hold").onclick = function () { $("hold").disabled = true; post("/api/step1/settings", { hold: !(last && last.settings.hold) }).then(function () { $("hold").disabled = false; load(); }); };
  $("show-removed").onclick = function () { showRemoved = !showRemoved; drawn = null; render(last); };
  $("stop").onclick = function () { $("stop").disabled = true; post("/api/step1/stop").then(function () { $("stop").disabled = false; load(); }); };
  $("save").onclick = function () {
    $("set-msg").textContent = ""; $("save-hint").textContent = "";
    post("/api/step1/settings", { repo: $("s-repo").value, base: $("s-base").value, model: $("s-model").value, maxTurns: Number($("s-turns").value), timeLimitMinutes: Number($("s-minutes").value), stuckMinutes: Number($("s-stuck").value), autoUpdate: $("s-update").value === "yes", gate: $("s-gate").value === "yes", gateModel: $("s-gate-model").value, parkedWaitMinutes: Number($("s-park-wait").value), parkedReturns: Number($("s-park-returns").value), issues: $("s-issues").value, issuesLabel: $("s-issues-label").value, issuesEveryMinutes: Number($("s-issues-every").value), phone: $("s-phone").value, ntfyTopic: $("s-topic").value, prepare: lines($("s-prepare").value), checks: lines($("s-checks").value) })
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

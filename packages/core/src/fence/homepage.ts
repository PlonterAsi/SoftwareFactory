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
.projects { display: grid; gap: 6px; margin: 0 0 14px; padding: 0; list-style: none; }
.projects[hidden] { display: none; }
.projects button { width: 100%; display: flex; gap: 10px; align-items: baseline; text-align: left; padding: 10px 14px; background: var(--card); border: 1px solid var(--line); border-radius: 10px; color: var(--ink); cursor: pointer; flex-wrap: wrap; }
.projects button[aria-pressed="true"] { border-color: var(--accent); box-shadow: inset 3px 0 0 var(--accent); }
.projects b { overflow-wrap: anywhere; }
.projects small { color: var(--soft); border: 1px solid var(--line); border-radius: 999px; padding: 0 8px; white-space: nowrap; }
.projects .says { color: var(--soft); min-width: 0; overflow-wrap: anywhere; }
.dot { flex: none; width: 12px; height: 12px; border-radius: 50%; align-self: center; border: 1px solid transparent; }
.dot.c-red { background: var(--bad); } .dot.c-amber { background: var(--wait); } .dot.c-green { background: var(--good); } .dot.c-blue { background: var(--accent); } .dot.c-grey { background: var(--calm-bg); border-color: var(--soft); }
.plist { list-style: none; margin: 6px 0 0; padding: 0; display: grid; gap: 8px; }
.plist li { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.plist input { flex: 1 1 160px; min-width: 0; }
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
#since { border: 1px solid var(--line); border-radius: 10px; padding: 4px 16px 12px; margin: 0 0 18px; background: var(--card, transparent); }
#since h3 { font-size: 14px; margin: 12px 0 4px; }
ul.since button.link { border: 0; background: none; padding: 0; font-weight: 700; color: inherit; text-decoration: underline; cursor: pointer; }
ul.since { margin: 0; padding-left: 20px; line-height: 1.5; }
ul.since .why { display: block; color: var(--soft); font-size: 14px; }
ul.stops { margin: 4px 0 8px; padding-left: 20px; font-size: 14px; line-height: 1.5; }
ul.stops code { font-family: var(--mono); overflow-wrap: anywhere; }
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
  <div class="msg" id="doubt" role="alert" hidden><p id="doubt-say"></p><ul id="doubt-list"></ul><div class="row"><button id="doubt-back" type="button">Put back what stood</button><button id="doubt-keep" type="button">The file is right: keep it by my hand</button></div></div>

  <ul class="projects" id="projects" aria-label="Projects" hidden></ul>

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

  <section id="since" hidden>
    <h2 id="since-title">Since you last looked</h2>
    <div id="since-body"></div>
    <div class="row"><button id="since-ok" type="button">Got it</button><span class="hint" id="since-hint"></span></div>
  </section>

  <h2 id="tickets-title">Tickets</h2>
  <p class="hint" id="limits-line"></p>
  <div class="row" id="queue-row"><button id="hold" type="button">Hold the queue</button><span class="hint" id="queue-hint"></span><button id="show-removed" type="button" hidden></button><button id="issues-now" type="button" hidden>Look at GitHub now</button><span class="hint" id="issues-hint"></span></div>
  <section class="card" aria-labelledby="tickets-title"><div id="tickets"><p class="empty">No tickets yet. Your first sentence starts one.</p></div></section>

  <details class="card settings" id="settings">
    <summary id="settings-title">Settings <span class="hint" id="settings-hint"></span></summary>
    <div class="wide"><label for="p-add">Projects <span class="hint">every product SoftwareFactory works on. The chosen one gets your new tickets, and the fields below speak for it. A sleeping project keeps its tickets and none is worked. Taking one off the list keeps its tickets in the record.</span></label>
      <ul class="plist" id="plist"></ul>
      <div class="row"><input id="p-add" autocomplete="off" spellcheck="false" placeholder="owner/name"><button id="p-add-go" type="button">Add the project</button></div>
      <p class="msg" id="p-msg" role="alert"></p>
    </div>
    <div class="grid">
      <div class="wide"><label for="s-repo">The chosen project <span class="hint">owner/name on GitHub. The branch, the prepare lines and the checks below are this project's.</span></label><input id="s-repo" autocomplete="off" spellcheck="false"></div>
      <div><label for="s-base">Start from branch <span class="hint">empty: the project's main one</span></label><input id="s-base" autocomplete="off" spellcheck="false"></div>
      <div><label for="s-model">Model</label><input id="s-model" autocomplete="off" spellcheck="false"></div>
      <div><label for="s-turns">Most turns in a run</label><input id="s-turns" type="number" min="1" max="500"></div>
      <div><label for="s-minutes">Time limit, minutes</label><input id="s-minutes" type="number" min="1" max="600"></div>
      <div><label for="s-stuck">Call a run silent after, minutes</label><input id="s-stuck" type="number" min="1" max="240"></div>
      <div><label for="s-ladder">When a run does not finish</label><select id="s-ladder"><option value="yes">Climb the ladder by itself, then wait for me</option><option value="no">Wait for me</option></select></div>
      <div><label for="s-ladder-again">Tries once more <span class="hint">told what went wrong</span></label><input id="s-ladder-again" type="number" min="0" max="5"></div>
      <div><label for="s-ladder-other">Then tries another way <span class="hint">told not to repeat itself</span></label><input id="s-ladder-other" type="number" min="0" max="5"></div>
      <div><label for="s-ladder-model">Model for another way <span class="hint">empty: the same model</span></label><input id="s-ladder-model" autocomplete="off" spellcheck="false"></div>
      <div><label for="s-ladder-split">Then</label><select id="s-ladder-split"><option value="yes">Split it once into smaller tickets</option><option value="no">Do not split</option></select></div>
      <div><label for="s-ladder-shared">Tries the smaller tickets share</label><input id="s-ladder-shared" type="number" min="0" max="5"></div>
      <div><label for="s-ladder-split-model">Model that splits a ticket</label><input id="s-ladder-split-model" autocomplete="off" spellcheck="false"></div>
      <div><label for="s-ladder-split-min">Do not split a ticket shorter than <span class="hint">characters</span></label><input id="s-ladder-split-min" type="number" min="0" max="10000"></div>
      <div><label for="s-ladder-within">Only a run that ended in the last <span class="hint">minutes climbs; an older one waits for you</span></label><input id="s-ladder-within" type="number" min="1" max="10080"></div>
      <div><label for="s-gate">Before a run</label><select id="s-gate"><option value="yes">Write the test of done, ask once if unclear</option><option value="no">Start right away</option></select></div>
      <div><label for="s-gate-model">Model that reads the ticket</label><input id="s-gate-model" autocomplete="off" spellcheck="false"></div>
      <div><label for="s-park-wait">Rest after the plan limit, minutes</label><input id="s-park-wait" type="number" min="1" max="1440"></div>
      <div><label for="s-park-returns">A parked ticket comes back by itself, times <span class="hint">0: it waits for you</span></label><input id="s-park-returns" type="number" min="0" max="20"></div>
      <div><label for="s-limit-period">The limits are counted per</label><select id="s-limit-period"><option value="day">day</option><option value="week">week</option><option value="month">month</option></select></div>
      <div><label for="s-limit-you">Limit 1: work you sent <span class="hint">dollars per period, as Claude Code counts each run</span></label><input id="s-limit-you" type="number" min="0" step="1"></div>
      <div><label for="s-limit-alone">Limit 2: what SoftwareFactory does by itself <span class="hint">tickets it brings back, and its own work</span></label><input id="s-limit-alone" type="number" min="0" step="1"></div>
      <div><label for="s-own-share">SoftwareFactory's own share of limit 2 <span class="hint">percent</span></label><input id="s-own-share" type="number" min="0" max="100"></div>
      <div><label for="s-run-limit">The most one run may use <span class="hint">dollars; at it the run is parked and its work is kept</span></label><input id="s-run-limit" type="number" min="0" step="0.5"></div>
      <div><label for="s-run-floor">Do not start a run with less than <span class="hint">dollars left of its limit; the ticket waits for the new period instead</span></label><input id="s-run-floor" type="number" min="0" step="0.1"></div>
      <div><label for="s-max-projects">The most projects <span class="hint">on the list</span></label><input id="s-max-projects" type="number" min="1" max="200"></div>
      <div><label for="s-live">Live check <span class="hint">when a project that runs here changes on GitHub</span></label><select id="s-live"><option value="yes">Run it here again, changing nothing</option><option value="no">Off</option></select></div>
      <div><label for="s-live-every">Ask GitHub about changes every, minutes</label><input id="s-live-every" type="number" min="5" max="1440"></div>
      <div><label for="s-bring-in">When a project is added <span class="hint">one run that changes nothing</span></label><select id="s-bring-in"><option value="yes">Show at once that it runs here</option><option value="no">Only add it</option></select></div>
      <div><label for="s-since-show">The panel "since you last looked" names up to <span class="hint">tickets of each group</span></label><input id="s-since-show" type="number" min="1" max="100"></div>
      <div><label for="s-slots">Runs at once <span class="hint">1 is the proven way; with 2 each run gets its own cell in the room</span></label><input id="s-slots" type="number" min="1" max="4"></div>
      <div><label for="s-cut-returns">A cut-off ticket comes back by itself, times <span class="hint">cut off: SoftwareFactory closed or the computer restarted mid-run</span></label><input id="s-cut-returns" type="number" min="0" max="20"></div>
      <div><label for="s-cut-hours">Only when cut off within, hours</label><input id="s-cut-hours" type="number" min="1" max="720"></div>
      <div><label for="s-issues">GitHub issues</label><select id="s-issues"><option value="off">Off</option><option value="in">Your labelled issues become tickets</option><option value="both">Both ways: tickets also get an issue</option></select></div>
      <div><label for="s-issues-label">Issue label <span class="hint">only your own issues with this label come in</span></label><input id="s-issues-label" autocomplete="off" spellcheck="false"></div>
      <div><label for="s-issues-every">Look at GitHub every, minutes</label><input id="s-issues-every" type="number" min="1" max="1440"></div>
      <div><label for="s-update">Updates</label><select id="s-update"><option value="yes">Install by themselves at start</option><option value="no">Never by themselves</option></select></div>
      <div><label for="s-phone">Lines to your phone</label><select id="s-phone"><option value="none">None, the home screen only</option><option value="ntfy">The ntfy app</option></select></div>
      <div class="wide"><label for="s-topic">ntfy channel name <span class="hint">16 or more letters and digits; whoever knows it can read the lines</span></label><input id="s-topic" autocomplete="off" spellcheck="false"></div>
      <div class="wide"><label for="s-prepare">The run does these first <span class="hint">one per line; they fetch what the checks need</span></label><textarea id="s-prepare" spellcheck="false"></textarea></div>
      <div class="wide"><label for="s-stop-paths">More on the stop list <span class="hint">one per line; a result that changes a file whose path holds one of these waits for your look. The built-in list (security, going live, money and live data, what runs by itself, new packages) always holds</span></label><textarea id="s-stop-paths" spellcheck="false"></textarea></div>
      <div class="wide"><label for="s-checks">Checks SoftwareFactory runs on the result <span class="hint">leave empty and SoftwareFactory finds them in the project; or one per line, in this order</span></label><textarea id="s-checks" spellcheck="false"></textarea></div>
    </div>
    <div class="row"><button id="save" type="button">Save settings</button><button id="phone-test" type="button">Send a test line to the phone</button><span class="hint" id="save-hint"></span></div>
    <p class="msg" id="set-msg" role="alert"></p>
    <div id="hand" hidden><ul id="hand-list"></ul><div class="row"><button id="hand-yes" type="button">Yes, change these by my hand</button><button id="hand-no" type="button">No, leave them</button></div></div>
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
  var sinceSig = "", sinceUpTo = 0;
  function drawSince(sn) {
    var box = $("since");
    if (!sn || (!sn.items.length && !sn.cameBack)) { box.hidden = true; sinceSig = ""; return; }
    sinceUpTo = sn.upTo;
    var sig = JSON.stringify(sn); if (sig === sinceSig) return; sinceSig = sig;
    box.hidden = false;
    $("since-title").textContent = sn.seenAt ? "Since you last looked (" + day(sn.seenAt) + ")" : "What happened so far";
    var body = $("since-body"); body.textContent = "";
    var names = { yours: "Waits for your word", ready: "Finished and checked, ready for you", unfinished: "Did not finish" };
    ["yours", "ready", "unfinished"].forEach(function (g) {
      var mine = sn.items.filter(function (x) { return x.group === g; });
      if (!mine.length) return;
      body.appendChild(el("h3", "since-" + g, names[g] + " (" + sn.counts[g] + ")"));
      var ul = el("ul", "since");
      mine.forEach(function (x) {
        var li = el("li");
        var go = el("button", "link", x.ticket); go.type = "button"; go.onclick = function () { var n = nodes[x.ticket] && nodes[x.ticket].node; if (!n && x.project) { lookAt(x.project); n = nodes[x.ticket] && nodes[x.ticket].node; } if (n && n.scrollIntoView) n.scrollIntoView({ behavior: "smooth", block: "center" }); };
        if (x.project && last && (last.projects || []).length > 1 && viewOf(last) !== x.project.toLowerCase()) li.appendChild(el("small", "", nameOf(last, x.project) + " "));
        li.appendChild(go); li.appendChild(document.createTextNode(" " + x.sentence));
        li.appendChild(el("span", "why", x.says));
        if (x.url) { var a = el("a", "", "Open on GitHub"); a.href = x.url; a.target = "_blank"; a.rel = "noopener noreferrer"; li.appendChild(document.createTextNode(" ")); li.appendChild(a); }
        ul.appendChild(li);
      });
      body.appendChild(ul);
      if (sn.counts[g] > mine.length) body.appendChild(el("p", "hint", "And " + (sn.counts[g] - mine.length) + " more like these on the list below."));
    });
    $("since-hint").textContent = (sn.cameBack ? sn.cameBack + (sn.cameBack === 1 ? " ticket was" : " tickets were") + " brought back to the queue by SoftwareFactory. " : "") + "All work in this time used " + money(sn.costUsd) + ". Got it clears this panel; the tickets stay below.";
  }
  $("since-ok").onclick = function () { $("since-ok").disabled = true; post("/api/step1/seen", { upTo: sinceUpTo }).then(function (r) { $("since-ok").disabled = false; if (r && r.ok === false) { sinceSig = ""; $("since-hint").textContent = "That did not go through: " + (r.why || "SoftwareFactory did not answer") + "."; return; } load(); }); };
  function lines(v) { return String(v || "").split(/\\r?\\n/).map(function (x) { return x.trim(); }).filter(Boolean); }
  var KINDS = { request: "Request", bug: "Bug", task: "Task", idea: "Idea", plan: "Plan", question: "Question" };
  var editing = null, draft = {}, showRemoved = false, answers = {};
  var CHIP = { waiting: ["Waiting", ""], asked: ["A question for you", "proposed"], kept: ["Kept", ""], working: ["Working", "working"], proposed: ["Waiting for you", "proposed"], accepted: ["Accepted", "accepted"], undone: ["Undone", ""], held: ["Held here", "proposed"], split: ["Split", ""], passed: ["Passed", ""], "failed its checks": ["Failed its checks", "bad"], parked: ["Parked", ""], stopped: ["Stopped", ""], crashed: ["Crashed", "bad"], "not started": ["Not started", "bad"], interrupted: ["Interrupted", ""] };

  function post(path, body) {
    return fetch(path, { method: "POST", headers: { "content-type": "application/json", "x-sf-key": KEY }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json().catch(function () { return { ok: false, why: "The answer could not be read." }; }); })
      .catch(function () { return { ok: false, why: "SoftwareFactory is not answering. Is it still open?" }; });
  }

  function ticketNode(t) {
    var box = el("article", "ticket");
    var top = el("div", "top");
    var chip = t.finding ? ["Stopped running here", "bad"] : t.healedBy ? ["Checked again since", ""] : t.liveCheck && t.state === "passed" ? ["Still runs here", "accepted"] : t.bringIn && t.state === "passed" ? ["Runs here", "accepted"] : t.bringIn && t.parkedFor === "no checks" ? ["No checks found", ""] : CHIP[t.state] || [t.state, ""];
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
    if (t.stops && t.stops.length) {
      box.appendChild(el("p", "says", "Nothing failed. These changes always wait for your own look before they leave this computer:"));
      var sl = el("ul", "stops");
      t.stops.forEach(function (x) { var li = el("li"); li.appendChild(el("b", "", x.family + ": ")); li.appendChild(el("code", "", x.file)); li.appendChild(document.createTextNode(" " + x.why)); sl.appendChild(li); });
      box.appendChild(sl);
    }
    if (t.parent) box.appendChild(el("p", "says", "A smaller piece of " + t.parent + ", cut by SoftwareFactory when that one did not get done whole."));
    if (t.ladder && (t.state === "waiting" || t.state === "working")) box.appendChild(el("p", "says", "SoftwareFactory sent it again by itself: " + t.ladder + (t.lastFail ? ", after its run ended as " + t.lastFail.state + "." : ".")));
    else if (t.ladderUsed && ["failed its checks", "crashed", "parked"].indexOf(t.state) >= 0) box.appendChild(el("p", "says", "SoftwareFactory already tried it " + t.ladderUsed + (t.ladderUsed === 1 ? " more time" : " more times") + " by itself."));
    if (t.limitUntil) box.appendChild(el("p", "says", (t.bucket === "you" ? "Limit 1 (work you sent)" : "Limit 2 (what SoftwareFactory does by itself)") + " is used up, so this waits until " + day(t.limitUntil) + ". Other work goes on. The limits are in Settings."));
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
    if (t.state === "working" && last && last.runs && last.runs.length > 1) {
      var srow = el("div", "row"), sb = el("button", "stop", "Stop " + t.ticket);
      sb.type = "button";
      sb.onclick = function () { sb.disabled = true; post("/api/step1/stop", { ticket: t.ticket }).then(function () { load(); }); };
      srow.appendChild(sb); srow.appendChild(el("span", "hint", "Ends this run only. The other goes on."));
      box.appendChild(srow);
    }
    if (t.url || t.canAccept || t.canUndo || t.canEdit || t.canAgain || t.canRemove || t.removed) {
      var row = el("div", "row");
      var act = function (path, label, cls) {
        var b = el("button", cls || "", label); b.type = "button";
        b.onclick = function () { b.disabled = true; post("/api/step1/ticket/" + path, { ticket: t.ticket }).then(function (r) { confirming = null; if (!r.ok) { acceptError[t.ticket] = r.why; } else { delete acceptError[t.ticket]; } load(); render(last); }); };
        return b;
      };
      if (t.canAgain) row.appendChild(act("again", t.keptWork ? "Go on from the kept work" : "Work it again"));
      if (t.canAgain && t.keptWork) { var cl = el("button", "", "Start clean"); cl.type = "button"; cl.onclick = function () { cl.disabled = true; post("/api/step1/ticket/again", { ticket: t.ticket, clean: true }).then(function (r) { if (!r.ok) { acceptError[t.ticket] = r.why; } else { delete acceptError[t.ticket]; } load(); render(last); }); }; row.appendChild(cl); }
      if (t.canEdit && editing !== t.ticket) { var ch = el("button", "", "Change"); ch.type = "button"; ch.onclick = function () { editing = t.ticket; render(last); }; row.appendChild(ch); }
      if (t.removed) row.appendChild(act("restore", "Put it back"));
      if (t.finding && !t.fixedBy) { var fx = el("button", "good", "Open a ticket to fix it"); fx.type = "button"; fx.onclick = function () { fx.disabled = true; post("/api/step1/ticket/fix", { ticket: t.ticket }).then(function (r) { if (r && r.ok === false) acceptError[t.ticket] = r.why; else delete acceptError[t.ticket]; load(); }); }; row.appendChild(fx); }
      if (t.finding && t.fixedBy) row.appendChild(el("span", "hint", t.fixedBy + " is open to fix it."));
      if (t.canRelease) {
        if (confirming === "release " + t.ticket) {
          var ryes = el("button", "good", "Yes, send it to GitHub as a draft"); ryes.type = "button";
          ryes.onclick = function () { busy = true; ryes.disabled = true; post("/api/step1/release", { ticket: t.ticket }).then(function (r) { busy = false; confirming = null; if (!r.ok) { acceptError[t.ticket] = r.why; } else { delete acceptError[t.ticket]; } load(); }); };
          var rno = el("button", "", "Not now"); rno.type = "button"; rno.onclick = function () { confirming = null; render(last); };
          row.appendChild(rno); row.appendChild(ryes);
        } else {
          var rel = el("button", "", "I looked: let it go to GitHub"); rel.type = "button";
          rel.onclick = function () { confirming = "release " + t.ticket; render(last); };
          row.appendChild(rel);
        }
      }
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

  function hereRepo(s, lower) { var r = lower; (s.projects || []).forEach(function (p) { if (p.repo.toLowerCase() === lower) r = p.repo; }); return r; }
  function nameOf(s, repo) { var n = repo; (s.projects || []).forEach(function (p) { if (p.repo.toLowerCase() === String(repo).toLowerCase() && p.name) n = p.name; }); return n; }
  var projSig = "", view = "", removing = "";
  // Looking at a project is not choosing it: the strip changes what this page shows and where the next ticket goes,
  // said in words beside the button. The chosen project (Settings) is what the page opens on.
  function viewOf(s) { var ps = (s && s.projects) || [], ok = false; ps.forEach(function (p) { if (p.repo.toLowerCase() === view) ok = true; }); return ok ? view : ((s && s.settings.repo) || "").toLowerCase(); }
  function lookAt(repo) { view = String(repo).toLowerCase(); projSig = ""; drawn = null; render(last); }
  function project(body, msg) { return post("/api/step1/project", body).then(function (r) { if (msg) msg.textContent = r && r.ok === false ? r.why : ""; settingsLoaded = false; projSig = ""; load(); return r; }); }
  function drawProjects(s) {
    var ps = s.projects || [], sig = JSON.stringify(ps) + viewOf(s) + removing;
    if (sig === projSig) return;
    projSig = sig;
    var top = $("projects"); top.textContent = ""; top.hidden = ps.length < 2;
    // The list in Settings is left alone while a name is being typed in it.
    var list = $("plist"), typing = list.contains(document.activeElement) && document.activeElement.tagName === "INPUT";
    if (typing) projSig = ""; else list.textContent = "";
    var words = { red: "waits for you", amber: "did not finish", green: "ready", blue: "working", grey: "quiet" };
    ps.forEach(function (p) {
      var li = el("li"), b = el("button"); b.type = "button"; b.setAttribute("aria-pressed", p.repo.toLowerCase() === viewOf(s) ? "true" : "false");
      var dot = el("span", "dot c-" + p.colour); dot.setAttribute("role", "img"); dot.setAttribute("aria-label", words[p.colour] || p.colour);
      b.appendChild(dot); b.appendChild(el("b", "", p.name || p.repo)); b.appendChild(el("small", "", words[p.colour] || "")); b.appendChild(el("span", "says", p.says));
      b.onclick = function () { lookAt(p.repo); };
      li.appendChild(b); top.appendChild(li);
      if (typing || !p.listed) return;
      var row = el("li"); row.appendChild(el("b", "", p.repo));
      var name = el("input"); name.value = p.name; name.maxLength = 60; name.placeholder = "Your own name for it"; name.setAttribute("aria-label", "Your own name for " + p.repo); row.appendChild(name);
      var bt = function (text, body) { var x = el("button", "", text); x.type = "button"; x.onclick = function () { x.disabled = true; project(body(), $("p-msg")); }; row.appendChild(x); };
      bt("Save the name", function () { return { repo: p.repo, name: name.value }; });
      if (!p.chosen) bt("Choose", function () { return { repo: p.repo, choose: true }; });
      bt(p.asleep ? "Wake" : "Put to sleep", function () { return { repo: p.repo, asleep: !p.asleep }; });
      if (p.chosen) row.appendChild(el("span", "hint", "The chosen one: the page opens on it and the fields below are its own."));
      row.appendChild(el("span", "hint", p.bringing ? "Being run here: its ticket is on the list." : p.stopped ? "It stopped running here after a change on GitHub. Its ticket is on the list." : p.proof ? "Runs here: " + p.proof.checks + (p.proof.checks === 1 ? " check" : " checks") + " passed on " + day(p.proof.at) + (p.proof.ticket ? " (" + p.proof.ticket + ")" : "") + "." : "Nothing has shown yet that it runs here."));
      if (!p.bringing) bt(p.proof ? "Show again that it runs here" : "Show that it runs here", function () { return { repo: p.repo, bringIn: true }; });
      // Taking a project off the list takes two presses: its tickets stay in the record, and none is worked.
      if (!p.chosen || ps.length === 1) { var off = el("button", "", removing === p.repo ? "Yes, take it off: its tickets stay in the record" : "Take off the list"); off.type = "button"; off.onclick = function () { if (removing !== p.repo) { removing = p.repo; projSig = ""; drawProjects(last); return; } removing = ""; off.disabled = true; project({ repo: p.repo, remove: true }, $("p-msg")); }; row.appendChild(off); }
      list.appendChild(row);
    });
  }
  function render(s) {
    if (!s) return;
    last = s;
    var here = viewOf(s), many = (s.projects || []).length > 1, hereName = here ? nameOf(s, hereRepo(s, here)) : "";
    $("where").textContent = here ? hereName : "No project chosen yet";
    $("ask-label").firstChild.nodeValue = many && here ? "What should be done in " + hereName + "? " : "What should be done? ";
    var run = s.running;
    $("now").className = "card now" + (run ? " on" : "");
    $("start").disabled = !s.settings.repo;
    var inHere = function (x) { return !many || !here || (x.project || "").toLowerCase() === here; };
    var waiting = 0, gone = 0; s.tickets.forEach(function (x) { if (!inHere(x)) return; if (x.removed) gone++; else if (x.state === "waiting") waiting++; });
    $("start-hint").textContent = !s.settings.repo ? "Choose the project in Settings first." : (run || waiting ? "It will wait for its turn." : "");
    $("issues-now").hidden = s.settings.issues === "off";
    $("issues-hint").textContent = s.settings.issues === "off" || !s.issuesSeen ? "" : s.issuesSeen.ok ? "GitHub issues looked at " + clock(s.issuesSeen.at) + "." : "GitHub issues could not be read: " + s.issuesSeen.why;
    $("hold").textContent = s.settings.hold ? "Let the queue go" : "Hold the queue";
    drawSince(s.since);
    var db = s.settingsDoubt || [];
    $("doubt").hidden = !db.length;
    if (db.length) { $("doubt-say").textContent = "Nothing starts for now. These protected settings in the settings file are not what stands in the record, so something that is not this screen changed the file."; $("doubt-list").textContent = ""; db.forEach(function (c) { $("doubt-list").appendChild(el("li", "", c.says + (c.setAt ? " (since " + day(c.setAt) + ")" : ""))); }); }
    if (s.limits) $("limits-line").textContent = "This " + s.limits.period + ": you sent " + money(s.limits.used.you) + " of " + money(s.limits.limit.you) + "; by itself " + money(s.limits.used.alone + s.limits.used.own) + " of " + money(s.limits.limit.alone) + ". New on " + day(s.limits.until) + ".";
    $("queue-hint").textContent = s.settings.hold ? "The queue is held. " + waiting + " waiting; nothing new starts until you let it go." : s.resting ? "The queue rests until " + clock(s.resting.until) + ": " + s.resting.why + ". Work it again on a ticket starts sooner." : (waiting ? waiting + " waiting for a turn." : "");
    $("show-removed").hidden = !gone;
    $("show-removed").textContent = showRemoved ? "Hide removed" : "Show removed (" + gone + ")";
    drawProjects(s);
    // The list below is the chosen project's. The others are one line each at the top.
    var shown = s.tickets.filter(function (x) { return (showRemoved || !x.removed) && inHere(x); });
    $("tickets-title").textContent = many && here ? "Tickets of " + hereName : "Tickets";
    if (run) {
      var t = null; s.tickets.forEach(function (x) { if (x.ticket === run.ticket) t = x; });
      var names = (s.runs || []).map(function (x) { return x.ticket; });
      $("now-title").textContent = "Working on " + (names.length > 1 ? names.join(" and ") : (run.ticket || "a new ticket")) + (many && t && !inHere(t) ? " of " + nameOf(s, t.project) : "");
      $("stop").textContent = names.length > 1 ? "Stop all " + names.length : "Stop";
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
        var sig = JSON.stringify(t) + "|" + (confirming === t.ticket || confirming === "undo " + t.ticket || confirming === "remove " + t.ticket || confirming === "release " + t.ticket) + "|" + (editing === t.ticket) + "|" + (acceptError[t.ticket] || "");
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
      $("s-stuck").value = s.settings.stuckMinutes; $("s-update").value = s.settings.autoUpdate ? "yes" : "no"; $("s-gate").value = s.settings.gate ? "yes" : "no"; $("s-gate-model").value = s.settings.gateModel; $("s-ladder").value = s.settings.ladder ? "yes" : "no"; $("s-ladder-again").value = s.settings.ladderAgain; $("s-ladder-other").value = s.settings.ladderOtherWay; $("s-ladder-model").value = s.settings.ladderModel; $("s-ladder-split").value = s.settings.ladderSplit ? "yes" : "no"; $("s-ladder-shared").value = s.settings.ladderSharedTries; $("s-ladder-split-model").value = s.settings.ladderSplitModel; $("s-ladder-within").value = s.settings.ladderWithinMinutes; $("s-ladder-split-min").value = s.settings.ladderSplitMinChars; $("s-park-wait").value = s.settings.parkedWaitMinutes; $("s-park-returns").value = s.settings.parkedReturns; $("s-slots").value = s.settings.slots; $("s-limit-period").value = s.settings.limitPeriod; $("s-limit-you").value = s.settings.limitYou; $("s-limit-alone").value = s.settings.limitAlone; $("s-own-share").value = s.settings.ownSharePercent; $("s-run-limit").value = s.settings.runLimit; $("s-run-floor").value = s.settings.runFloor; $("s-since-show").value = s.settings.sinceShow; $("s-max-projects").value = s.settings.maxProjects; $("s-bring-in").value = s.settings.bringInOnAdd ? "yes" : "no"; $("s-live").value = s.settings.liveCheck ? "yes" : "no"; $("s-live-every").value = s.settings.liveCheckEveryMinutes; $("s-cut-returns").value = s.settings.cutOffReturns; $("s-cut-hours").value = s.settings.cutOffWithinHours; $("s-issues").value = s.settings.issues; $("s-issues-label").value = s.settings.issuesLabel; $("s-issues-every").value = s.settings.issuesEveryMinutes; $("s-phone").value = s.settings.phone; $("s-topic").value = s.settings.ntfyTopic;
      $("s-prepare").value = s.settings.prepare.join("\\n"); $("s-checks").value = s.settings.checks.join("\\n"); $("s-stop-paths").value = (s.settings.stopPaths || []).join("\\n");
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
    post("/api/step1/work", { sentence: text, kind: $("kind").value, project: last ? hereRepo(last, viewOf(last)) : "" }).then(function (r) { if (r.ok) { $("sentence").value = ""; } else { $("ask-msg").textContent = r.why; $("start").disabled = false; } load(); });
  };
  $("issues-now").onclick = function () { $("issues-now").disabled = true; post("/api/step1/issues", {}).then(function () { $("issues-now").disabled = false; load(); }); };
  $("hold").onclick = function () { $("hold").disabled = true; post("/api/step1/settings", { hold: !(last && last.settings.hold) }).then(function () { $("hold").disabled = false; load(); }); };
  $("show-removed").onclick = function () { showRemoved = !showRemoved; drawn = null; render(last); };
  $("stop").onclick = function () { $("stop").disabled = true; post("/api/step1/stop").then(function () { $("stop").disabled = false; load(); }); };
  $("save").onclick = function () {
    $("set-msg").textContent = ""; $("save-hint").textContent = "";
    post("/api/step1/settings", asked = { repo: $("s-repo").value, base: $("s-base").value, model: $("s-model").value, maxTurns: Number($("s-turns").value), timeLimitMinutes: Number($("s-minutes").value), stuckMinutes: Number($("s-stuck").value), autoUpdate: $("s-update").value === "yes", gate: $("s-gate").value === "yes", gateModel: $("s-gate-model").value, ladder: $("s-ladder").value === "yes", ladderAgain: Number($("s-ladder-again").value), ladderOtherWay: Number($("s-ladder-other").value), ladderModel: $("s-ladder-model").value, ladderSplit: $("s-ladder-split").value === "yes", ladderSharedTries: Number($("s-ladder-shared").value), ladderSplitModel: $("s-ladder-split-model").value, ladderWithinMinutes: Number($("s-ladder-within").value), ladderSplitMinChars: Number($("s-ladder-split-min").value), parkedWaitMinutes: Number($("s-park-wait").value), parkedReturns: Number($("s-park-returns").value), slots: Number($("s-slots").value), limitPeriod: $("s-limit-period").value, limitYou: Number($("s-limit-you").value), limitAlone: Number($("s-limit-alone").value), ownSharePercent: Number($("s-own-share").value), runLimit: Number($("s-run-limit").value), runFloor: Number($("s-run-floor").value), sinceShow: Number($("s-since-show").value), maxProjects: Number($("s-max-projects").value), bringInOnAdd: $("s-bring-in").value === "yes", liveCheck: $("s-live").value === "yes", liveCheckEveryMinutes: Number($("s-live-every").value), cutOffReturns: Number($("s-cut-returns").value), cutOffWithinHours: Number($("s-cut-hours").value), issues: $("s-issues").value, issuesLabel: $("s-issues-label").value, issuesEveryMinutes: Number($("s-issues-every").value), phone: $("s-phone").value, ntfyTopic: $("s-topic").value, prepare: lines($("s-prepare").value), checks: lines($("s-checks").value), stopPaths: lines($("s-stop-paths").value) })
      .then(saved);
  };
  // A protected setting is saved in two steps: the page shows each change as a sentence, and the owner says yes.
  var asked = null;
  function saved(r) {
    $("hand").hidden = true;
    if (r.ok) { asked = null; $("save-hint").textContent = "Saved."; settingsLoaded = false; load(); return; }
    $("set-msg").textContent = r.why;
    if (!r.needsHand || !asked) return;
    $("hand-list").textContent = "";
    r.needsHand.forEach(function (c) { $("hand-list").appendChild(el("li", "", c.says)); });
    asked.byHand = r.needsHand.map(function (c) { return c.key; });
    $("hand").hidden = false;
  }
  $("p-add-go").onclick = function () { var v = $("p-add").value.trim(); if (!v) { $("p-msg").textContent = "Write the project as owner/name first."; return; } project({ repo: v }, $("p-msg")).then(function (r) { if (r && r.ok) $("p-add").value = ""; }); };
  $("hand-yes").onclick = function () { if (!asked) return; $("set-msg").textContent = ""; post("/api/step1/settings", asked).then(saved); };
  $("hand-no").onclick = function () { asked = null; $("hand").hidden = true; $("set-msg").textContent = ""; settingsLoaded = false; load(); };
  $("doubt-back").onclick = function () { var body = { byHand: [] }; ((last && last.settingsDoubt) || []).forEach(function (c) { body[c.key] = c.set; body.byHand.push(c.key); }); $("doubt-back").disabled = true; post("/api/step1/settings", body).then(function (r) { $("doubt-back").disabled = false; if (r && r.ok === false) $("doubt-say").textContent = "That did not go through: " + (r.why || "SoftwareFactory did not answer"); settingsLoaded = false; load(); }); };
  $("doubt-keep").onclick = function () { var body = { byHand: [], shown: {} }; ((last && last.settingsDoubt) || []).forEach(function (c) { body.byHand.push(c.key); body.shown[c.key] = c.file; }); $("doubt-keep").disabled = true; post("/api/step1/settings", body).then(function () { $("doubt-keep").disabled = false; settingsLoaded = false; load(); }); };

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

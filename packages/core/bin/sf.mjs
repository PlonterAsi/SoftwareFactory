#!/usr/bin/env node
// sf: SoftwareFactory's tickets from any terminal, for you and for agents (Claude Code sessions in any repo).
// It talks to the running core on this PC (http://127.0.0.1:4317, or SF_URL); no package, no sign-in.
// Every write goes through the same API as the app, so it lands on the ticket's thread like a press there.
//
//   sf inbox                       what waits for you (look, answer, decide)
//   sf list [--all] [--status s] [--kind k] [--project n] [--q words]
//   sf show SF-12                  a ticket, its thread and where its work stands
//   sf doc SF-12                   the ticket's work document as Markdown (what an agent needs to do it)
//   sf open "Title" [--kind bug] [--body text] [--project n] [--asked]
//   sf reply SF-12 "text" [--status ready]
//   sf asked SF-12 [off]           the crew starts it by itself within your standing limit (or not)
//   sf work SF-12 [--max 1.5] [--route light|engine]
//   sf retry SF-12                 pick a stopped run up from its step
//   sf pr SF-12 123                link a pull request made outside SF; its merge moves the ticket
//   sf queue                       the crew's line, and why a ticket waits
//   sf say-project 7 "text"        an ask in a project: a question is answered, "another round" files tickets, else work
//
// Add --json to any command for the raw answer.

const BASE = (process.env.SF_URL || "http://127.0.0.1:4317").replace(/\/+$/, "");

export function parseArgs(argv) {
  const pos = [], flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next == null || next.startsWith("--")) flags[k] = true;
      else { flags[k] = next; i++; }
    } else pos.push(a);
  }
  return { pos, flags };
}

async function call(method, path, body) {
  let res;
  try {
    res = await fetch(BASE + path, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  } catch {
    throw new Error(`SoftwareFactory is not running at ${BASE}. Open the app (or set SF_URL), then try again.`);
  }
  const text = await res.text();
  let data = text;
  try { data = JSON.parse(text); } catch { /* Markdown */ }
  if (!res.ok) throw new Error((data && data.error) || `${res.status} ${text.slice(0, 200)}`);
  return data;
}

async function ticketOf(key) {
  if (!key) throw new Error("Which ticket? Say it by its key, like SF-12.");
  return call("GET", `/api/tickets/key/${encodeURIComponent(key)}`);
}

const money = (n) => (n == null ? "" : `$${Number(n).toFixed(2)}`);
const row = (t) => `${String(t.key ?? `#${t.id}`).padEnd(8)} ${String(t.status).padEnd(11)} ${String(t.kind).padEnd(8)} ${t.size ?? "-"}  ${t.title}${t.blocked ? "  (blocked)" : ""}${t.pr ? `  PR #${t.pr.number} ${t.pr.state}` : ""}`;

function showDetail(d) {
  const t = d.ticket;
  const out = [`${t.key} ${t.title}`, `${t.kind}, ${t.status}${t.size ? `, size ${t.size}` : ""}${t.priority ? `, ${t.priority}` : ""}${d.asked ? ", asked for" : ""}${t.blocked ? ", blocked" : ""}`];
  if (d.parent) out.push(`Under ${d.parent.key} ${d.parent.title}`);
  if (t.pr) out.push(`Pull request #${t.pr.number} (${t.pr.state}): ${t.pr.url}`);
  if (d.run) out.push(`Run #${d.run.id}: ${d.run.outcome ?? `${d.run.station ?? "starting"} ${d.run.state ?? ""}`.trim()}${d.run.spentUsd != null ? `, ${money(d.run.spentUsd)} spent` : ""}`);
  if (d.queue) out.push(d.queue.position != null ? `In the crew's line: ${d.queue.position}` : `Waits: ${d.queue.why}`);
  if (d.retry) out.push(`Can be retried from ${d.retry.from}, with ${money(d.retry.addUsd)} more`);
  if (t.body) out.push("", t.body);
  if (d.links?.length) out.push("", "Links:", ...d.links.map((l) => `  ${l.relation} ${l.key ?? `#${l.id}`} ${l.title ?? ""}`.trimEnd()));
  if (d.notes?.length) {
    out.push("", "Thread:");
    for (const n of d.notes.slice(-15)) out.push(`  [${String(n.at ?? n.ts ?? "").slice(0, 16).replace("T", " ")}] ${n.by}${n.status ? ` -> ${n.status}` : ""}: ${String(n.text ?? "").split("\n")[0].slice(0, 240)}`);
  }
  return out.join("\n");
}

export async function run(argv, print = (s) => console.log(s)) {
  const { pos, flags } = parseArgs(argv);
  const [cmd, a, b] = pos;
  const asJson = flags.json === true;
  const say = (data, human) => print(asJson || typeof human !== "function" ? (typeof data === "string" ? data : JSON.stringify(data, null, 2)) : human(data));
  const project = flags.project != null && flags.project !== true ? `&project=${encodeURIComponent(flags.project)}` : "";
  switch (cmd) {
    case "inbox": {
      const r = await call("GET", `/api/tickets/waiting?${project.slice(1)}`);
      return say(r, (r) => r.items.length ? r.items.map((w) => `${w.need.padEnd(6)} ${row(w.ticket)}${w.say ? `\n       ${w.say}` : ""}`).join("\n") : "Nothing waits for you.");
    }
    case "list": {
      const q = [`view=${flags.all ? "all" : flags.view ?? "open"}`];
      for (const k of ["status", "kind", "q", "parent"]) if (flags[k] && flags[k] !== true) q.push(`${k}=${encodeURIComponent(flags[k])}`);
      const r = await call("GET", `/api/tickets?${q.join("&")}${project}`);
      return say(r, (r) => r.tickets.length ? r.tickets.map(row).join("\n") : "No tickets.");
    }
    case "show": return say(await ticketOf(a), showDetail);
    case "doc": {
      const d = await ticketOf(a);
      return print(await call("GET", `/api/tickets/${d.ticket.id}/document`));
    }
    case "open": {
      if (!a) throw new Error('Say what it is: sf open "Title" [--kind bug] [--body text].');
      const body = { title: a, kind: flags.kind && flags.kind !== true ? flags.kind : "task", body: typeof flags.body === "string" ? flags.body : "", by: "you" };
      if (flags.project && flags.project !== true) body.project = Number(flags.project);
      if (flags.asked) body.asked = true;
      let t = await call("POST", "/api/tickets", body);
      if (flags.size && flags.size !== true) t = await call("POST", `/api/tickets/${t.id}/edit`, { field: "size", value: String(flags.size).toUpperCase() });
      return say(t, (t) => `Opened ${t.key}: ${t.title}`);
    }
    case "reply": {
      if (!b) throw new Error('Say what to write: sf reply SF-12 "text".');
      const d = await ticketOf(a);
      const t = await call("POST", `/api/tickets/${d.ticket.id}/say`, { text: b, status: typeof flags.status === "string" ? flags.status : undefined });
      return say(t, (t) => `Written on ${t.key ?? d.ticket.key}${flags.status ? `; it is ${t.status} now` : ""}.`);
    }
    case "asked": {
      const d = await ticketOf(a);
      const t = await call("POST", `/api/tickets/${d.ticket.id}/asked`, { on: b !== "off" });
      return say(t, () => b === "off" ? `${d.ticket.key} waits for a Work it press again.` : `${d.ticket.key} is asked for: the crew starts it by itself within your standing limit.`);
    }
    case "work": {
      const d = await ticketOf(a);
      const body = {};
      if (flags.max && flags.max !== true) body.maxUsd = Number(flags.max);
      if (flags.route === "light" || flags.route === "engine") body.route = flags.route;
      if (flags.anyway) body.anyway = true;
      const r = await call("POST", `/api/tickets/${d.ticket.id}/work`, body);
      return say(r, (r) => `${d.ticket.key} is being worked${r.run != null ? ` (run #${r.run})` : ""}${r.branch ? ` on ${r.branch}` : ""}.`);
    }
    case "retry": {
      const d = await ticketOf(a);
      const r = await call("POST", `/api/tickets/${d.ticket.id}/retry`, {});
      return say(r, () => `${d.ticket.key} picks up again from the step it stopped at.`);
    }
    case "pr": {
      const d = await ticketOf(a);
      const t = await call("POST", `/api/tickets/${d.ticket.id}/pr`, { pr: b });
      return say(t, (t) => `${d.ticket.key} is linked to PR #${t.pr?.number ?? b}.`);
    }
    case "queue": {
      const r = await call("GET", `/api/tickets/queue?${project.slice(1)}`);
      return say(r, (r) => r.queue.length ? r.queue.map((q) => `${q.position != null ? String(q.position).padStart(3) : "  -"} ${String(q.key).padEnd(8)} ${q.title}${q.why ? `\n      ${q.why}` : ""}`).join("\n") : "The line is empty.");
    }
    case "say-project": {
      if (!a || !b) throw new Error('Say the project and the ask: sf say-project 7 "Why does the login fail?".');
      const r = await call("POST", `/api/projects/${encodeURIComponent(a)}/runs`, { idea: b });
      return say(r, (r) => r.ticket ? `${r.ticket.key} ${r.ticket.title} (${r.door ?? "work"})${r.run != null ? `, run #${r.run}` : ""}` : `Run #${r.runId ?? r.run ?? "?"} started.`);
    }
    case undefined: case "help": case "-h": case "--help":
      return print("sf inbox | list | show KEY | doc KEY | open \"Title\" | reply KEY \"text\" | asked KEY [off] | work KEY | retry KEY | pr KEY N | queue | say-project ID \"text\"   (--json for raw; SF_URL to point elsewhere)");
    default: throw new Error(`No command "${cmd}". Run sf help.`);
  }
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/").replace(/^(?=[A-Za-z]:)/, "/")}`).href;
if (isMain) run(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exitCode = 1; });

import { describe, it, expect } from "vitest";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog, MockRuntime, ClaudeCodeRuntime, Factory, AgentBay, Tickets, createCore, git, createProject, projectOf, projectDetail, nextMoves, refuseMove, workDocument, ideaFromTicket, captureSignal, OrderEngine, ImproveCouncil, listSignals, RepoExplorer, ErrorCapture, errorFingerprint, scrub, isFault, classifyIntake, ensureSelfProject, selfProject, projectToTicket, linkToProject } from "../src/index.js";

const tmp = () => mkdtempSync(join(tmpdir(), "sf-tickets-"));

describe("tickets: the record", () => {
  it("opens a ticket of a kind, answers the required question from the description, and numbers from 1", () => {
    const log = new EventLog();
    const t = new Tickets(log);
    const a = t.open({ kind: "request", body: "Export the run history as CSV\n\nso I can chart spend." });
    expect(a.id).toBe(1);
    expect(a.title).toBe("Export the run history as CSV");
    expect(a.answers.need).toBe("Export the run history as CSV");
    expect(a.status).toBe("open");
    const b = t.open({ kind: "bug", title: "Bridge freezes", severity: "blocking", answers: { expected: "It answers", bogus: "x" } as any });
    expect(b.id).toBe(2);
    expect(b.answers).toEqual({ expected: "It answers" });
    expect(() => t.open({ kind: "task" })).toThrow(/title/);
    expect(t.notes(1)[0].text).toMatch(/Opened by you/);
  });

  it("edits one field and never resets the others; status only moves with a note", () => {
    const log = new EventLog();
    const t = new Tickets(log);
    const a = t.open({ kind: "task", title: "Add a dark theme", priority: "next", tags: ["ui"] });
    t.edit(a.id, "priority", "now");
    const after = t.get(a.id)!;
    expect(after.priority).toBe("now");
    expect(after.tags).toEqual(["ui"]);
    expect(after.title).toBe("Add a dark theme");
    t.edit(a.id, "answer", "Use the existing tokens", "you", "done");
    expect(t.get(a.id)!.answers.done).toBe("Use the existing tokens");
    expect(() => t.edit(a.id, "status", "closed")).toThrow(/status move/);
    expect(() => t.edit(a.id, "answer", "x", "you", "nope")).toThrow(/no question/);
    t.say(a.id, "Started on it", { status: "in_progress" });
    expect(t.get(a.id)!.status).toBe("in_progress");
    expect(t.notes(a.id).at(-1)).toMatchObject({ kind: "status", status: "in_progress", text: "Started on it" });
  });

  it("offers the status as the next move, and keeps taste and closed tickets in your hands", () => {
    expect(nextMoves("built", "bug").map((m) => m.to)).toEqual(["closed", "open"]);
    expect(nextMoves("closed", "bug").map((m) => m.to)).toEqual(["open"]);
    expect(nextMoves("open", "task").map((m) => m.to)).toEqual(["ready", "closed", "rejected"]);
    expect(refuseMove("idea", "built", "closed", "qa-rule")).toMatch(/only by you/);
    expect(refuseMove("idea", "built", "closed", "you")).toBeNull();
    expect(refuseMove("bug", "closed", "open", "builder")).toMatch(/never moves by itself/);
    const log = new EventLog();
    const t = new Tickets(log);
    const i = t.open({ kind: "idea", title: "A voice channel to the Overseer" });
    expect(() => t.say(i.id, "done", { status: "closed", by: "builder" })).toThrow(/only by you/);
  });

  it("links both ways, closes a duplicate, and keeps plan lines in order", () => {
    const log = new EventLog();
    const t = new Tickets(log);
    const a = t.open({ kind: "bug", title: "Crash on start" });
    const b = t.open({ kind: "bug", title: "Crash at launch" });
    t.link(b.id, a.id, "duplicate_of");
    expect(t.get(b.id)!.status).toBe("closed");
    expect(t.links(a.id)).toEqual([expect.objectContaining({ to: b.id, relation: "duplicated_by" })]);
    const plan = t.open({ kind: "plan", title: "Ship the export", answers: { goal: "CSV and JSON export" } });
    const l1 = t.open({ kind: "task", title: "CSV", parent: plan.id });
    const l2 = t.open({ kind: "task", title: "JSON", parent: plan.id });
    expect(t.lines(plan.id).map((l) => l.id)).toEqual([l1.id, l2.id]);
    t.moveLine(l2.id, "up");
    expect(t.lines(plan.id).map((l) => l.id)).toEqual([l2.id, l1.id]);
    const sub = t.open({ kind: "task", title: "CSV header row", parent: l1.id });
    expect(t.get(sub.id)!.level).toBe("subtask");
    expect(() => t.open({ kind: "task", title: "Too deep", parent: sub.id })).toThrow(/three levels/);
    expect(() => t.edit(l1.id, "parent", a.id)).toThrow(/has subtasks of its own/);
    expect(workDocument(t.get(plan.id)!, [], [], t.lines(plan.id))).toMatch(/1\. #\d+ JSON[\s\S]*2\. #\d+ CSV/);
    const s = t.spawn(a.id, { kind: "task", title: "Add a crash log" });
    expect(t.links(s.id)[0]).toMatchObject({ to: a.id, relation: "derived_from" });
  });

  it("finds by words in the thread and answers, and counts what waits for your look", () => {
    const log = new EventLog();
    const t = new Tickets(log);
    const a = t.open({ kind: "task", title: "Tidy the timeline", project: 7 });
    t.open({ kind: "task", title: "Something else", project: 8 });
    t.say(a.id, "The sparkline overlaps the legend");
    expect(t.list({ q: "sparkline" }).map((x) => x.id)).toEqual([a.id]);
    expect(t.list({ q: `#${a.id}` }).map((x) => x.id)).toEqual([a.id]);
    expect(t.list({ project: 8 }).map((x) => x.title)).toEqual(["Something else"]);
    t.say(a.id, "", { status: "built", by: "builder" });
    expect(t.list({ view: "look" }).map((x) => x.id)).toEqual([a.id]);
    expect(t.counts()).toMatchObject({ look: 1, open: 2, total: 2 });
  });

  it("the same fingerprint adds a note instead of a second ticket", () => {
    const log = new EventLog();
    const t = new Tickets(log);
    const a = t.open({ kind: "bug", title: "Flaky test", fingerprint: "qa:abc", by: "tester" });
    const b = t.open({ kind: "bug", title: "Flaky test", fingerprint: "qa:abc", by: "tester" });
    expect(b.id).toBe(a.id);
    expect(t.counts().total).toBe(1);
    expect(t.notes(a.id).at(-1)!.text).toMatch(/Seen again by tester/);
  });

  it("tables come back the same when rebuilt from the log", () => {
    const log = new EventLog();
    const t = new Tickets(log);
    const a = t.open({ kind: "plan", title: "P", answers: { goal: "g" } });
    t.open({ kind: "task", title: "L1", parent: a.id });
    t.say(a.id, "go", { status: "ready" });
    const before = log.db.prepare("SELECT * FROM tickets ORDER BY id").all();
    const notes = log.db.prepare("SELECT count(*) AS n FROM ticket_notes").get();
    log.rebuild("tickets");
    expect(log.db.prepare("SELECT * FROM tickets ORDER BY id").all()).toEqual(before);
    expect(log.db.prepare("SELECT count(*) AS n FROM ticket_notes").get()).toEqual(notes);
  });
});

describe("tickets: agents and the loop", () => {
  it("'work it' runs the factory on the ticket; a bug with green tests closes by the QA rule", async () => {
    const log = new EventLog();
    const rt = new MockRuntime();
    const bay = new AgentBay(log, rt);
    const f = new Factory(log, rt, tmp(), bay);
    const t = new Tickets(log, { runtime: rt, factory: f, bay });
    const bug = t.open({ kind: "bug", title: "A word counter that counts words", answers: { expected: "Counts words in a file" } });
    const { run } = t.work(bug.id, { autoApprove: true });
    expect(t.get(bug.id)!.status).toBe("in_progress");
    expect(t.get(bug.id)!.run).toBe(run);
    expect(() => t.work(bug.id)).toThrow(/already working/);
    await f.wait(run);
    const end = t.get(bug.id)!;
    expect(log.db.prepare("SELECT outcome FROM factory_runs WHERE id = ?").get(run)).toMatchObject({ outcome: "shipped" });
    expect(end.status).toBe("closed");
    const said = t.notes(bug.id).map((n) => `${n.by}: ${n.text}`);
    expect(said.some((s) => /^factory: Run #\d+ shipped/.test(s))).toBe(true);
    expect(said.at(-1)).toMatch(/^qa-rule: Closed by the QA rule/);
  }, 30_000);

  it("goes through the factory's duplicate check: a rework of its own run is fine, someone else's build of the same idea needs 'again'", async () => {
    const log = new EventLog();
    const rt = new MockRuntime();
    const bay = new AgentBay(log, rt);
    const f = new Factory(log, rt, tmp(), bay);
    const t = new Tickets(log, { runtime: rt, factory: f, bay });
    const a = t.open({ kind: "request", title: "A word counter", answers: { need: "Count words" } });
    const first = t.work(a.id, { autoApprove: true }).run;
    await f.wait(first);
    expect(t.get(a.id)!.status).toBe("built");
    // Not good yet: working it again reworks the ticket's own shipped run.
    t.say(a.id, "", { status: "open" });
    const second = t.work(a.id, { autoApprove: true }).run;
    await f.wait(second);
    // The same idea built outside the ticket today: refused, unless again.
    const b = t.open({ kind: "request", title: "A word counter", answers: { need: "Count words" } });
    const other = f.start(ideaFromTicket(t.get(b.id)!, t.document(b.id)), { autoApprove: true });
    await f.wait(other);
    let err: any;
    try { t.work(b.id); } catch (e) { err = e; }
    expect(err?.duplicate).toMatchObject({ duplicateOf: other, state: "shipped" });
    expect(t.work(b.id, { again: true, autoApprove: true }).run).toBeGreaterThan(other);
  }, 30_000);

  it("a request or a ticket with the hand brake stays built for your look", async () => {
    const log = new EventLog();
    const rt = new MockRuntime();
    const f = new Factory(log, rt, tmp());
    const t = new Tickets(log, { runtime: rt, factory: f });
    const req = t.open({ kind: "request", title: "A word counter", answers: { need: "count words" } });
    const task = t.open({ kind: "task", title: "A word counter too", answers: { todo: "count words" } });
    t.say(task.id, "Please don't close this one, I need a look");
    const r1 = t.work(req.id, { autoApprove: true }).run;
    await f.wait(r1);
    const r2 = t.work(task.id, { autoApprove: true }).run;
    await f.wait(r2);
    expect(t.get(req.id)!.status).toBe("built");
    expect(t.get(task.id)!.status).toBe("built");
    expect(t.notes(task.id).at(-1)!.text).toMatch(/thread asks for it/);
    // Closed by you; a late write-back never reopens it.
    t.say(req.id, "Good", { status: "closed" });
    log.append("factory.run.finished", { run: r1, outcome: "shipped", reason: "again" });
    expect(t.get(req.id)!.status).toBe("closed");
  }, 30_000);

  it("asking an agent puts its reply on the thread, capped, and may mark it ready", async () => {
    const log = new EventLog();
    const rt = new MockRuntime();
    const bay = new AgentBay(log, rt);
    const t = new Tickets(log, { runtime: rt, bay, budgetUsd: 0.05 });
    const a = t.open({ kind: "task", title: "Rename the Data vault tab", assignee: "planner" });
    const r = await t.ask(a.id);
    expect(r.reply).toBeTruthy();
    expect(rt.calls.at(-1)!.budgetUsd).toBeLessThanOrEqual(0.05);
    expect(rt.calls.at(-1)!.systemPrompt).toMatch(/Station contract: ticket/);
    expect(t.notes(a.id).at(-1)).toMatchObject({ kind: "reply", by: "planner" });
    expect(log.db.prepare("SELECT station FROM agent_runs ORDER BY rowid DESC LIMIT 1").get()).toMatchObject({ station: "ticket" });
  });

  it("opens tickets on its own: a failed run, a task the Order Engine files, a council proposal, a request event", () => {
    const log = new EventLog();
    const t = new Tickets(log);
    const started = log.append("factory.run.started", { idea: "a thing that breaks" });
    log.append("factory.run.finished", { run: started.id, outcome: "failed", reason: "tests never went green" });
    log.append("factory.run.finished", { run: started.id, outcome: "failed", reason: "again" });
    const bugs = t.list({ kind: "bug" });
    expect(bugs).toHaveLength(1);
    expect(bugs[0]).toMatchObject({ source: "factory", openedBy: "factory" });

    const node = log.append("order.node", { kind: "project", title: "Garden app", parentId: null });
    const sig = captureSignal(log, "we must add a frost alert", "bridge");
    log.append("order.fragment", { signalId: sig.id, text: "add a frost alert", kind: "task", nodeId: node.id, confidence: 0.9 });
    log.append("order.fragment", { signalId: sig.id, text: "frost is cold", kind: "note", nodeId: node.id, confidence: 0.9 });
    expect(t.list({ kind: "task" })).toEqual([expect.objectContaining({ title: "add a frost alert", project: node.id, source: "order" })]);

    log.append("improve.proposal.accepted" as any, { id: 41, title: "Show spend per project", body: "Spend is global today", lens: "ux", target: { kind: "project", id: node.id, title: "Garden app" } });
    const idea = t.list({ kind: "idea" })[0];
    expect(idea).toMatchObject({ title: "Show spend per project", project: node.id, source: "improve" });
    const linked = log.list({ type: "improve.proposal.linked" as any });
    expect(linked.map((e) => e.payload)).toEqual([{ id: 41, ticketId: idea.id }]);

    log.append("improve.proposal.accepted" as any, { id: 42, title: "Pin a dependency", body: "lodash floats", lens: "risk", target: { kind: "project", id: node.id }, source: { kind: "repo.suggestion", suggestionId: 9 } });
    expect(t.list({ q: "Pin a dependency" })[0]).toMatchObject({ kind: "task", fingerprint: "suggestion:9" });

    const req = log.append("ticket.requested", { title: "Pin lodash", kind: "task", source: "import-explore", fingerprint: "suggestion:10", ref: { repo: 3 } });
    const opened = log.list({ type: "ticket.opened" }).at(-1)!.payload as any;
    expect(opened).toMatchObject({ title: "Pin lodash", request: req.id, ref: { repo: 3 }, source: "import-explore" });
  });
});

describe("tickets: inside projects", () => {
  it("links a ticket to its project, shows on the project's page, and a run from it joins the project", async () => {
    const log = new EventLog();
    const rt = new MockRuntime();
    const f = new Factory(log, rt, tmp());
    const t = new Tickets(log, { runtime: rt, factory: f });
    const proj = createProject(log, { name: "Word tools" });
    const a = t.open({ kind: "task", title: "A word counter", project: proj, answers: { todo: "count words" } });
    expect(projectOf(log, { kind: "ticket", ref: a.id })).toBe(proj);
    const d = projectDetail(log, proj)!;
    expect((d.facets.tickets as any)).toMatchObject({ open: 1, total: 1 });
    const { run } = t.work(a.id, { autoApprove: true });
    await f.wait(run);
    expect(projectOf(log, { kind: "factory_run", ref: run })).toBe(proj);
    const other = createProject(log, { name: "Elsewhere" });
    t.edit(a.id, "project", other);
    expect(projectOf(log, { kind: "ticket", ref: a.id })).toBe(other);
  }, 30_000);
});

describe("tickets: working inside an imported repo", () => {
  it("works the ticket on a new branch of a clone, never touching the original, and leaves it built for your look", async () => {
    const log = new EventLog();
    const rt = new MockRuntime();
    const bay = new AgentBay(log, rt);
    const src = tmp();
    git(src, "init", "-q", "-b", "main");
    writeFileSync(join(src, "README.md"), "# Legacy app\n");
    git(src, "add", "-A"); git(src, "commit", "-q", "-m", "first");
    const head = git(src, "rev-parse", "HEAD");
    const proj = createProject(log, { name: "Legacy app" });
    log.append("project.linked", { projectId: proj, kind: "repo", ref: src });
    const work = tmp();
    const t = new Tickets(log, { runtime: rt, bay, workRoot: work, factory: new Factory(log, rt, tmp(), bay) });
    const a = t.open({ kind: "bug", title: "Login button does nothing", project: proj, answers: { expected: "It logs in" } });
    expect(t.detail(a.id)!.repo).toMatchObject({ dir: src });
    const r = t.work(a.id);
    expect(r.run).toBeNull();
    expect(t.get(a.id)!.status).toBe("in_progress");
    expect(() => t.work(a.id)).toThrow(/already working/);
    await t.waitRepo(a.id);
    const done = t.get(a.id)!;
    expect(done.status).toBe("built");
    expect(done.branch).toMatch(/^sf\/LA-1-login-button-does-nothing$/);
    const clone = done.branchDir!;
    expect(clone.startsWith(work)).toBe(true);
    expect(git(clone, "branch", "--show-current")).toBe(done.branch);
    expect(existsSync(join(clone, "docs/softwarefactory/ticket-1.md"))).toBe(true);
    // The original: same head, same branches, no new file, nothing pushed into it.
    expect(git(src, "rev-parse", "HEAD")).toBe(head);
    expect(git(src, "branch", "--list")).toBe("* main");
    expect(existsSync(join(src, "docs"))).toBe(false);
    expect(rt.calls.at(-1)!.cwd).toBe(clone);
    // The Builder's own skill (frontend-design) comes along: its kit folder and the Skill tool.
    expect(rt.calls.at(-1)!.pluginDirs?.some((d) => /skills-[0-9a-f]{12}$/.test(d))).toBe(true);
    expect(rt.calls.at(-1)!.tools).toEqual(["Read", "Edit", "Write", "Glob", "Grep", "Skill"]);
    expect(t.notes(a.id).at(-1)!.text).toMatch(/git fetch ".*" sf\/LA-1/);
    // A bug worked in a repo never closes by rule: no locked tests ran.
    expect(t.notes(a.id).some((n) => n.by === "qa-rule")).toBe(false);
    // Working it again reuses the clone and its branch.
    t.say(a.id, "Not yet", { status: "open" });
    t.work(a.id);
    await t.waitRepo(a.id);
    expect(t.get(a.id)!.branchDir).toBe(clone);
    // "new" still builds a fresh repo through the factory.
    expect(t.work(a.id, { where: "new", autoApprove: true }).run).toBeGreaterThan(0);
  }, 30_000);

  it("finds the repo of a project imported by the repo explorer, and works its ticket in a clone", async () => {
    const log = new EventLog();
    const rt = new MockRuntime({ delayMs: 0 });
    const src = tmp();
    git(src, "init", "-q", "-b", "main");
    writeFileSync(join(src, "index.js"), "console.log('hi')\n");
    git(src, "add", "-A"); git(src, "commit", "-q", "-m", "first");
    const ex = new RepoExplorer(log, rt, join(tmp(), "imports"));
    const { projectId, done } = ex.importRepo(src);
    await done;
    const t = new Tickets(log, { runtime: rt, workRoot: tmp() });
    const a = t.open({ kind: "task", title: "Say hello louder", project: projectId });
    expect(t.detail(a.id)!.repo).toMatchObject({ dir: src, branch: "main" });
    t.work(a.id);
    await t.waitRepo(a.id);
    expect(t.get(a.id)!.status).toBe("built");
    expect(t.get(a.id)!.branch).toMatch(/^sf\/[A-Z][A-Z0-9]*-1-say-hello-louder$/);
    expect(git(src, "status", "--porcelain")).toBe("");
    expect(git(src, "branch", "--list")).toBe("* main");
  }, 30_000);
});

describe("tickets: the real runtime in a working copy", () => {
  it("accepts file edits only when it runs in a folder with edit tools", () => {
    const rt = new ClaudeCodeRuntime({ command: "claude" });
    const a = rt.buildArgs({ prompt: "x", tools: ["Read", "Edit"], cwd: "/tmp/clone" });
    expect(a.join(" ")).toMatch(/--tools Read,Edit --permission-mode acceptEdits/);
    expect(rt.buildArgs({ prompt: "x", tools: ["Read", "Edit"] })).not.toContain("--permission-mode");
    expect(rt.buildArgs({ prompt: "x", cwd: "/tmp/clone" })).not.toContain("--permission-mode");
  });
});

describe("tickets: the API", () => {
  it("opens, reads, edits, talks and serves the work document over HTTP", async () => {
    const log = new EventLog();
    const core = createCore({ log, runtime: new MockRuntime(), projectsDir: tmp(), dropDir: tmp() });
    const server = createServer(core).listen(0);
    const port = (server.address() as { port: number }).port;
    const call = async (method: string, path: string, body?: unknown) => {
      const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      const ct = r.headers.get("content-type") ?? "";
      return { status: r.status, body: ct.includes("json") ? await r.json() : await r.text() };
    };
    try {
      const meta = await call("GET", "/api/tickets/meta");
      expect(meta.body.kinds.map((k: any) => k.code)).toEqual(["bug", "request", "task", "idea", "plan", "question"]);
      const made = await call("POST", "/api/tickets", { kind: "idea", title: "Tickets on the star map", project: 5 });
      expect(made.status).toBe(201);
      const id = made.body.id;
      expect((await call("POST", `/api/tickets/${id}/edit`, { field: "priority", value: "now" })).body.priority).toBe("now");
      expect((await call("POST", `/api/tickets/${id}/say`, { text: "Looks good", status: "ready" })).body.status).toBe("ready");
      const d = await call("GET", `/api/tickets/${id}`);
      expect(d.body.moves.map((m: any) => m.to)).toEqual(["in_progress", "closed", "rejected"]);
      expect(d.body.notes.map((n: any) => n.kind)).toEqual(["event", "status"]);
      const doc = await call("GET", `/api/tickets/${id}/document`);
      expect(doc.body).toMatch(/^# P5-1 Tickets on the star map/);
      const list = await call("GET", "/api/tickets?project=5");
      expect(list.body.tickets).toHaveLength(1);
      expect(list.body.counts.open).toBe(1);
      expect((await call("GET", "/api/tickets?project=6")).body.tickets).toHaveLength(0);
      expect((await call("POST", `/api/tickets/${id}/edit`, { field: "kind", value: "nope" })).status).toBe(400);
      expect((await call("GET", "/api/tickets/999")).status).toBe(404);
    } finally {
      server.close();
    }
  });
});

describe("tickets with the real Improvement Council", () => {
  it("an accepted proposal becomes a ticket, linked back to the proposal, and no task Signal is filed", async () => {
    const log = new EventLog();
    const rt = new MockRuntime();
    const bay = new AgentBay(log, rt);
    const order = new OrderEngine(log, null, { mode: "heuristic" });
    const t = new Tickets(log, { runtime: rt });
    const council = new ImproveCouncil(log, rt, bay, () => order.state(), {});
    const s = captureSignal(log, "Project: Photo renamer. It renames photos by date.", "bridge");
    await order.ingest({ id: s.id, text: s.text, source: "bridge" });
    await council.run();
    const p = council.proposals()[0];
    const before = listSignals(log).length;
    const acc = council.decide(p.id, "accepted");
    expect(acc.ticketId).toBeTypeOf("number");
    expect(listSignals(log)).toHaveLength(before);
    expect(t.get(acc.ticketId!)).toMatchObject({ title: p.title, source: "improve", kind: "idea", status: "open" });
  });
});

describe("tickets: errors become bugs", () => {
  const stackAt = (line: number) => `TypeError: Cannot read properties of undefined (reading 'title')\n    at TicketPage (http://127.0.0.1:5173/src/Tickets.tsx?t=17${line}:${line}:9)\n    at renderWithHooks (http://127.0.0.1:5173/node_modules/.vite/deps/react-dom.js:1:2)`;

  it("files one bug per error, says Seen again at most every ten minutes, and keeps secrets out", () => {
    const log = new EventLog();
    const t = new Tickets(log);
    let now = 1_000_000;
    const c = new ErrorCapture(log, t, { now: () => now });
    const a = c.capture({ message: "TypeError: Cannot read properties of undefined (reading 'title')", stack: stackAt(40), where: "bridge #/factory/tickets", from: "bridge", context: { token: "ghp_abcdefghijklmnopqrstuvwxyz0123456789", screen: "#/factory/tickets" } })!;
    expect(a.again).toBe(false);
    const bug = t.get(a.ticket)!;
    expect(bug).toMatchObject({ kind: "bug", source: "error", status: "open", tags: ["error", "bridge"] });
    expect(bug.title).toMatch(/^Error in bridge #\/factory\/tickets: TypeError/);
    expect(bug.body).toContain("Around it:");
    expect(bug.body).not.toContain("ghp_abc");
    // The same fault after an edit moved its line: still the same bug, and a note only once in ten minutes.
    expect(c.capture({ message: "TypeError: Cannot read properties of undefined (reading 'title')", stack: stackAt(52), where: "bridge #/p/3", from: "bridge" })).toEqual({ ticket: a.ticket, again: true });
    now += 60_000;
    c.capture({ message: "TypeError: Cannot read properties of undefined (reading 'title')", stack: stackAt(52), where: "bridge #/p/3", from: "bridge" });
    now += 10 * 60_000;
    c.capture({ message: "TypeError: Cannot read properties of undefined (reading 'title')", stack: stackAt(52), where: "bridge #/p/4", from: "bridge" });
    const seen = t.notes(a.ticket).filter((n) => n.text.startsWith("Seen again")).map((n) => n.text);
    expect(seen).toEqual(["Seen again in bridge #/p/4, 3 times since it was filed."]);
    now += 11 * 60_000;
    c.capture({ message: "TypeError: Cannot read properties of undefined (reading 'title')", stack: stackAt(60), where: "bridge #/p/5", from: "bridge" });
    expect(t.notes(a.ticket).filter((n) => n.text.startsWith("Seen again")).at(-1)!.text).toBe("Seen again in bridge #/p/5.");
    expect(t.list({ view: "all" })).toHaveLength(1);
  });

  it("a repeat after you closed it opens a new bug linked to the old; a rejected one stays quiet", () => {
    const log = new EventLog();
    const t = new Tickets(log);
    const c = new ErrorCapture(log, t);
    const one = c.capture({ message: "RangeError: Invalid time value", where: "GET /api/order/state" })!;
    t.say(one.ticket, "Fixed", { status: "closed" });
    const two = c.capture({ message: "RangeError: Invalid time value", where: "GET /api/order/state" })!;
    expect(two.again).toBe(false);
    expect(two.ticket).not.toBe(one.ticket);
    expect(t.get(two.ticket)!.body).toContain(`This happened before as #${one.ticket}`);
    expect(t.links(two.ticket).map((l) => l.to)).toContain(one.ticket);
    expect(t.get(one.ticket)!.status).toBe("closed");
    // The third time finds the newest one, not the closed one again.
    expect(c.capture({ message: "RangeError: Invalid time value", where: "GET /api/order/state" })!.ticket).toBe(two.ticket);
    const other = c.capture({ message: "Not a bug", where: "x" })!;
    t.say(other.ticket, "Expected", { status: "rejected" });
    expect(c.capture({ message: "Not a bug", where: "x" })).toEqual({ ticket: other.ticket, again: true });
    expect(t.list({ view: "all" })).toHaveLength(3);
  });

  it("files at most perHour new bugs an hour and says how many it held back", () => {
    const log = new EventLog();
    const t = new Tickets(log);
    let now = 0;
    const c = new ErrorCapture(log, t, { perHour: 2, now: () => now });
    for (let i = 0; i < 5; i++) c.capture({ message: `Error number ${i} in ${"abcde"[i]}`, where: `job ${"abcde"[i]}` });
    expect(t.list({ view: "all" })).toHaveLength(2);
    now += 3600_001;
    const r = c.capture({ message: "A new one", where: "job z" })!;
    expect(t.get(r.ticket)!.body).toContain("3 more errors were not filed in the last hour");
  });

  it("knows a fault from a sentence, and the fingerprint ignores numbers, quotes and lines", () => {
    expect(isFault(new TypeError("x"))).toBe(true);
    expect(isFault(new Error("A ticket needs a title"))).toBe(false);
    expect(isFault(new SyntaxError("Unexpected token"))).toBe(false);
    expect(errorFingerprint({ message: "No proposal #12 'a'" })).toBe(errorFingerprint({ message: "No proposal #345 'b'" }));
    expect(errorFingerprint({ message: "x", from: "core" })).not.toBe(errorFingerprint({ message: "x", from: "bridge" }));
    expect(scrub("Authorization: Bearer abcdefghijklmnop1234 and sk-ant-api03-abcdefghijklmnopqrstu and https://me:pw@github.com/x")).toBe("Authorization: Bearer [secret] and [key] and https://[secret]@github.com/x");
  });

  it("a fault in a route answers 500 and is a bug; a sentence stays a 400; the Bridge posts its own", async () => {
    const log = new EventLog();
    const core = createCore({ log, runtime: new MockRuntime(), projectsDir: tmp(), dropDir: tmp() });
    const server = createServer(core).listen(0);
    const port = (server.address() as { port: number }).port;
    const call = async (method: string, path: string, body?: unknown) => {
      const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      return { status: r.status, body: await r.json() };
    };
    try {
      expect((await call("POST", "/api/tickets", { kind: "bug" })).status).toBe(400);
      expect(core.tickets.list({ view: "all" })).toHaveLength(0);
      core.tickets.counts = () => { throw new TypeError("Cannot read properties of null (reading 'open')"); };
      const r = await call("GET", "/api/tickets?view=open");
      expect(r.status).toBe(500);
      expect(core.tickets.get(r.body.ticket)).toMatchObject({ kind: "bug", source: "error", tags: ["error", "core"] });
      expect(core.tickets.get(r.body.ticket)!.title).toBe("Error in GET /api/tickets: TypeError: Cannot read properties of null (reading 'open')");
      const b = await call("POST", "/api/tickets/capture", { message: "ReferenceError: foo is not defined", stack: "at Board (Tickets.tsx:3:1)", where: "bridge #/factory/tickets", context: { screen: "#/factory/tickets" }, project: null });
      expect(core.tickets.get(b.body.ticket)).toMatchObject({ kind: "bug", tags: ["error", "bridge"] });
    } finally { server.close(); }
  });
});

describe("tickets: an ask is not a project", () => {
  const setup = () => {
    const log = new EventLog();
    const order = new OrderEngine(log, null, { mode: "heuristic" });
    const node = (name: string) => order.createNode("project", name);
    const t = new Tickets(log);
    const make = (name: string, summary = "") => { const id = createProject(log, { name, kind: "app", summary }); linkToProject(log, id, "order_node", node(name)); return id; };
    return { log, order, node, t, make };
  };

  it("SoftwareFactory gets one project of its own, made once", () => {
    const { log, node } = setup();
    expect(selfProject(log)).toBeNull();
    const a = ensureSelfProject(log, node);
    expect(ensureSelfProject(log, node)).toBe(a);
    expect(projectDetail(log, a)).toMatchObject({ name: "SoftwareFactory", kind: "app", origin: "you" });
    expect(projectDetail(log, a)!.links.map((l) => l.kind).sort()).toEqual(["order_node", "self"]);
  });

  it("tells a new project from an ask about one you have, by words alone", () => {
    const { log, node, make } = setup();
    const self = ensureSelfProject(log, node);
    const garden = make("Garden planner");
    expect(classifyIntake(log, "UI/UX improvement of SoftwareFactory")).toMatchObject({ verdict: "ask", projectId: self, kind: "request", confidence: "high" });
    expect(classifyIntake(log, "Error handling and logs for all projects")).toMatchObject({ verdict: "ask", projectId: self, confidence: "high" });
    expect(classifyIntake(log, "The garden planner crashes when I add a bed")).toMatchObject({ verdict: "ask", projectId: garden, kind: "bug", confidence: "high" });
    expect(classifyIntake(log, "Improve the onboarding screens")).toMatchObject({ verdict: "ask", projectId: self, confidence: "low" });
    expect(classifyIntake(log, "a CLI that renames photos by the date they were taken")).toEqual({ verdict: "project" });
    expect(classifyIntake(log, "Build a new app that tracks my running, with better charts")).toEqual({ verdict: "project" });
    expect(classifyIntake(log, "Recipe box")).toEqual({ verdict: "project" });
    // A project read by its own name is not an ask about itself.
    const logs = make("Error handling and logs for all projects");
    expect(classifyIntake(log, "Error handling and logs for all projects")).toMatchObject({ projectId: logs });
    expect(classifyIntake(log, "Error handling and logs for all projects", logs)).toMatchObject({ verdict: "ask", projectId: self });
  });

  it("turns a project into a ticket on another: notes come along, things move, the project is archived", () => {
    const { log, order, node, t, make } = setup();
    const self = ensureSelfProject(log, node);
    const ux = make("UI/UX improvement of SoftwareFactory", "Make the Bridge easier to read");
    const uxNode = Number(projectDetail(log, ux)!.links.find((l) => l.kind === "order_node")!.ref);
    const sig = captureSignal(log, "bigger fonts on the star map", "bridge");
    log.append("order.fragment", { signalId: sig.id, text: "bigger fonts on the star map", kind: "note", nodeId: uxNode, confidence: 0.9 });
    const old = t.open({ kind: "bug", title: "Tabs wrap on a small window", project: ux });
    const r = projectToTicket(log, t, order.state(), ux, { to: self });
    expect(r.ticket).toMatchObject({ kind: "request", title: "UI/UX improvement of SoftwareFactory", project: self, status: "open" });
    expect(r.ticket.answers.need).toBe("Make the Bridge easier to read");
    expect(r.ticket.body).toContain("- bigger fonts on the star map");
    expect(r.ticket.body).toContain(`from the project "UI/UX improvement of SoftwareFactory" (#${ux})`);
    expect(t.get(old.id)!.project).toBe(self);
    // Its idea node folded into SoftwareFactory's, notes and all: one body on the star map.
    const selfNode = projectDetail(log, self)!.rootNodeIds[0];
    expect(order.state().nodes.find((n) => n.id === uxNode)!.mergedInto).toBe(selfNode);
    expect(order.state().fragments.find((f) => f.text === "bigger fonts on the star map")!.nodeId).toBe(selfNode);
    const was = projectDetail(log, ux)!;
    expect(was.status).toBe("archived");
    expect(was.summary).toMatch(new RegExp(`^Turned into ticket #${r.ticket.id} on SoftwareFactory`));
    // Twice is refused, and SoftwareFactory's own project stays a project.
    expect(() => projectToTicket(log, t, order.state(), ux, { to: self })).toThrow(/archived/);
    expect(() => projectToTicket(log, t, order.state(), self, { to: ux })).toThrow(/stays a project/);
  });

  it("over HTTP: the intake check, turning a project into a ticket, and errors filed under SoftwareFactory", async () => {
    const log = new EventLog();
    const core = createCore({ log, runtime: new MockRuntime(), projectsDir: tmp(), dropDir: tmp() });
    const server = createServer(core).listen(0);
    const port = (server.address() as { port: number }).port;
    const call = async (method: string, path: string, body?: unknown) => {
      const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      return { status: r.status, body: await r.json() };
    };
    try {
      const v = await call("POST", "/api/tickets/intake", { text: "Error handling and logs for all projects" });
      expect(v.body).toMatchObject({ verdict: "ask", projectName: "SoftwareFactory" });
      const self = (await call("GET", "/api/tickets/self")).body.projectId;
      expect(v.body.projectId).toBe(self);
      // Filed once, the same ask says where it already is.
      await call("POST", "/api/tickets", { kind: "request", title: "Error handling and logs for all projects", project: self });
      expect((await call("POST", "/api/tickets/intake", { text: "error handling and logs for all projects" })).body.existing).toMatchObject({ status: "open" });
      const made = await call("POST", "/api/projects", { name: "Error handling and logs for all projects" });
      const turned = await call("POST", `/api/tickets/from-project/${made.body.id}`, {});
      expect(turned.status).toBe(201);
      expect(turned.body.ticket).toMatchObject({ project: self, kind: "request" });
      const bug = await call("POST", "/api/tickets/capture", { message: "TypeError: x is undefined", where: "bridge #/" });
      expect(core.tickets.get(bug.body.ticket)!.project).toBe(self);
    } finally { server.close(); }
  });
});

import { describe, it, expect } from "vitest";
import { EventLog, Tickets, createProject, ensureSelfProject, keyFromName, refuseParent } from "../src/index.js";

describe("tickets: keys and numbers per project", () => {
  it("gives SoftwareFactory's own project the key SF and numbers each project from 1", () => {
    const log = new EventLog();
    const t = new Tickets(log);
    const self = ensureSelfProject(log);
    const garden = createProject(log, { name: "Garden planner" });
    const a = t.open({ kind: "bug", title: "Bridge freezes", project: self });
    const b = t.open({ kind: "task", title: "Water reminders", project: garden });
    const c = t.open({ kind: "task", title: "Dark theme", project: self });
    const loose = t.open({ kind: "idea", title: "No home yet" });
    expect([a.key, b.key, c.key]).toEqual(["SF-1", "GP-1", "SF-2"]);
    expect(loose.key).toBe(`#${loose.id}`);
    expect(t.byKey("sf-2")!.id).toBe(c.id);
    expect(t.byKey(`#${b.id}`)!.id).toBe(b.id);
    expect(t.list({ view: "all", q: "SF-1" }).map((x) => x.id)).toEqual([a.id]);
  });

  it("keeps the key when the project is renamed, and renumbers a ticket that moves project", () => {
    const log = new EventLog();
    const t = new Tickets(log);
    const one = createProject(log, { name: "Photo renamer" });
    const two = createProject(log, { name: "Expense CLI" });
    t.open({ kind: "task", title: "First", project: two });
    const a = t.open({ kind: "task", title: "Move me", project: one });
    expect(a.key).toBe("PR-1");
    const moved = t.edit(a.id, "project", two);
    expect(moved.key).toBe("EC-2");
    expect(t.notes(a.id).map((n) => n.text)).toContain("Was PR-1; now EC-2");
  });

  it("makes keys from names, and never hands out a taken one", () => {
    expect(keyFromName("SoftwareFactory")).toBe("SF");
    expect(keyFromName("photo renamer")).toBe("PR");
    expect(keyFromName("csv expense tracker cli tool")).toBe("CETC");
    expect(keyFromName("Garden", new Set(["GAR"]))).toBe("GAR2");
  });

  it("gives keys to projects whose tickets came before keys, and rebuilds the same from the log", () => {
    const log = new EventLog();
    const self = ensureSelfProject(log);
    // An old ticket: opened with no number and no key, as before keys existed.
    log.append("ticket.opened", { id: 1, kind: "bug", title: "Old one", project: self, by: "you", source: "you" });
    log.append("ticket.opened", { id: 2, kind: "bug", title: "Old two", project: self, by: "you", source: "you" });
    const t = new Tickets(log);
    expect(t.get(2)!.key).toBe("#2");
    expect(t.backfillKeys()).toBe(1);
    expect(t.get(2)!.key).toBe("SF-2");
    expect(t.open({ kind: "task", title: "New", project: self }).key).toBe("SF-3");
    log.rebuild("tickets");
    expect(new Tickets(log).list({ view: "all" }).map((x) => x.key).sort()).toEqual(["SF-1", "SF-2", "SF-3"]);
  });
});

describe("tickets: epic, ticket, subtask", () => {
  it("allows three levels in one project and refuses a fourth", () => {
    const log = new EventLog();
    const t = new Tickets(log);
    const p = createProject(log, { name: "Garden planner" });
    const epic = t.open({ kind: "plan", title: "Ship reminders", project: p });
    const tk = t.open({ kind: "task", title: "Schedule", parent: epic.id });
    const sub = t.open({ kind: "task", title: "Cron parser", parent: tk.id });
    expect([epic.level, t.get(tk.id)!.level, sub.level]).toEqual(["epic", "ticket", "subtask"]);
    expect(sub.project).toBe(p);
    expect(() => t.open({ kind: "task", title: "Deeper", parent: sub.id })).toThrow(/three levels/);
    expect(() => t.open({ kind: "plan", title: "Epic in epic", parent: epic.id })).toThrow(/epic sits at the top/);
    const other = createProject(log, { name: "Other" });
    expect(() => t.open({ kind: "task", title: "Elsewhere", project: other, parent: epic.id })).toThrow(/same project/);
    expect(() => t.edit(sub.id, "project", other)).toThrow(/whole epic/);
    expect(refuseParent({ kind: "task", project: 1, hasChildren: true }, { id: 9, kind: "bug", parentId: null, project: 1 })).toMatch(/subtasks of its own/);
    expect(t.list({ view: "plans", project: p }).map((x) => x.id)).toEqual([epic.id, tk.id, sub.id]);
  });

  it("counts an epic's done tickets and moves the epic to built when the last is done", () => {
    const log = new EventLog();
    const t = new Tickets(log);
    const epic = t.open({ kind: "plan", title: "Export" });
    const a = t.open({ kind: "task", title: "CSV", parent: epic.id });
    const b = t.open({ kind: "task", title: "JSON", parent: epic.id });
    t.say(a.id, "", { status: "closed" });
    expect(t.get(epic.id)!.children).toEqual({ total: 2, done: 1 });
    expect(t.get(epic.id)!.status).toBe("open");
    t.say(b.id, "", { status: "rejected" });
    expect(t.get(epic.id)!.status).toBe("built");
    expect(t.notes(epic.id).at(-1)!.text).toMatch(/All 2 tickets/);
    // An epic is taste: built waits for you, it never closes by itself.
    t.say(b.id, "", { status: "open" });
    expect(t.notes(epic.id).at(-1)!.text).toMatch(/reopened/);
    expect(t.get(epic.id)!.status).toBe("built");
  });
});

describe("tickets: blocked and waiting on you", () => {
  it("is blocked while a blocking ticket is open", () => {
    const log = new EventLog();
    const t = new Tickets(log);
    const a = t.open({ kind: "task", title: "Database first" });
    const b = t.open({ kind: "task", title: "Then the screen" });
    t.link(a.id, b.id, "blocks");
    expect(t.get(b.id)!.blocked).toBe(true);
    expect(t.get(a.id)!.blocked).toBe(false);
    t.say(a.id, "", { status: "closed" });
    expect(t.get(b.id)!.blocked).toBe(false);
  });

  it("lists what needs you across projects, each with the moves that answer it", () => {
    const log = new EventLog();
    const t = new Tickets(log);
    const self = ensureSelfProject(log);
    const built = t.open({ kind: "request", title: "Bigger fonts", project: self });
    t.say(built.id, "", { status: "built", by: "factory" });
    const q = t.open({ kind: "question", title: "Which theme?", answers: { ask: "Dark or light by default?" } });
    const idea = t.open({ kind: "idea", title: "Voice input", by: "council", source: "improve" });
    t.open({ kind: "idea", title: "My own idea" });
    t.open({ kind: "task", title: "Just a task" });
    const w = t.waiting();
    expect(w.map((x) => [x.ticket.id, x.need])).toEqual([[built.id, "look"], [q.id, "answer"], [idea.id, "decide"]]);
    expect(w[0].projectName).toBe("SoftwareFactory");
    expect(w[0].moves.map((m) => m.to)).toEqual(["closed", "open"]);
    expect(w[1].say).toBe("Dark or light by default?");
    expect(w[2].moves.map((m) => m.to)).toEqual(["ready", "rejected"]);
    expect(t.counts().you).toBe(3);
  });
});

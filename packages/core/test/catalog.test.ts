import { describe, expect, it } from "vitest";
import { EventLog } from "../src/index.js";
import { Tickets } from "../src/tickets/tickets.js";
import { createProject } from "../src/projects/service.js";
import { adoptScoutTickets, brandsOf, listCatalog, saveEntry, setEntryState } from "../src/configs/catalog.js";
import { coreDoor } from "../src/plugins/door.js";
import { profileProblems, resolveProfiles, saveProfile, assign } from "../src/configs/profiles.js";
import { autoWorkRefusal } from "../src/tickets/model.js";

const scout = "plugin:scout";

function setup() {
  const log = new EventLog();
  const project = createProject(log, { name: "SoftwareFactory" });
  const tickets = new Tickets(log);
  const open = (title: string, body: string) => tickets.open({ kind: "task", title, body, project, by: scout });
  return { log, tickets, project, open };
}

describe("the catalog", () => {
  it("spots brand names that tie tickets together", () => {
    expect(brandsOf("Scan skills with NVIDIA SkillSpector before installing them")).toEqual(["nvidia", "skillspector"]);
    expect(brandsOf("Add a PreToolUse hook that blocks skill-file patterns")).toEqual(["pretooluse"]);
    expect(brandsOf("Register an MCP server for the API")).toEqual([]);
  });

  it("adopts Scout's open tickets once: one entry per thing, duplicates merged and closed, all held from the crew", () => {
    const { log, tickets, open } = setup();
    const a = open("Tool from a video: Scan Claude skills with Nvidia SkillSpector before installing them", 'From the video "Nvidia SkillSpector" at 0:15: https://www.instagram.com/reel/X/\n\nA free Nvidia tool that checks a Claude skill.');
    const b = open("Workflow from a video: Register SkillSpector as an MCP server", 'From the video "Nvidia SkillSpector" at 0:24: https://www.instagram.com/reel/X/\n\nAdds SkillSpector as an MCP server.');
    const c = open("Workflow from a video: Add a blind peer-review gate between agents", 'From the video "LLM Council" at 0:46: G:\\x.mp4\n\nSeveral agents propose.');
    const mine = tickets.open({ kind: "task", title: "Not from Scout", project: a.project, by: "you" });
    const r = adoptScoutTickets(log, tickets);
    expect(r.entries).toHaveLength(2);
    expect(r.merged).toEqual([b.id]);
    const cat = listCatalog(log);
    const spector = cat.find((e) => e.ticket === a.id)!;
    expect(spector).toMatchObject({ kind: "tool", state: "proposed", merged: [b.id] });
    expect(spector.title).toBe("Scan Claude skills with Nvidia SkillSpector before installing them");
    expect(spector.source).toMatchObject({ kind: "scout", link: "https://www.instagram.com/reel/X/", video: "Nvidia SkillSpector", at: "0:15" });
    expect(cat.find((e) => e.ticket === c.id)?.kind).toBe("workflow");
    expect(tickets.get(b.id)!.status).toBe("closed");
    expect(tickets.get(a.id)!.tags).toContain("catalog");
    expect(tickets.get(mine.id)!.tags ?? []).not.toContain("catalog");
    expect(autoWorkRefusal({ ...tickets.get(a.id)!, status: "ready", size: "S" })).toMatch(/Waits in the catalog/);
    // A second start does nothing.
    expect(adoptScoutTickets(log, tickets).entries).toEqual([]);
  });

  it("Build it puts the ticket back in line; any other state keeps the crew off", () => {
    const { log, tickets, open } = setup();
    const t = open("Idea from a video: Use one lead agent", "x\n\ny");
    adoptScoutTickets(log, tickets);
    const id = listCatalog(log)[0].id;
    setEntryState(log, tickets, id, "building");
    expect(tickets.get(t.id)!.tags ?? []).not.toContain("catalog");
    expect(autoWorkRefusal({ ...tickets.get(t.id)!, status: "ready", size: "S" })).toBeNull();
    setEntryState(log, tickets, id, "dropped");
    expect(tickets.get(t.id)!.tags).toContain("catalog");
  });

  it("lets an add-on add a pick to the catalog with a held ticket", () => {
    const { log, tickets, project } = setup();
    const door = coreDoor({ log, tickets });
    const r = door.act("catalog.add", { title: "Try a council of five", body: "From the video...", kind: "technique", project, touches: ["council size"], source: { label: "Scout, video X", link: "https://y" } }, scout) as { entry: string; ticket: { id: number } };
    const e = listCatalog(log).find((x) => x.id === r.entry)!;
    expect(e).toMatchObject({ kind: "technique", touches: ["council size"], state: "proposed", ticket: r.ticket.id });
    expect(tickets.get(r.ticket.id)!.tags).toContain("catalog");
  });
});

describe("catalog entries in profiles", () => {
  it("refuses two entries that touch the same thing, and applies a ready entry's settings", () => {
    const log = new EventLog();
    const lead = saveEntry(log, { title: "One lead agent", touches: ["crew shape"] });
    const swarm = saveEntry(log, { title: "Agents claim tasks", touches: ["crew shape"] });
    const cheap = saveEntry(log, { title: "Haiku fixer", settings: [{ path: "agent.fixer.model", value: "haiku" }], state: "ready" });
    const entries = new Map(listCatalog(log).map((e) => [e.id, e]));
    expect(profileProblems({ id: "x", name: "X", settings: [], entries: [lead.id, swarm.id] }, { entries }).join(" ")).toMatch(/both touch crew shape/);
    expect(profileProblems({ id: "x", name: "X", settings: [{ path: "agent.fixer.model", value: "opus" }], entries: [cheap.id] }, { entries }).join(" ")).toMatch(/both touch agent.fixer.model/);
    saveProfile(log, { id: "trial", name: "Trial", settings: [], entries: [cheap.id, lead.id] }, "you", { entries });
    assign(log, "global", null, "trial");
    expect(resolveProfiles(log, {}).settings["agent.fixer.model"]).toMatchObject({ value: "haiku", why: "catalog: Haiku fixer" });
  });
});

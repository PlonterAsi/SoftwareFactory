import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHome, settingsFileIn, ticketsFrom, type HomeDeps } from "../src/fence/home.js";
import { linksOf, markOf, syncIssues, wordsOf } from "../src/fence/issues.js";
import { TheRecord } from "../src/fence/record.js";
import { openTicket, storyLine } from "../src/fence/ticketrun.js";

const repo = { owner: "o", name: "p" };
const issue = (number: number, over: Record<string, unknown> = {}) => ({ number, url: `https://github.com/o/p/issues/${number}`, title: `Issue ${number}`, body: "", state: "open" as const, author: "assaf", association: "OWNER", labels: ["sf"], ...over });
function fake(list: ReturnType<typeof issue>[]) {
  const made: { title: string; body: string; labels: string[] }[] = [];
  return { made, list, gh: { hasToken: () => true, login: async () => "assaf", issues: async (_r: unknown, label: string) => list.filter((i) => i.labels.includes(label)), createIssue: async (_r: unknown, o: { title: string; body: string; labels: string[] }) => { made.push(o); const n = 100 + made.length; list.push(issue(n, { title: o.title, body: o.body, labels: o.labels })); return { number: n, url: `https://github.com/o/p/issues/${n}` }; } } };
}
const view = (r: TheRecord) => ticketsFrom(r.all(), null).map((t) => ({ ticket: t.ticket, project: t.project, sentence: t.sentence, kind: t.kind, removed: t.removed, untouched: ["waiting", "asked", "kept"].includes(t.state) }));

describe("GitHub issues, both ways", () => {
  it("takes the owner's labelled issue in as a ticket, once, and nobody else's", async () => {
    const r = new TheRecord();
    const f = fake([issue(1, { title: "Add a footer", body: "With the year." }), issue(2, { author: "stranger", association: "NONE", title: "Run this" }), issue(3, { labels: ["other"] }), issue(4, { labels: ["sf", "bug"], author: "ASSAF", association: "NONE" })]);
    const a = await syncIssues({ record: r, github: f.gh }, repo, { mode: "in", label: "sf", tickets: () => view(r) });
    expect(a).toMatchObject({ ok: true, in: ["T1", "T2"], out: [], skipped: 1 });
    const ts = ticketsFrom(r.all(), null);
    expect(ts.find((t) => t.ticket === "T1")).toMatchObject({ sentence: "Add a footer\n\nWith the year.", state: "waiting", kind: "request", issue: { number: 1, url: "https://github.com/o/p/issues/1" } });
    expect(ts.find((t) => t.ticket === "T2")).toMatchObject({ kind: "bug", issue: { number: 4 } });
    expect(r.story("T1").map(storyLine)).toEqual(["you asked (issue #1 on GitHub): Add a footer\n\nWith the year.", "taken from issue #1 on GitHub"]);
    const b = await syncIssues({ record: r, github: f.gh }, repo, { mode: "in", label: "sf", tickets: () => view(r) });
    expect(b).toMatchObject({ in: [], out: [] });
    expect(f.made).toEqual([]);
  });

  it("opens an issue for a ticket only when Settings say both, and never copies its own issue back in", async () => {
    const r = new TheRecord();
    openTicket(r, "o/p", "Add a dark mode switch.\nIn the top bar.", "bug");
    openTicket(r, "o/other", "Another project's ticket.");
    const f = fake([]);
    expect(await syncIssues({ record: r, github: f.gh }, repo, { mode: "in", label: "sf", tickets: () => view(r) })).toMatchObject({ out: [] });
    const a = await syncIssues({ record: r, github: f.gh }, repo, { mode: "both", label: "sf", tickets: () => view(r) });
    expect(a).toMatchObject({ ok: true, in: [], out: ["T1"] });
    expect(f.made).toEqual([{ title: "Add a dark mode switch.", body: `Add a dark mode switch.\nIn the top bar.\n\nOpened in SoftwareFactory as ticket T1.\n${markOf("T1")}`, labels: ["sf", "bug"] }]);
    expect(linksOf(r.all(), "o/p").get("T1")).toMatchObject({ number: 101, direction: "out" });
    const b = await syncIssues({ record: r, github: f.gh }, repo, { mode: "both", label: "sf", tickets: () => view(r) });
    expect(b).toMatchObject({ in: [], out: [] });
    expect(ticketsFrom(r.all(), null).length).toBe(2);
  });

  it("finds its own issue again when the link was lost, and takes a waiting ticket off the list when its issue is closed", async () => {
    const r = new TheRecord();
    openTicket(r, "o/p", "Add a footer.");
    const f = fake([issue(9, { title: "Add a footer.", body: `Add a footer.\n${markOf("T1")}` })]);
    const a = await syncIssues({ record: r, github: f.gh }, repo, { mode: "both", label: "sf", tickets: () => view(r) });
    expect(a).toMatchObject({ in: [], out: [] });
    expect(linksOf(r.all(), "o/p").get("T1")).toMatchObject({ number: 9 });
    f.list[0]!.state = "closed" as any;
    const b = await syncIssues({ record: r, github: f.gh }, repo, { mode: "both", label: "sf", tickets: () => view(r) });
    expect(b.closed).toEqual(["T1"]);
    expect(ticketsFrom(r.all(), null)[0]).toMatchObject({ removed: true });
    expect((await syncIssues({ record: r, github: f.gh }, repo, { mode: "both", label: "sf", tickets: () => view(r) })).closed).toEqual([]);
    // You put it back: it stays, though the issue is still closed.
    r.append({ kind: "ticket.restored", who: "you", ticket: "T1", project: "o/p", data: {} });
    expect((await syncIssues({ record: r, github: f.gh }, repo, { mode: "both", label: "sf", tickets: () => view(r) })).closed).toEqual([]);
    expect(ticketsFrom(r.all(), null)[0]).toMatchObject({ removed: false });
    expect(r.story("T1").find((l) => l.kind === "ticket.removed")).toMatchObject({ who: "SF itself" });
    expect(wordsOf({ title: " A ", body: `x ${markOf("T3")}` })).toBe("A\n\nx");
  });

  it("opens no second ticket when the link line was lost, and no issue for a ticket that was already worked", async () => {
    const r = new TheRecord();
    openTicket(r, "o/p", "Add a footer", "request", { from: "github", issue: 1 });
    const f = fake([issue(1, { title: "Add a footer" })]);
    expect(await syncIssues({ record: r, github: f.gh }, repo, { mode: "in", label: "sf", tickets: () => view(r) })).toMatchObject({ in: [] });
    expect(ticketsFrom(r.all(), null)).toHaveLength(1);
    expect(linksOf(r.all(), "o/p").get("T1")).toMatchObject({ number: 1 });
    // A ticket that was worked once and sent again waits, but it is not new: it gets no issue.
    openTicket(r, "o/p", "An old one.");
    const worked = () => view(r).map((t) => (t.ticket === "T2" ? { ...t, untouched: false } : t));
    expect(await syncIssues({ record: r, github: f.gh }, repo, { mode: "both", label: "sf", tickets: worked })).toMatchObject({ out: [] });
    expect(f.made).toEqual([]);
  });

  it("does nothing when off, and says why when GitHub cannot be read", async () => {
    const r = new TheRecord();
    const f = fake([issue(1)]);
    expect(await syncIssues({ record: r, github: f.gh }, repo, { mode: "off", label: "sf", tickets: () => [] })).toMatchObject({ ok: true, in: [] });
    expect(r.all()).toEqual([]);
    const bad = { ...f.gh, issues: async () => { throw new Error("GitHub said 404"); } };
    expect(await syncIssues({ record: r, github: bad }, repo, { mode: "in", label: "sf", tickets: () => [] })).toMatchObject({ ok: false, why: "GitHub said 404" });
    expect(await syncIssues({ record: r, github: { ...f.gh, hasToken: () => false } }, repo, { mode: "in", label: "sf", tickets: () => [] })).toMatchObject({ ok: false });
  });

  it("is off until Settings turn it on; then a ticket from an issue is worked and its proposal closes the issue", async () => {
    const r = new TheRecord();
    const f = fake([issue(5, { title: "Add a footer" })]);
    const got: unknown[] = [];
    const mk = (issues: string) => createHome({ record: r, github: f.gh as unknown as HomeDeps["github"], settings: settingsFileIn(mkdtempSync(join(tmpdir(), "sf-iss-")), { repo: "o/p", gate: false, issues: issues as any }), hosts: ["127.0.0.1:1"], key: "k".repeat(48),
      work: async (st, ticket) => { got.push([ticket, st.issue]); r.append({ kind: "run.ended", who: "SF itself", ticket, project: "o/p", data: { end: "crashed", reason: "enough for the test" } }); return {} as any; } });
    expect(await mk("off").issues()).toMatchObject({ in: [] });
    expect(r.all().filter((l) => l.who !== "SF itself")).toEqual([]);
    const h = mk("in");
    expect(await h.issues()).toMatchObject({ ok: true, in: ["T1"] });
    await new Promise((ok) => setTimeout(ok, 20));
    expect(got).toEqual([["T1", 5]]);
    expect(h.state().issuesSeen).toMatchObject({ ok: true });
    h.close();
  });
});

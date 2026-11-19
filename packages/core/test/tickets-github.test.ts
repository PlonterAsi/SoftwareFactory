import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog, MockRuntime, Tickets, GitHub, createProject, git, parseGitHubRepo, hideTokens } from "../src/index.js";
import { ticketNumbersIn } from "../src/tickets/tickets.js";

const tmp = () => mkdtempSync(join(tmpdir(), "sf-gh-"));
const TOKEN = "github_pat_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6";

/** A stand-in for github.com: a bare repo for git, and a fake REST API that records what it was asked. */
function fakeGitHub(cli?: () => string | null) {
  const src = tmp();
  git(src, "init", "-q", "-b", "main");
  writeFileSync(join(src, "README.md"), "# App\n");
  git(src, "add", "-A"); git(src, "commit", "-q", "-m", "first");
  const bare = join(tmp(), "app.git");
  git(tmp(), "clone", "-q", "--bare", src, bare);
  const calls: { method: string; path: string; body?: any; auth?: string }[] = [];
  const state = { merged: false, closed: false, mergedList: [] as any[] };
  const fake = (async (url: string, init: any) => {
    const path = url.replace("https://api.github.com", "");
    calls.push({ method: init.method, path, body: init.body ? JSON.parse(init.body) : undefined, auth: init.headers.authorization });
    const ok = (j: unknown) => new Response(JSON.stringify(j), { status: 200, headers: { "content-type": "application/json" } });
    if (path === "/repos/acme/app") return ok({ permissions: { push: true } });
    if (path.startsWith("/repos/acme/app/pulls?state=closed")) return ok(state.mergedList);
    if (path.startsWith("/repos/acme/app/pulls?")) return ok([]);
    if (path === "/repos/acme/app/pulls" && init.method === "POST") return ok({ number: 7, html_url: "https://github.com/acme/app/pull/7", state: "open", draft: true });
    if (path === "/repos/acme/app/pulls/7") return ok({ number: 7, html_url: "https://github.com/acme/app/pull/7", state: state.merged || state.closed ? "closed" : "open", merged: state.merged, merge_commit_sha: state.merged ? "abc123" : null });
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  const gh = new GitHub({ dataDir: tmp(), fetch: fake, gitUrl: () => bare, cli });
  return { gh, bare, calls, state };
}

function setup(canShip: () => string | null = () => null) {
  const f = fakeGitHub();
  const log = new EventLog();
  const proj = createProject(log, { name: "Acme app" });
  log.append("project.linked", { projectId: proj, kind: "github", ref: "acme/app" });
  const t = new Tickets(log, { runtime: new MockRuntime({ delayMs: 0 }), workRoot: tmp(), github: f.gh, canShip });
  return { ...f, log, proj, t };
}

describe("tickets: the crew opens a PR", () => {
  it("pushes only the ticket's branch, opens a draft PR named by its key, and never writes the token anywhere", async () => {
    const { gh, bare, calls, log, proj, t } = setup();
    gh.setToken(TOKEN);
    const a = t.open({ kind: "task", title: "Say hello louder", project: proj });
    expect(t.detail(a.id)!.repo).toMatchObject({ github: { owner: "acme", name: "app" } });
    t.work(a.id);
    await t.waitRepo(a.id);
    const done = t.get(a.id)!;
    expect(done.status).toBe("built");
    expect(done.branch).toBe("sf/AA-1-say-hello-louder");
    expect(done.pr).toEqual({ repo: "acme/app", number: 7, url: "https://github.com/acme/app/pull/7", state: "open" });
    expect(git(bare, "branch", "--list").split("\n").map((b) => b.replace(/^[* ]+/, "")).sort()).toEqual(["main", "sf/AA-1-say-hello-louder"]);
    expect(git(bare, "log", "--oneline", "main")).toMatch(/^\w+ first$/);
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.body).toMatchObject({ head: "sf/AA-1-say-hello-louder", base: "main", draft: true, title: "AA-1: Say hello louder" });
    expect(post.auth).toBe(`Bearer ${TOKEN}`);
    const everything = JSON.stringify(log.db.prepare("SELECT * FROM events").all());
    expect(everything).not.toContain(TOKEN);
    expect(t.notes(a.id).at(-1)!.text).toMatch(/draft PR #7/);
    // The harness steps of that pass are on the ticket, each settled.
    const steps = t.detail(a.id)!.steps;
    expect(steps.length).toBeGreaterThan(1);
    expect(steps.every((x) => x.state !== "running")).toBe(true);
    expect(new Set(steps.map((x) => x.step)).size).toBe(steps.length);
  }, 30_000);

  it("moves the ticket on when its PR merges, and reopens it when the PR is closed unmerged", async () => {
    const { gh, state, proj, t } = setup();
    gh.setToken(TOKEN);
    const a = t.open({ kind: "task", title: "Merge me", project: proj });
    t.work(a.id); await t.waitRepo(a.id);
    expect(await t.followPrs()).toBe(0);
    state.merged = true;
    expect(await t.followPrs()).toBe(1);
    expect(t.get(a.id)!.status).toBe("closed");
    expect(t.get(a.id)!.pr!.state).toBe("merged");
    expect(await t.followPrs()).toBe(0);
  }, 30_000);

  it("keeps the branch on this computer when the crew may not ship, and says why", async () => {
    const { gh, calls, proj, t } = setup(() => "the practice crew never opens a PR");
    gh.setToken(TOKEN);
    const a = t.open({ kind: "task", title: "Practice", project: proj });
    t.work(a.id); await t.waitRepo(a.id);
    expect(t.get(a.id)!.pr).toBeNull();
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
    expect(t.notes(a.id).map((n) => n.text).join("\n")).toMatch(/stays on this computer: the practice crew/);
  }, 30_000);

  it("sends a built branch on your press with this PC's own Git sign-in, and hands over the address that starts the PR", async () => {
    const { bare, calls, proj, t } = setup();
    const a = t.open({ kind: "task", title: "No token yet", project: proj });
    t.work(a.id); await t.waitRepo(a.id);
    expect(t.get(a.id)!).toMatchObject({ status: "built", pr: null, pushedUrl: null });
    expect(t.notes(a.id).map((n) => n.text).join("\n")).toMatch(/Press Send to GitHub/);
    expect(git(bare, "branch", "--list")).not.toMatch(/sf\/AA-1/);
    const sent = await t.send(a.id);
    expect(sent.pushedUrl).toBe("https://github.com/acme/app/compare/main...sf%2FAA-1-no-token-yet?expand=1");
    expect(git(bare, "branch", "--list").split("\n").map((b) => b.replace(/^[* ]+/, "")).sort()).toEqual(["main", "sf/AA-1-no-token-yet"]);
    expect(git(bare, "log", "--oneline", "main")).toMatch(/^\w+ first$/);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
    expect(sent.status).toBe("built");
  }, 30_000);

  it("a repo imported from GitHub is a GitHub repo: built from its copy on this computer, sent to GitHub on your press", async () => {
    const f = fakeGitHub();
    const log = new EventLog();
    const proj = createProject(log, { name: "Acme app", kind: "imported" });
    const copy = join(tmp(), "acme-app");
    git(tmp(), "clone", "-q", f.bare, copy);
    log.append("repo.import.started", { projectId: proj, source: "https://github.com/acme/app", local: false, dir: copy });
    log.append("repo.imported", { projectId: proj, source: "https://github.com/acme/app", local: false, dir: copy, branch: "main", head: git(copy, "rev-parse", "HEAD") });
    const t = new Tickets(log, { runtime: new MockRuntime({ delayMs: 0 }), workRoot: tmp(), github: f.gh, canShip: () => null });
    const a = t.open({ kind: "task", title: "From the import", project: proj });
    expect(t.detail(a.id)!.repo).toMatchObject({ dir: copy, github: { owner: "acme", name: "app" } });
    t.work(a.id); await t.waitRepo(a.id);
    const built = t.get(a.id)!;
    expect(built).toMatchObject({ status: "built", pr: null, pushedUrl: null });
    // Built from the copy the import already made (no sign-in needed), not from GitHub.
    expect(git(built.branchDir!, "remote", "get-url", "origin")).toBe(copy);
    expect(t.notes(a.id).map((n) => n.text).join("\n")).toMatch(/Press Send to GitHub/);
    const sent = await t.send(a.id);
    expect(sent.pushedUrl).toBe(`https://github.com/acme/app/compare/main...${encodeURIComponent(built.branch!)}?expand=1`);
    expect(git(f.bare, "branch", "--list").split("\n").map((b) => b.replace(/^[* ]+/, "")).sort()).toEqual(["main", built.branch]);
    expect(git(copy, "branch", "--list")).not.toMatch(/sf\//);
    // A folder on this computer that was imported stays a folder: Add to my folder, never GitHub.
    const proj2 = createProject(log, { name: "Local one", kind: "imported" });
    log.append("repo.import.started", { projectId: proj2, source: copy, local: true, dir: copy });
    log.append("repo.imported", { projectId: proj2, source: copy, local: true, dir: copy, branch: "main", head: git(copy, "rev-parse", "HEAD") });
    expect(t.detail(t.open({ kind: "task", title: "Local", project: proj2 }).id)!.repo!.github).toBeUndefined();
  }, 30_000);

  it("turns a branch built before the token into a draft PR on your press, and refuses for the practice crew", async () => {
    let why: string | null = null;
    const { gh, proj, t } = setup(() => why);
    const a = t.open({ kind: "task", title: "Token later", project: proj });
    t.work(a.id); await t.waitRepo(a.id);
    why = "the practice crew never opens a PR";
    await expect(t.send(a.id)).rejects.toThrow(/Not sent: the practice crew/);
    why = null;
    gh.setToken(TOKEN);
    const sent = await t.send(a.id);
    expect(sent.pr).toEqual({ repo: "acme/app", number: 7, url: "https://github.com/acme/app/pull/7", state: "open" });
    await expect(t.send(a.id)).rejects.toThrow(/already has pull request #7/);
    const b = t.open({ kind: "task", title: "Never worked", project: proj });
    await expect(t.send(b.id)).rejects.toThrow(/no branch yet/);
  }, 30_000);

  it("never pushes to main, keeps tokens out of text, and reads repo names", async () => {
    const { gh } = setup();
    gh.setToken(TOKEN);
    await expect(gh.openPr({ repo: { owner: "acme", name: "app" }, dir: tmp(), branch: "main", base: "main", title: "x", body: "" })).rejects.toThrow(/never pushes to main/);
    expect(() => gh.setToken("hunter2")).toThrow(/does not look like a GitHub token/);
    expect(hideTokens(`failed with ${TOKEN}`)).toBe("failed with [token]");
    expect(parseGitHubRepo("https://github.com/PlonterAsi/SoftwareFactory.git")).toEqual({ owner: "PlonterAsi", name: "SoftwareFactory" });
    expect(parseGitHubRepo("PlonterAsi/SoftwareFactory")).toEqual({ owner: "PlonterAsi", name: "SoftwareFactory" });
    expect(await gh.check({ owner: "acme", name: "app" })).toEqual({ ok: true });
  });
});

describe("tickets: the crew uses this PC's GitHub CLI login", () => {
  const CLI = "gho_" + "Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4";

  it("opens the PR with the GitHub CLI login when no token is pasted, and writes it nowhere", async () => {
    const f = fakeGitHub(() => CLI + "\n");
    expect(f.gh.hasToken()).toBe(true);
    expect(f.gh.tokenSource()).toBe("gh");
    const log = new EventLog();
    const proj = createProject(log, { name: "Acme app" });
    log.append("project.linked", { projectId: proj, kind: "github", ref: "acme/app" });
    const t = new Tickets(log, { runtime: new MockRuntime({ delayMs: 0 }), workRoot: tmp(), github: f.gh, canShip: () => null });
    const a = t.open({ kind: "task", title: "Say hello louder", project: proj });
    t.work(a.id);
    await t.waitRepo(a.id);
    expect(t.get(a.id)!.pr?.number).toBe(7);
    expect(f.calls.find((c) => c.method === "POST")!.auth).toBe(`Bearer ${CLI}`);
    expect(JSON.stringify(log.db.prepare("SELECT * FROM events").all())).not.toContain(CLI);
  });

  it("prefers a pasted token over the GitHub CLI login", () => {
    const { gh } = fakeGitHub(() => CLI);
    gh.setToken(TOKEN);
    expect(gh.tokenSource()).toBe("pasted");
  });

  it("has no access when the GitHub CLI gives nothing usable", () => {
    expect(fakeGitHub(() => "not a token").gh.hasToken()).toBe(false);
    expect(fakeGitHub(() => { throw new Error("gh is not installed"); }).gh.tokenSource()).toBe(null);
    expect(fakeGitHub().gh.hasToken()).toBe(false);
  });
});

describe("tickets: work merged outside the crew's own PR", () => {
  const merged = (number: number, title: string, branch = "claude/some-thread", at = "2099-01-01T00:00:00Z") => ({ number, title, html_url: `https://github.com/acme/app/pull/${number}`, state: "closed", merged_at: at, merge_commit_sha: `sha${number}`, head: { ref: branch } });

  it("reads the ticket numbers a title or branch names", () => {
    expect(ticketNumbersIn("Each agent loads only its own skills (SF-13)", "SF")).toEqual([13]);
    expect(ticketNumbersIn("Apply the adopt-now set (SF-16, 17, 18, 20, 21, 22) (#61)", "SF")).toEqual([16, 17, 18, 20, 21, 22]);
    expect(ticketNumbersIn("fix\nsf/SF-24-h3-test-integrity-guard", "SF")).toEqual([24]);
    expect(ticketNumbersIn("SF-3 and SF-4: seat a drafted agent", "SF")).toEqual([3, 4]);
    expect(ticketNumbersIn("SF-57/58 scanner false positives", "SF")).toEqual([57, 58]);
    expect(ticketNumbersIn("Update to v0.2.13, WSF-9, SF-x", "SF")).toEqual([]);
  });

  it("links a merged PR that names a ticket, closes work kinds, leaves taste kinds for your look, without a token", async () => {
    const { state, calls, proj, t } = setup();
    const task = t.open({ kind: "task", title: "Trim test output", project: proj });
    const ask = t.open({ kind: "request", title: "Own skills per agent", project: proj });
    const other = t.open({ kind: "task", title: "Not named", project: proj });
    state.mergedList = [merged(61, `Apply the set (${task.key}, ${ask.number})`), { ...merged(62, `${other.key}: closed unmerged`), merged_at: null }];
    expect(await t.followMerges()).toBe(2);
    expect(t.get(task.id)).toMatchObject({ status: "closed", pr: { number: 61, state: "merged", url: "https://github.com/acme/app/pull/61" } });
    expect(t.get(ask.id)).toMatchObject({ status: "built", pr: { number: 61 } });
    expect(t.get(other.id)!.status).toBe("open");
    expect(calls.at(-1)!.auth).toBeUndefined();
    expect(t.notes(task.id).at(-1)!.text).toMatch(/PR #61 .* names this ticket and was merged/);
  });

  it("counts each PR once per ticket: a ticket you reopen stays open, and a second PR links too", async () => {
    const { state, proj, t } = setup();
    const a = t.open({ kind: "task", title: "Twice", project: proj });
    state.mergedList = [merged(58, `First part (${a.key})`, "x", "2099-01-01T00:00:00Z")];
    expect(await t.followMerges()).toBe(1);
    t.say(a.id, "Not done yet", { status: "open" });
    expect(await t.followMerges()).toBe(0);
    expect(t.get(a.id)!.status).toBe("open");
    state.mergedList = [merged(59, "Follow-up", `sf/${a.key}-follow-up`, "2099-01-02T00:00:00Z"), ...state.mergedList];
    expect(await t.followMerges()).toBe(1);
    expect(t.get(a.id)).toMatchObject({ status: "closed", pr: { number: 59 } });
    expect(await t.followMerges()).toBe(0);
  });

  it("links a PR you name by number or address: merged moves the ticket now, open is followed until it merges", async () => {
    const { gh, state, proj, t } = setup();
    const a = t.open({ kind: "bug", title: "Fixed elsewhere", project: proj });
    expect((await t.linkPr(a.id, "https://github.com/acme/app/pull/7")).pr).toMatchObject({ number: 7, state: "open" });
    expect(t.get(a.id)!.status).toBe("open");
    gh.setToken(TOKEN);
    state.merged = true;
    expect(await t.followPrs()).toBe(1);
    expect(t.get(a.id)!.status).toBe("closed");
    const b = t.open({ kind: "bug", title: "Already in", project: proj });
    expect(await t.linkPr(b.id, "#7")).toMatchObject({ status: "closed", pr: { number: 7, state: "merged" } });
    await expect(t.linkPr(b.id, "soon")).rejects.toThrow(/number/);
  });

  it("leaves a ticket alone when it was opened after the PR merged", async () => {
    const { state, proj, t } = setup();
    const a = t.open({ kind: "task", title: "Later", project: proj });
    state.mergedList = [merged(5, `Old work ${a.key}`, "x", "2020-01-01T00:00:00Z")];
    expect(await t.followMerges()).toBe(0);
    expect(t.get(a.id)!.status).toBe("open");
  });
});

import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog, MockRuntime, Tickets, GitHub, GitManager, createProject, git, reviewMerge, releaseNotes, nextVersion, suggestBump, highest } from "../src/index.js";

const tmp = () => mkdtempSync(join(tmpdir(), "sf-git-"));
const TOKEN = "github_pat_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6";
const ok = (j: unknown) => new Response(JSON.stringify(j), { status: 200, headers: { "content-type": "application/json" } });

/** A stand-in for github.com: one bare repo (acme/app) and a REST API that answers what the git manager asks. */
function fakeGitHub() {
  const bare = join(tmp(), "app.git");
  git(tmp(), "init", "-q", "--bare", bare);
  const calls: { method: string; path: string; body?: any }[] = [];
  const s = {
    created: false, ci: "success" as "success" | "failure" | null, draft: true, merged: false, files: ["src/greet.js"], additions: 12, deletions: 3,
    recent: [] as any[], commits: [] as any[],
  };
  const pr7 = () => ({ number: 7, html_url: "https://github.com/acme/app/pull/7", state: s.merged ? "closed" : "open", merged: s.merged, merge_commit_sha: s.merged ? "m3rg3d" : null, draft: s.draft,
    head: { sha: "h3ad", ref: "sf/AA-1-say-hello" }, base: { ref: "main" }, node_id: "PR_7", user: { login: "sf-crew" }, additions: s.additions, deletions: s.deletions, changed_files: s.files.length, title: "AA-1: Say hello" });
  const fake = (async (url: string, init: any) => {
    const path = url.replace("https://api.github.com", "");
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method: init.method, path, body });
    if (path === "/user/repos" && init.method === "POST") { s.created = true; return ok({ name: body.name, owner: { login: "acme" }, html_url: `https://github.com/acme/${body.name}`, private: body.private }); }
    if (path === "/repos/acme/app") return ok({ default_branch: "main", permissions: { push: true } });
    if (path === "/repos/acme/app/pulls/7") return ok(pr7());
    if (path === "/repos/acme/app/pulls/7/files?per_page=100") return ok(s.files.map((filename) => ({ filename })));
    if (path === "/repos/acme/app/pulls/7/merge" && init.method === "PUT") { s.merged = true; return ok({ sha: "m3rg3d", merged: true }); }
    if (path.startsWith("/repos/acme/app/pulls?state=all")) return ok(s.recent);
    if (path.startsWith("/repos/acme/app/pulls?")) return ok([]);
    if (path === "/repos/acme/app/pulls" && init.method === "POST") return ok(pr7());
    if (path.startsWith("/repos/acme/app/commits/h3ad/check-runs")) return ok({ check_runs: s.ci ? [{ name: "build", status: "completed", conclusion: s.ci }] : [{ name: "build", status: "in_progress", conclusion: null }] });
    if (path.startsWith("/repos/acme/app/commits/h3ad/status")) return ok({ statuses: [] });
    if (path.startsWith("/repos/acme/app/commits?")) return ok(s.commits);
    if (path === "/repos/acme/app/releases" && init.method === "POST") return ok({ html_url: `https://github.com/acme/app/releases/tag/${body.tag_name}` });
    if (path === "/graphql") { s.draft = false; return ok({ data: {} }); }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  const gh = new GitHub({ dataDir: tmp(), fetch: fake, gitUrl: () => bare });
  gh.setToken(TOKEN);
  return { gh, bare, calls, s };
}

/** A project whose code is a folder on this computer (a repo link), not on GitHub yet. */
function localProject() {
  const dir = tmp();
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "index.js"), "console.log('hi')\n");
  git(dir, "add", "-A"); git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "first");
  const log = new EventLog();
  const proj = createProject(log, { name: "App" });
  log.append("project.linked", { projectId: proj, kind: "repo", ref: dir });
  return { log, proj, dir };
}

describe("git manager: local first, then a private repo", () => {
  it("publishes a local project to a new private repo, links it, and works its tickets there from then on", async () => {
    const f = fakeGitHub();
    const { log, proj, dir } = localProject();
    const t = new Tickets(log, { runtime: new MockRuntime({ delayMs: 0 }), workRoot: tmp(), github: f.gh, canShip: () => null });
    const g = new GitManager(log, t, { github: f.gh, canShip: () => null });
    const before = g.status(proj);
    expect(before).toMatchObject({ where: "local", localDir: dir, policy: "ask", cannotPublish: null, repo: null });
    const after = await g.verdict(proj, "continue", "People want it");
    expect(f.calls.find((c) => c.path === "/user/repos")!.body).toMatchObject({ name: "App", private: true });
    expect(after).toMatchObject({ where: "github", repo: "acme/App", private: true, verdict: { verdict: "continue", why: "People want it" } });
    expect(git(f.bare, "log", "--oneline", "main")).toMatch(/first/);
    // The project's tickets now go to that repo as PRs.
    const a = t.open({ kind: "task", title: "Say hello", project: proj });
    expect(t.detail(a.id)!.repo).toMatchObject({ github: { owner: "acme", name: "App" } });
    await expect(g.publish(proj)).rejects.toThrow(/already on GitHub/);
  });

  it("park pauses and drop archives a project, each with its reasons", async () => {
    const { log, proj } = localProject();
    const g = new GitManager(log, new Tickets(log, {}), {});
    await g.verdict(proj, "park", "Not now");
    expect((log.db.prepare("SELECT status FROM projects WHERE id = ?").get(proj) as any).status).toBe("paused");
    expect(g.status(proj).verdict).toMatchObject({ verdict: "park", why: "Not now" });
    await g.verdict(proj, "drop");
    expect((log.db.prepare("SELECT status FROM projects WHERE id = ?").get(proj) as any).status).toBe("archived");
  });
});

describe("git manager: the merge policy", () => {
  function onGitHub() {
    const f = fakeGitHub();
    const log = new EventLog();
    const proj = createProject(log, { name: "Acme app" });
    log.append("project.linked", { projectId: proj, kind: "github", ref: "acme/app" });
    const t = new Tickets(log, { runtime: new MockRuntime({ delayMs: 0 }), workRoot: tmp(), github: f.gh, canShip: () => null });
    const g = new GitManager(log, t, { github: f.gh, canShip: () => null });
    // A crew ticket with its draft PR #7, as the crew leaves it, and its harness steps passed.
    const a = t.open({ kind: "task", title: "Say hello", project: proj, body: "Print hello on start, and the test checks it." });
    log.append("ticket.pr", { id: a.id, by: "factory", repo: "acme/app", number: 7, url: "https://github.com/acme/app/pull/7", branch: "sf/AA-1-say-hello", state: "open" });
    for (const step of ["gates", "tests", "review"]) log.append("ticket.step", { id: a.id, key: a.key, step, state: "passed", note: "" });
    return { ...f, log, proj, t, g, a };
  }

  it("reviews a PR once its CI ends, waits on Needs you under ask, and merges on your press", async () => {
    const { g, t, a, s, calls, proj } = onGitHub();
    s.ci = null;
    expect((await g.check(a.id))!.ci).toBe("running");
    expect(t.board().lanes.review.map((c) => c.id)).toContain(a.id);
    s.ci = "success";
    expect(await g.tend()).toMatchObject({ merged: 0 });
    const c = g.mergeCheck(a.id)!;
    expect(c).toMatchObject({ ci: "green", confident: true, score: 100 });
    const card = t.board().lanes.needs.find((x) => x.id === a.id)!;
    expect(card).toMatchObject({ need: "merge", merge: { confident: true, number: 7 } });
    const done = await g.merge(a.id);
    expect(done.status).toBe("closed");
    expect(done.pr).toMatchObject({ state: "merged" });
    expect(calls.find((x) => x.path === "/graphql")).toBeTruthy(); // a draft is marked ready first
    expect(calls.find((x) => x.path.endsWith("/merge"))!.body).toMatchObject({ merge_method: "squash", sha: "h3ad" });
    expect(g.status(proj)).toMatchObject({ streak: 1, merges: 1, offerAuto: false });
  });

  it("does not call a big PR, one touching CI files, or one with a red CI confident; never merges red CI", async () => {
    const { g, a, s } = onGitHub();
    s.files = Array.from({ length: 20 }, (_, i) => `src/f${i}.js`).concat(".github/workflows/ci.yml");
    const c = (await g.check(a.id))!;
    expect(c.confident).toBe(false);
    expect(c.reasons.filter((r) => !r.ok).map((r) => r.key).sort()).toEqual(["sensitive", "size"]);
    s.ci = "failure";
    expect((await g.check(a.id))!.ci).toBe("red");
    await expect(g.merge(a.id)).rejects.toThrow(/CI failed/);
  });

  it("merges by itself under auto on a confident review, and goes back to ask when a merge was not right", async () => {
    const { g, a, proj, t } = onGitHub();
    g.setPolicy(proj, "auto");
    expect(await g.tend()).toMatchObject({ merged: 1 });
    expect(t.get(a.id)!.status).toBe("closed");
    expect(t.notes(a.id).at(-1)!.text).toMatch(/SF merged PR #7/);
    const back = g.notRight(a.id, "It broke the login")!;
    expect(back).toMatchObject({ policy: "ask", streak: 0 });
  });

  it("never merges by itself under ask, nor a taste ticket under auto", () => {
    const r = reviewMerge({ ci: { state: "green", failed: [], total: 1 }, steps: [{ step: "review", state: "passed" }, { step: "tests", state: "passed" }], files: ["a.js"], lines: 5, kind: "request", decisions: [], crew: true });
    expect(r.confident).toBe(false);
    expect(r.reasons.find((x) => x.key === "taste")!.ok).toBe(false);
    const money = reviewMerge({ ci: { state: "green", failed: [], total: 1 }, steps: [{ step: "review", state: "passed" }, { step: "tests", state: "passed" }], files: ["a.js"], lines: 5, kind: "task", decisions: ["money"], crew: true });
    expect(money.reasons.find((x) => x.key === "decisions")).toMatchObject({ ok: false, text: "Your call on money" });
  });
});

describe("git manager: outside work and versions", () => {
  function onGitHub() {
    const f = fakeGitHub();
    const log = new EventLog();
    const proj = createProject(log, { name: "Acme app" });
    log.append("project.linked", { projectId: proj, kind: "github", ref: "acme/app" });
    const t = new Tickets(log, { github: f.gh });
    const g = new GitManager(log, t, { github: f.gh });
    return { ...f, log, proj, t, g };
  }

  it("remembers where a repo stands on the first look, then turns outside PRs and commits into tickets", async () => {
    const { g, t, s, proj } = onGitHub();
    const named = t.open({ kind: "bug", title: "Logo is blurry", project: proj });
    expect(await g.watch(proj)).toBe(0);
    const since = g.status(proj).watchedAt!;
    const later = new Date(Date.parse(since) + 60_000).toISOString();
    s.recent = [
      { number: 11, title: `Fix ${named.key}: sharper logo`, state: "closed", merged_at: later, merge_commit_sha: "aaa1", html_url: "https://github.com/acme/app/pull/11", head: { ref: "fix-logo" }, user: { login: "dana" }, updated_at: later, created_at: later },
      { number: 12, title: "Add a dark theme", state: "open", html_url: "https://github.com/acme/app/pull/12", head: { ref: "dark" }, user: { login: "dana" }, updated_at: later, created_at: later },
    ];
    s.commits = [
      { sha: "aaa1", commit: { message: `Fix ${named.key}: sharper logo (#11)`, committer: { date: later } }, author: { login: "dana" } },
      { sha: "bbb2", commit: { message: "Typo in README", committer: { date: later } }, author: { login: "dana" } },
    ];
    expect(await g.watch(proj)).toBe(3);
    expect(t.get(named.id)!.status).toBe("closed"); // merged outside, as with any merge that names it
    const outside = t.list({ view: "all", project: proj }).filter((x) => x.source === "outside");
    expect(outside.map((x) => x.title).sort()).toEqual(["Add a dark theme", "Typo in README"]);
    expect(outside.find((x) => x.title === "Typo in README")!.status).toBe("closed");
    expect(outside.find((x) => x.title === "Add a dark theme")!.pr).toMatchObject({ number: 12, state: "open" });
    // Seen once: the next look adds nothing.
    expect(await g.watch(proj)).toBe(0);
  });

  it("cuts a version from merged tickets with notes and a GitHub release, and the next one starts after it", async () => {
    const { g, t, log, proj, s: gh } = onGitHub();
    const a = t.open({ kind: "bug", title: "Crash on start", project: proj });
    const b = t.open({ kind: "request", title: "Export to PDF", project: proj, body: "A button that saves the page as a PDF file." });
    log.append("ticket.pr", { id: a.id, by: "github", repo: "acme/app", number: 3, url: "u", state: "merged", sha: "s1" });
    log.append("ticket.pr", { id: b.id, by: "github", repo: "acme/app", number: 4, url: "u", state: "merged", sha: "s2" });
    const st = g.status(proj);
    expect(st.next).toMatchObject({ version: "v0.1.0", bump: "minor" });
    expect(st.next!.notes).toMatch(/## New\n- Export to PDF \(AA-2, PR #4\)/);
    expect(st.next!.notes).toMatch(/## Fixed\n- Crash on start \(AA-1, PR #3\)/);
    // The release goes on the newest commit of main.
    gh.commits = [{ sha: "head1", commit: { message: "x", committer: { date: new Date().toISOString() } }, author: { login: "dana" } }];
    const v = await g.cutVersion(proj);
    expect(v).toMatchObject({ version: "v0.1.0", sha: "head1", url: "https://github.com/acme/app/releases/tag/v0.1.0" });
    expect(g.status(proj).next).toBeNull();
    await expect(g.cutVersion(proj)).rejects.toThrow(/Nothing was merged since v0.1.0/);
  });

  it("tags a local project's folder, past the tags it already has", async () => {
    const { log, proj, dir } = localProject();
    git(dir, "tag", "v0.3.0");
    const t = new Tickets(log, {});
    const g = new GitManager(log, t, {});
    const a = t.open({ kind: "bug", title: "Fix the counter", project: proj });
    t.say(a.id, "Done", { status: "closed" });
    const v = await g.cutVersion(proj);
    expect(v.version).toBe("v0.3.1");
    expect(git(dir, "tag", "--list", "v0.3.1")).toBe("v0.3.1");
  });

  it("numbers versions and writes notes from tickets alone", () => {
    expect(nextVersion(null, "minor")).toBe("v0.1.0");
    expect(nextVersion(highest(["v1.2.3", "v0.9.0", "junk"]), "patch")).toBe("v1.2.4");
    expect(nextVersion([1, 2, 3], "major")).toBe("v2.0.0");
    expect(suggestBump([{ id: 1, key: "A-1", kind: "bug", title: "x" }])).toBe("patch");
    expect(releaseNotes("v1.0.0", "App", [{ id: 1, key: "A-1", kind: "task", title: "Tidy", source: "outside" }], "2026-11-17T00:00:00Z")).toBe("# App v1.0.0\n\n2026-11-17 · 1 ticket\n\n## Made outside SF\n- Tidy (A-1)");
  });
});

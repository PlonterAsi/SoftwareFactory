import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog, MockRuntime, Tickets, GitHub, createProject, git, parseGitHubRepo, hideTokens } from "../src/index.js";

const tmp = () => mkdtempSync(join(tmpdir(), "sf-gh-"));
const TOKEN = "github_pat_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6";

/** A stand-in for github.com: a bare repo for git, and a fake REST API that records what it was asked. */
function fakeGitHub() {
  const src = tmp();
  git(src, "init", "-q", "-b", "main");
  writeFileSync(join(src, "README.md"), "# App\n");
  git(src, "add", "-A"); git(src, "commit", "-q", "-m", "first");
  const bare = join(tmp(), "app.git");
  git(tmp(), "clone", "-q", "--bare", src, bare);
  const calls: { method: string; path: string; body?: any; auth?: string }[] = [];
  const state = { merged: false, closed: false };
  const fake = (async (url: string, init: any) => {
    const path = url.replace("https://api.github.com", "");
    calls.push({ method: init.method, path, body: init.body ? JSON.parse(init.body) : undefined, auth: init.headers.authorization });
    const ok = (j: unknown) => new Response(JSON.stringify(j), { status: 200, headers: { "content-type": "application/json" } });
    if (path === "/repos/acme/app") return ok({ permissions: { push: true } });
    if (path.startsWith("/repos/acme/app/pulls?")) return ok([]);
    if (path === "/repos/acme/app/pulls" && init.method === "POST") return ok({ number: 7, html_url: "https://github.com/acme/app/pull/7", state: "open", draft: true });
    if (path === "/repos/acme/app/pulls/7") return ok({ number: 7, html_url: "https://github.com/acme/app/pull/7", state: state.merged || state.closed ? "closed" : "open", merged: state.merged, merge_commit_sha: state.merged ? "abc123" : null });
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  const gh = new GitHub({ dataDir: tmp(), fetch: fake, gitUrl: () => bare });
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

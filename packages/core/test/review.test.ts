import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  EventLog, MockRuntime, AgentBay, RepoExplorer, RepoReviewer, createCore, verify, suggestionsOf, latestReview, reviewNotes, reviewBrief,
  extractEndpoints, extractEnvVars, extractIntegrations, riskScan, readCode, parseNpmAudit, parsePipAudit, gatherEvidence, evidenceText,
  heuristicUnderstanding, heuristicVerdict, briefMarkdown, parseUnderstanding, parseVerdict, scanRepo, BRIEF_PATH,
  type EvidenceTools, type RepoEnv,
} from "../src/index.js";
import { declaredArgs } from "../src/factory/repoenv.js";
import { validateUnderstanding } from "../src/imports/reviewcrew.js";

const tmp = (p = "sf-review-") => mkdtempSync(join(tmpdir(), p));
const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** A small Flask site: a home page, a contact form that emails a lead, a route that breaks, and things a reviewer would circle. */
function flaskRepo(): string {
  const dir = tmp("sf-flask-");
  const put = (p: string, text: string) => { mkdirSync(join(dir, p, ".."), { recursive: true }); writeFileSync(join(dir, p), text); };
  put("README.md", "# Dog School\n\nA landing page for a dog trainer: it shows the courses and collects leads from a contact form.\n");
  put("requirements.txt", "Flask==2.0.1\nrequests\nstripe>=5\n");
  put("app.py", [
    "import os, smtplib, sqlite3",
    "from flask import Flask, render_template, request",
    "app = Flask(__name__)",
    "app.secret_key = 'not-a-real-secret-1234'",
    "STRIPE = os.environ.get('STRIPE_SECRET_KEY')",
    "MAIL_TO = os.getenv('MAIL_TO')",
    "@app.route('/')",
    "def home():",
    "    return render_template('home.html')",
    "@app.route('/contact', methods=['GET', 'POST'])",
    "def contact():",
    "    db = sqlite3.connect('leads.db')",
    "    db.execute(\"INSERT INTO leads VALUES ('%s')\" % request.form.get('name'))",
    "    return 'ok'",
    "@app.get('/courses/<int:course_id>')",
    "def course(course_id):",
    "    return str(course_id)",
    "@app.route('/admin')",
    "def admin():",
    "    raise RuntimeError('boom')",
    "if __name__ == '__main__':",
    "    app.run(debug=True)",
    "",
  ].join("\n"));
  put("templates/home.html", "<h1>Dog School</h1><a href=\"/contact\">Contact</a><script src=\"https://www.googletagmanager.com/gtag/js\"></script>\n");
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  git(dir, "add", "-A"); git(dir, "commit", "-qm", "init");
  return dir;
}

/** The computer, faked: the install works, one test passes and one fails, the site opens two pages and /admin answers 500. */
const fakeTools = (seen: { ran: string[] } = { ran: [] }): Partial<EvidenceTools> => ({
  prepareEnv: (dir) => { seen.ran.push(`install ${dir}`); return { stack: ["python"], tests: [{ label: "pytest", file: "python", args: [], kind: "pytest" }], pathFirst: [], commands: [], notes: [], testHint: "python -m pytest -q" } as RepoEnv; },
  runTests: async () => ({ cases: [{ name: "test_home", file: "tests/test_app.py", pass: true, durationMs: 0 }, { name: "test_admin", file: "tests/test_app.py", pass: false, durationMs: 0, error: "boom" }], passed: 1, failed: 1, exitCode: 1, timedOut: false, output: "" }),
  // A real little server, so asking each route gets a real answer: /admin breaks, the rest answer.
  withSite: (async (_dir: string, _o: unknown, during: (url: string) => Promise<unknown>) => {
    const server = createServer((req, res) => { res.statusCode = req.url === "/admin" ? 500 : 200; res.end("ok"); });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    try { return await during(`http://127.0.0.1:${(server.address() as AddressInfo).port}`); } finally { server.close(); }
  }) as EvidenceTools["withSite"],
  readPages: async () => [{ route: "", text: "Dog School. Courses for every dog.", controls: ["Contact"] }, { route: "contact", text: "Leave your name and phone.", controls: ["input: name", "Send"] }],
  dependencyScan: async () => ({ reports: [{ tool: "pip-audit", ran: true, note: "1 package with a known vulnerability", vulnerable: [{ name: "Flask 2.0.1", severity: "known vulnerability", detail: "PYSEC-2023-62, fixed in 2.2.5" }] }], unpinned: ["requests", "stripe"], total: 3 }),
});

describe("reading an app from its code", () => {
  const dir = flaskRepo();
  const files = readCode(dir);

  it("finds every route with its method, file and line", () => {
    const e = extractEndpoints(files).map((x) => `${x.method} ${x.path}`);
    expect(e).toEqual(expect.arrayContaining(["GET /", "GET /contact", "POST /contact", "GET /courses/<int:course_id>", "GET /admin"]));
    expect(extractEndpoints(files).find((x) => x.path === "/admin")).toMatchObject({ file: "app.py", framework: "Flask", line: 18 });
  });

  it("reads Express, FastAPI and Next.js routes too", () => {
    const e = extractEndpoints(new Map([
      ["server.js", "const app = express();\napp.get('/health', h);\nrouter.post(\"/api/orders\", h);\n"],
      ["api.py", "from fastapi import FastAPI\napp = FastAPI()\n@app.post('/items')\ndef add(): pass\n"],
      ["pages/about.tsx", "export default function About() {}"], ["pages/api/hello.ts", "export default function h() {}"], ["src/app/shop/page.tsx", "export default function P() {}"],
    ])).map((x) => `${x.framework} ${x.method} ${x.path}`);
    expect(e).toEqual(expect.arrayContaining(["Node GET /health", "Node POST /api/orders", "FastAPI POST /items", "Next.js GET /about", "Next.js ANY /api/hello", "Next.js GET /shop"]));
  });

  it("names the outside services, by package, setting and host", () => {
    const env = extractEnvVars(files);
    expect(env).toEqual(["MAIL_TO", "STRIPE_SECRET_KEY"]);
    const i = extractIntegrations(dir, files);
    expect(i.map((x) => x.id)).toEqual(expect.arrayContaining(["stripe", "smtp", "sqlite", "google-analytics"]));
    expect(i.find((x) => x.id === "stripe")!.evidence).toEqual(expect.arrayContaining(["package stripe (requirements.txt)", "setting STRIPE_SECRET_KEY"]));
  });

  it("circles the risky lines", () => {
    const r = riskScan(files);
    expect(r.map((x) => x.id)).toEqual(expect.arrayContaining(["debug-on", "sql-format"]));
    expect(r.find((x) => x.id === "debug-on")).toMatchObject({ level: "high", file: "app.py", line: 22 });
    expect(r[0].level === "critical" || r[0].level === "high").toBe(true);
  });

  it("reads the audit tools' reports", () => {
    expect(parseNpmAudit(JSON.stringify({ vulnerabilities: { lodash: { name: "lodash", severity: "high", via: [{ title: "Prototype pollution" }], fixAvailable: true } } }))).toEqual([{ name: "lodash", severity: "high", detail: "Prototype pollution" }]);
    expect(parseNpmAudit("npm ERR! network")).toBeNull();
    expect(parsePipAudit(JSON.stringify({ dependencies: [{ name: "flask", version: "2.0.1", vulns: [{ id: "PYSEC-1", fix_versions: ["2.2.5"] }] }, { name: "ok", version: "1", vulns: [] }] }))).toEqual([{ name: "flask 2.0.1", severity: "known vulnerability", detail: "PYSEC-1, fixed in 2.2.5" }]);
  });

  it("only reads when told not to run, and says so", async () => {
    const steps: string[] = [];
    const ev = await gatherEvidence(dir, { run: false, step: (s, state) => steps.push(`${s}:${state}`) });
    expect(ev.endpoints.length).toBe(5);
    expect(ev.site.started).toBe(false);
    expect(ev.tests.ran).toBe(false);
    expect(steps).toEqual(expect.arrayContaining(["read:pass", "install:skipped", "site:skipped"]));
  });
});

describe("the deep review of an imported repo", () => {
  it("reviews with the practice crew for free: evidence, what the app is, a verdict, a brief and next steps", async () => {
    const src = flaskRepo();
    const log = new EventLog();
    const ex = new RepoExplorer(log, new MockRuntime({ delayMs: 0 }), join(tmp(), "imports"));
    const seen = { ran: [] as string[] };
    const rv = new RepoReviewer(log, new MockRuntime({ delayMs: 0 }), ex, undefined, { tools: fakeTools(seen) });
    const { projectId, done } = ex.importRepo(src);
    await done;
    const r = await rv.review(projectId);
    expect(r).toMatchObject({ outcome: "done", spentUsd: 0 });
    const row = latestReview(log, projectId)!;
    expect(row.status).toBe("done");
    expect(row.mode).toBe("heuristic");
    expect(row.stations.map((s) => `${s.station}:${s.state}`)).toEqual(["copy:pass", "read:pass", "install:pass", "tests:fail", "site:fail", "deps:fail", "inspect:pass", "verdict:pass", "brief:pass"]);
    // It ran in a copy of its own: the person's folder has nothing new in it.
    expect(seen.ran[0]).toBe(`install ${rv.copyDir(projectId)}`);
    expect(git(src, "status", "--porcelain")).toBe("");
    expect(existsSync(join(src, ".sf"))).toBe(false);
    // The evidence: the route that broke is known as broken.
    expect(row.evidence!.endpoints.find((e) => e.path === "/admin")).toBeTruthy();
    expect(row.evidence!.tests).toMatchObject({ ran: true, passed: 1, failed: 1 });
    // What the app is: the README's words, and a flow with the pages that were seen.
    expect(row.understanding!.purpose).toMatch(/landing page for a dog trainer/);
    expect(row.understanding!.flow.steps.find((s) => s.route === "/contact")).toMatchObject({ kind: "page", state: "seen" });
    // The verdict: three scores with reasons, a call, and next steps that became suggestions for the Council.
    const v = row.verdict!;
    expect(["keep", "refactor", "rewrite"]).toContain(v.recommendation.call);
    for (const k of ["codeHealth", "goalFit", "costToFix"] as const) { expect(v.scores[k].score).toBeGreaterThanOrEqual(0); expect(v.scores[k].why).toBeTruthy(); }
    expect(v.nextSteps.map((n) => n.title)).toEqual(expect.arrayContaining(["Turn debug mode off outside development", "Fix the failing tests", "Update the packages with known vulnerabilities"]));
    const filed = suggestionsOf(log, projectId).map((s) => s.id);
    for (const n of v.nextSteps) expect(filed).toContain(n.suggestionId);
    expect(v.questions.length).toBeGreaterThan(2);
    // The brief is one Markdown file with all of it.
    expect(row.brief).toMatch(/^# .*review brief/);
    expect(row.brief).toMatch(/## Routes[\s\S]*`\/contact`/);
    expect(row.brief).toMatch(/## Next steps/);
    expect(readFileSync(join(rv.copyDir(projectId), ".sf", "REVIEW.md"), "utf8")).toBe(row.brief);
    // Working agents start from it.
    expect(reviewBrief(log, projectId)).toMatch(/Purpose: A landing page for a dog trainer/);
    // Reviewing again does not file the same next steps twice.
    const before = suggestionsOf(log, projectId).length;
    await rv.review(projectId);
    expect(suggestionsOf(log, projectId).length).toBe(before);
  }, 30_000);

  it("on the real crew the Inspector reads the copy with read tools and the Assessor judges, inside the limit", async () => {
    const src = flaskRepo();
    const log = new EventLog();
    const rt = new MockRuntime({ delayMs: 0 });
    const bay = new AgentBay(log, rt);
    const ex = new RepoExplorer(log, rt, join(tmp(), "imports"), bay, { mode: "agent" });
    const rv = new RepoReviewer(log, rt, ex, bay, { tools: fakeTools() });
    const { projectId, done } = ex.importRepo(src);
    await done;
    rt.calls.length = 0;
    const r = await rv.review(projectId, { maxUsd: 1 });
    expect(r.outcome).toBe("done");
    const [inspect, verdict] = rt.calls;
    expect(inspect.systemPrompt).toMatch(/Station contract: inspect/);
    expect(inspect.cwd).toBe(rv.copyDir(projectId));
    expect(inspect.tools).toEqual(expect.arrayContaining(["Read", "Glob", "Grep"]));
    expect(inspect.tools).not.toContain("Edit");
    expect(inspect.budgetUsd).toBe(0.6);
    expect(inspect.prompt).toMatch(/GET \/admin {2}\[app\.py:18\] answered/);
    expect(verdict.systemPrompt).toMatch(/Station contract: verdict/);
    expect(verdict.prompt).toMatch(/^TASK: verdict/);
    expect(verdict.budgetUsd).toBeLessThanOrEqual(1);
    const row = latestReview(log, projectId)!;
    expect(row).toMatchObject({ mode: "agent", understoodBy: "inspector", verdictBy: "assessor", capUsd: 1 });
    expect(row.verdict!.headline).toMatch(/Mock verdict/);
    expect(row.spentUsd).toBeGreaterThan(0);
  }, 30_000);

  it("interview answers and corrections are kept, and Update the verdict rewrites both with them", async () => {
    const src = flaskRepo();
    const log = new EventLog();
    const rt = new MockRuntime({ delayMs: 0 });
    const bay = new AgentBay(log, rt);
    const ex = new RepoExplorer(log, rt, join(tmp(), "imports"), bay, { mode: "agent" });
    const rv = new RepoReviewer(log, rt, ex, bay, { tools: fakeTools() });
    const { projectId, done } = ex.importRepo(src);
    await done;
    await expect(rv.update(projectId)).rejects.toThrow(/no verdict to update/);
    await rv.review(projectId);
    const q = latestReview(log, projectId)!.verdict!.questions[0];
    rv.answer(projectId, [{ questionId: q.id, answer: "Only me, once a month." }, { questionId: "nope", answer: "ignored" }]);
    const notes = rv.correct(projectId, { about: "feature: Admin", was: "unknown", text: "The admin page was never finished; delete it." });
    expect(notes.map((n) => n.kind)).toEqual(["answer", "correction"]);
    expect(rv.detail(projectId)!.pending).toBe(2);
    expect(() => rv.correct(projectId, { about: "purpose", text: " " })).toThrow(/what is right/);
    // A note can be taken back before it is used.
    const extra = rv.correct(projectId, { about: "users", text: "wrong note" }).at(-1)!;
    expect(rv.removeNote(projectId, extra.id).length).toBe(2);
    rt.calls.length = 0;
    const r = await rv.update(projectId);
    expect(r.outcome).toBe("done");
    // One Assessor call, no Inspector, nothing installed or run again.
    expect(rt.calls.length).toBe(1);
    expect(rt.calls[0].prompt).toMatch(/^TASK: revise/);
    expect(rt.calls[0].prompt).toMatch(/the owner answered: Only me, once a month\./);
    expect(rt.calls[0].prompt).toMatch(/About feature: Admin .*the owner corrects: The admin page was never finished/);
    expect(rt.calls[0].budgetUsd).toBe(0.45);
    const row = latestReview(log, projectId)!;
    expect(row.trigger).toBe("update");
    expect(row.verdict!.headline).toMatch(/revised/);
    expect(row.understanding!.users).toBe("Only me, once a month.");
    expect(row.evidence!.endpoints.length).toBe(5);
    expect(reviewNotes(log, projectId).every((n) => n.applied === row.id)).toBe(true);
    expect(rv.detail(projectId)!.pending).toBe(0);
    expect(row.brief).toMatch(/## What the owner said[\s\S]*Only me, once a month/);
  }, 30_000);

  it("puts the brief in a local repo as a branch, without moving its files or its current branch", async () => {
    const src = flaskRepo();
    const log = new EventLog();
    const ex = new RepoExplorer(log, null, join(tmp(), "imports"));
    const rv = new RepoReviewer(log, null, ex, undefined, { tools: fakeTools() });
    const { projectId, done } = ex.importRepo(src);
    await done;
    await expect(rv.saveBrief(projectId)).rejects.toThrow(/no brief yet/);
    await rv.review(projectId);
    const saved = await rv.saveBrief(projectId);
    expect(saved).toMatchObject({ branch: "sf/review-brief", url: null });
    expect(git(src, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(git(src, "status", "--porcelain")).toBe("");
    expect(git(src, "show", `sf/review-brief:${BRIEF_PATH}`)).toMatch(/review brief/);
    expect(git(src, "diff", "--name-only", "main", "sf/review-brief")).toBe(BRIEF_PATH);
    // Pressed again after another review: the branch is replaced, not refused.
    await rv.review(projectId);
    await rv.saveBrief(projectId);
    expect(rv.detail(projectId)!.briefSaved).toMatchObject({ branch: "sf/review-brief" });
  }, 30_000);

  it("a first import reviews itself; an import that asks not to, or that is already known, does not", async () => {
    const log = new EventLog();
    const ex = new RepoExplorer(log, null, join(tmp(), "imports"));
    const rv = new RepoReviewer(log, null, ex, undefined, { tools: fakeTools() });
    const a = ex.importRepo(flaskRepo());
    rv.afterImport(a);
    await a.done; await new Promise((r) => setTimeout(r, 20)); await rv.idle();
    expect(latestReview(log, a.projectId)).toMatchObject({ trigger: "import", status: "done" });
    const b = ex.importRepo(flaskRepo());
    rv.afterImport(b, { review: false });
    await b.done; await new Promise((r) => setTimeout(r, 20)); await rv.idle();
    expect(latestReview(log, b.projectId)).toBeNull();
    // Exploring again later never starts a review: it runs again only when pressed.
    const reviews = () => (log.db.prepare("SELECT count(*) AS n FROM repo_reviews").get() as { n: number }).n;
    const n = reviews();
    await ex.explore(a.projectId);
    await new Promise((r) => setTimeout(r, 20)); await rv.idle();
    expect(reviews()).toBe(n);
  }, 30_000);

  it("a failed agent answer falls back to the measured verdict and says so", async () => {
    const src = flaskRepo();
    const log = new EventLog();
    const rt = { name: "mock", run: async () => ({ text: "I could not read it.", costUsd: 0.2, durationMs: 1, models: ["mock"], runtime: "mock", contextTokens: 0 }) };
    const ex = new RepoExplorer(log, rt, join(tmp(), "imports"), undefined, { mode: "heuristic" });
    const { projectId, done } = ex.importRepo(src);
    await done;
    const agentEx = Object.assign(Object.create(Object.getPrototypeOf(ex)), ex, { mode: () => "agent" as const });
    const rv = new RepoReviewer(log, rt, agentEx, undefined, { tools: fakeTools() });
    const r = await rv.review(projectId, { maxUsd: 1 });
    expect(r).toMatchObject({ outcome: "done", spentUsd: 0.4 });
    const row = latestReview(log, projectId)!;
    expect(row.verdictBy).toBe("heuristic");
    expect(row.stations.find((s) => s.station === "verdict")).toMatchObject({ state: "fail" });
    expect(row.stations.find((s) => s.station === "inspect")!.note).toMatch(/free reading is used instead/);
    expect(row.verdict!.nextSteps.length).toBeGreaterThan(0);
  }, 30_000);
});

describe("review shapes", () => {
  it("the practice answers pass their station checks, and the parsers refuse an empty answer", () => {
    const rt = new MockRuntime({ delayMs: 0 });
    return Promise.all([
      rt.run({ prompt: "  GET /  [app.py:7]", systemPrompt: "Station contract: inspect." }).then((r) => { expect(verify("inspect", r.text).every((c) => c.pass)).toBe(true); expect(parseUnderstanding(r.text)!.flow.steps[0].route).toBe("/"); }),
      rt.run({ prompt: "TASK: verdict", systemPrompt: "Station contract: verdict." }).then((r) => { expect(verify("verdict", r.text).every((c) => c.pass)).toBe(true); }),
    ]).then(() => {
      expect(parseUnderstanding("```json\n{}\n```")).toBeNull();
      expect(parseVerdict("```json\n{\"recommendation\": {\"call\": \"burn\"}}\n```")).toBeNull();
      expect(parseVerdict("```json\n{\"recommendation\": {\"call\": \"rewrite\"}, \"scores\": {\"codeHealth\": {\"score\": 400}}}\n```")!.scores.codeHealth.score).toBe(100);
    });
  });

  it("the measured verdict gets worse as the evidence does", async () => {
    const dir = flaskRepo();
    const map = scanRepo(dir);
    const good = await gatherEvidence(dir, { run: false });
    good.risks = []; good.install.ok = true; good.tests = { ran: true, passed: 10, failed: 0, failing: [], note: "10 passed" }; good.site.started = true;
    const bad = await gatherEvidence(dir, { tools: fakeTools() });
    const u = heuristicUnderstanding("Dog School", "", map, bad);
    const a = heuristicVerdict(1, u, good, map);
    const b = heuristicVerdict(1, u, bad, map);
    expect(b.scores.codeHealth.score).toBeLessThan(a.scores.codeHealth.score);
    expect(b.scores.costToFix.score).toBeGreaterThan(a.scores.costToFix.score);
    expect(evidenceText(bad)).toMatch(/Risky lines:/);
    expect(briefMarkdown({ name: "Dog School", source: dir, head: map.head, ts: "2026-11-16T00:00:00Z", by: "test", understanding: u, verdict: b, evidence: bad, notes: [] })).toMatch(/\| Code health \| \d+\/100 \|/);
  });
});

describe("the review API", () => {
  it("serves the review, takes answers and corrections, changes the limit, and refuses a limit out of range", async () => {
    const data = tmp("sf-data-");
    const src = flaskRepo();
    const log = new EventLog();
    const core = createCore({ log, runtime: new MockRuntime({ delayMs: 0 }), projectsDir: join(data, "projects") });
    Object.assign(core.reviewer.opts, { tools: fakeTools() });
    const server = createServer(core).listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = (p: string, body: unknown = {}) => fetch(`${base}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    try {
      const imp = await (await post("/api/imports", { source: src, review: true })).json() as { projectId: number };
      await core.explorer.idle(); await new Promise((r) => setTimeout(r, 30)); await core.reviewer.idle();
      const d = await (await fetch(`${base}/api/imports/${imp.projectId}/review`)).json() as any;
      expect(d.shown.verdict.recommendation.call).toBeTruthy();
      expect(d.current.trigger).toBe("import");
      expect(d.steps.length).toBe(d.shown.verdict.nextSteps.length);
      expect(d.settings).toMatchObject({ maxUsd: 1.5, updateUsd: 0.45, auto: false });
      // The project's own facts carry the call, for its home and the tab's badge.
      const proj = await (await fetch(`${base}/api/projects/${imp.projectId}`)).json() as any;
      expect(proj.facets.code.review).toMatchObject({ status: "done", call: d.shown.verdict.recommendation.call });
      const q = d.shown.verdict.questions[0];
      expect((await post(`/api/imports/${imp.projectId}/review/answers`, { answers: [{ questionId: q.id, answer: "It sells dog training courses." }] })).status).toBe(200);
      const c = await (await post(`/api/imports/${imp.projectId}/review/corrections`, { about: "users", text: "Dog owners in Tel Aviv." })).json() as any;
      expect(c.notes.length).toBe(2);
      expect((await post(`/api/imports/${imp.projectId}/review/corrections`, { about: "users", text: "" })).status).toBe(400);
      expect((await fetch(`${base}/api/imports/${imp.projectId}/review/notes/${c.notes[1].id}`, { method: "DELETE" })).status).toBe(200);
      expect((await post(`/api/imports/${imp.projectId}/review/update`)).status).toBe(202);
      await core.reviewer.idle();
      const after = await (await fetch(`${base}/api/imports/${imp.projectId}/review`)).json() as any;
      expect(after.current.trigger).toBe("update");
      expect(after.shown.understanding.purpose).toBe("It sells dog training courses.");
      expect(after.pending).toBe(0);
      expect((await (await fetch(`${base}/api/imports/${imp.projectId}/review/brief`)).json() as any).brief).toMatch(/It sells dog training courses/);
      expect((await post("/api/imports/review/settings", { maxUsd: 50 })).status).toBe(400);
      expect(await (await post("/api/imports/review/settings", { maxUsd: 3, auto: true, homeStack: "TypeScript and Tauri" })).json()).toMatchObject({ maxUsd: 3, updateUsd: 0.9, auto: true, homeStack: "TypeScript and Tauri" });
      expect((await fetch(`${base}/api/imports/999999/review`)).status).toBe(404);
    } finally { server.close(); }
  }, 30_000);
});

describe("what the first real review taught (LandingPage, 2026-11-16)", () => {
  it("starts a program with the arguments the repo's own Dockerfile or Procfile gives it", () => {
    const d = tmp();
    writeFileSync(join(d, "Dockerfile"), 'FROM python:3.12\nCOPY . .\nCMD ["python", "app.py", "0"]\n');
    expect(declaredArgs(d, "app.py")).toEqual(["0"]);
    expect(declaredArgs(d, "other.py")).toEqual([]);
    writeFileSync(join(d, "Dockerfile"), "FROM python:3.12\nCMD python -u ./app.py 0 --quiet\n");
    expect(declaredArgs(d, "app.py")).toEqual(["0", "--quiet"]);
    writeFileSync(join(d, "Dockerfile"), "FROM python:3.12\nCMD python app.py $(rm -rf /)\n");
    expect(declaredArgs(d, "app.py")).toEqual([]); // nothing a shell would act on
    const p = tmp();
    writeFileSync(join(p, "Procfile"), "web: python server.py 8080\n");
    expect(declaredArgs(p, "server.py")).toEqual(["8080"]);
    expect(declaredArgs(tmp(), "app.py")).toEqual([]);
  });

  it("never cuts a text mid-word: over its limit it ends at a whole sentence or a whole word", () => {
    const long = "The contract form posts to the submit route and the signed agreement is emailed as a PDF to the trainer and the client, and nothing is saved on the server after that at all";
    const u = validateUnderstanding({ purpose: "A site.", flow: { steps: [{ id: "a", name: "Home" }, { id: "b", name: "Contract" }], links: [{ from: "a", to: "b", label: long }] }, data: [{ name: "Agreement", what: `${"First sentence that is long enough to fill the space. ".repeat(8)}And a last one that will not fit in`, where: "" }] });
    const label = u.flow.links[0].label!;
    expect(label.length).toBeLessThanOrEqual(121);
    expect(label.endsWith("…")).toBe(true);
    expect(long.startsWith(label.slice(0, -1))).toBe(true);
    expect(long[label.length - 1]).toMatch(/[ ,]/); // the cut is at a word boundary
    expect(u.data[0].what.endsWith("space.")).toBe(true);
  });
});

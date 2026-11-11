import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { EventLog } from "../events.js";
import { importOf } from "../imports/explorer.js";
import { projectDetail } from "../projects/service.js";

/**
 * Can a finished project be added into SoftwareFactory, and in which form?
 *
 *   tool    a command-line program: the Features page gives it an arguments box and its output
 *   panel   a web page (an index.html): the Features page shows it inside the app
 *   source  part of SoftwareFactory's own code: prepared as a brief for a pull request, never straight to main
 *
 * A project may say what it wants with a `softwarefactory.json` in its root:
 *   { "form": "tool" | "panel", "title": "Runner", "entry": "bin/run.js", "web": "dist", "summary": "…" }
 * Without one, the form is detected from package.json (bin, main, start) and index.html files.
 */
export type IntegrationForm = "tool" | "panel" | "source";
export const INTEGRATION_FORMS: IntegrationForm[] = ["tool", "panel", "source"];

export interface ReadinessCheck { id: string; label: string; state: "pass" | "warn" | "fail"; detail: string }

export interface FormOption {
  form: IntegrationForm;
  available: boolean;
  /** tool: the script to run, relative to the project root. panel: the folder holding index.html ("" = root). */
  entry: string | null;
  why: string;
}

export interface Assessment {
  projectId: number;
  name: string;
  slug: string;
  summary: string;
  source: { kind: "factory_run" | "import"; ref: number; dir: string; sha: string | null } | null;
  checks: ReadinessCheck[];
  forms: FormOption[];
  recommended: IntegrationForm | null;
  /** Shipped, folder present, and at least one form available. */
  ready: boolean;
  manifest: Manifest | null;
}

export interface Manifest { form?: IntegrationForm; title?: string; entry?: string; web?: string; summary?: string }

type Row = Record<string, any>;

export const featureSlug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "feature";

function readJson(path: string): Row | null {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

const isFile = (p: string) => { try { return statSync(p).isFile(); } catch { return false; } };

/** The forms a folder supports, from its manifest, package.json and web pages. */
export function detectForms(dir: string): { forms: FormOption[]; manifest: Manifest | null; pkg: Row | null } {
  const manifest = readJson(join(dir, "softwarefactory.json")) as Manifest | null;
  const pkg = readJson(join(dir, "package.json"));
  // tool: manifest entry, then package.json bin, then main, then a `node x.js` start script, then common names.
  const bin = typeof pkg?.bin === "string" ? pkg.bin : pkg?.bin && typeof pkg.bin === "object" ? Object.values(pkg.bin)[0] as string : null;
  const start = typeof pkg?.scripts?.start === "string" ? pkg.scripts.start.match(/^node\s+(\S+\.(?:c|m)?js)\b/)?.[1] ?? null : null;
  // Factory builds often put their command in bin/ without naming it in package.json: take bin/'s only script.
  let binDir: string[] = [];
  try { binDir = readdirSync(join(dir, "bin")).filter((n) => /\.(c|m)?js$/.test(n)).map((n) => `bin/${n}`); } catch { /* no bin/ */ }
  const toolCandidates = [manifest?.form !== "panel" ? manifest?.entry : null, bin, pkg?.main, start, binDir.length === 1 ? binDir[0] : null, "bin/cli.js", "cli.js", "index.js", "src/index.js", "src/cli.js"]
    .filter((x): x is string => typeof x === "string" && /\.(c|m)?js$/.test(x))
    .map((x) => x.replace(/^\.\//, ""));
  const toolEntry = toolCandidates.find((x) => isFile(join(dir, x))) ?? null;
  // panel: manifest web folder, then the usual places for a built or plain page.
  const webCandidates = [manifest?.web, manifest?.form === "panel" ? manifest?.entry?.replace(/\/?index\.html$/, "") : null, "dist", "build", "public", "web", "site", ""]
    .filter((x): x is string => typeof x === "string")
    .map((x) => x.replace(/^\.\/?/, "").replace(/\/$/, ""));
  const webEntry = webCandidates.find((x) => isFile(join(dir, x, "index.html")));
  const forms: FormOption[] = [
    { form: "tool", available: !!toolEntry, entry: toolEntry, why: toolEntry ? `Runs node ${toolEntry}` : "No runnable script found (package.json bin, main, or index.js)" },
    { form: "panel", available: webEntry != null, entry: webEntry ?? null, why: webEntry != null ? `Shows ${webEntry ? webEntry + "/" : ""}index.html` : "No index.html found (root, dist, build, public or web)" },
    { form: "source", available: true, entry: null, why: "A brief for a pull request that builds it into SoftwareFactory's own code" },
  ];
  return { forms, manifest, pkg };
}

function gitHead(dir: string): { head: string | null; dirty: boolean } {
  const r = spawnSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true });
  if (r.status !== 0) return { head: null, dirty: false };
  const s = spawnSync("git", ["-C", dir, "status", "--porcelain"], { encoding: "utf8", windowsHide: true });
  return { head: r.stdout.trim(), dirty: s.status === 0 && s.stdout.trim().length > 0 };
}

/** Where a project's finished code lives: its newest shipped factory run, else its imported repo. */
export function sourceOf(log: EventLog, projectId: number): Assessment["source"] {
  const d = projectDetail(log, projectId);
  if (!d) return null;
  if (d.runIds.length) {
    const ph = d.runIds.map(() => "?").join(",");
    const run = log.db.prepare(`SELECT id, dir, sha FROM factory_runs WHERE id IN (${ph}) AND outcome = 'shipped' AND dir IS NOT NULL ORDER BY id DESC LIMIT 1`).get(...d.runIds) as Row | undefined;
    if (run) return { kind: "factory_run", ref: Number(run.id), dir: String(run.dir), sha: run.sha ? String(run.sha) : null };
  }
  const imp = importOf(log, projectId);
  if (imp && imp.status !== "failed" && imp.status !== "importing") return { kind: "import", ref: projectId, dir: imp.dir, sha: imp.head ?? null };
  return null;
}

/** The last test round of a factory run: did everything pass? */
function lastTests(log: EventLog, run: number): { cases: number; failed: number } | null {
  const t = log.list({ type: "factory.tests", sinceId: run - 1, limit: 1e6 }).filter((e) => Number((e.payload as Row).run) === run).at(-1);
  if (!t) return null;
  const p = t.payload as Row;
  return { cases: Array.isArray(p.cases) ? p.cases.length : Number(p.passed ?? 0) + Number(p.failed ?? 0), failed: Number(p.failed ?? 0) };
}

export function assessProject(log: EventLog, projectId: number): Assessment | null {
  const d = projectDetail(log, projectId);
  if (!d) return null;
  const checks: ReadinessCheck[] = [];
  const source = sourceOf(log, projectId);
  checks.push(source
    ? { id: "finished", label: "Finished", state: "pass", detail: source.kind === "factory_run" ? `Shipped by run #${source.ref}` : `Imported repo at ${source.dir}` }
    : { id: "finished", label: "Finished", state: "fail", detail: "No shipped run and no imported repo yet. Build it first." });
  const present = !!source && existsSync(source.dir);
  if (source) checks.push(present
    ? { id: "folder", label: "Code on disk", state: "pass", detail: source.dir }
    : { id: "folder", label: "Code on disk", state: "fail", detail: `${source.dir} is missing` });
  if (source?.kind === "factory_run") {
    const t = lastTests(log, source.ref);
    checks.push(!t ? { id: "tests", label: "Tests pass", state: "warn", detail: "No test round recorded" }
      : t.failed ? { id: "tests", label: "Tests pass", state: "fail", detail: `${t.failed} of ${t.cases} failing on the last round` }
      : { id: "tests", label: "Tests pass", state: "pass", detail: `${t.cases} of ${t.cases} passing` });
  } else if (source) {
    checks.push({ id: "tests", label: "Tests pass", state: "warn", detail: "Imported repo: SoftwareFactory has not run its tests" });
  }
  let forms: FormOption[] = INTEGRATION_FORMS.map((f) => ({ form: f, available: false, entry: null, why: "Nothing finished to look at yet" }));
  let manifest: Manifest | null = null;
  let pkg: Row | null = null;
  if (present) {
    ({ forms, manifest, pkg } = detectForms(source!.dir));
    const g = gitHead(source!.dir);
    if (g.head && source!.sha && !g.head.startsWith(source!.sha) && !source!.sha.startsWith(g.head.slice(0, source!.sha.length))) {
      checks.push({ id: "version", label: "Same as shipped", state: "warn", detail: `The folder moved on since it shipped (${source!.sha} → ${g.head.slice(0, 7)}); the copy takes what is there now` });
    } else if (g.dirty) {
      checks.push({ id: "version", label: "Same as shipped", state: "warn", detail: "The folder has uncommitted changes; the copy takes them too" });
    } else if (g.head) {
      checks.push({ id: "version", label: "Same as shipped", state: "pass", detail: g.head.slice(0, 7) });
    }
    const deps = Object.keys(pkg?.dependencies ?? {});
    if (deps.length) checks.push(existsSync(join(source!.dir, "node_modules"))
      ? { id: "deps", label: "Dependencies", state: "pass", detail: `${deps.length} installed` }
      : { id: "deps", label: "Dependencies", state: "warn", detail: `${deps.join(", ")} not installed; it may not start until they are` });
    const runnable = forms.filter((f) => f.form !== "source" && f.available);
    checks.push(runnable.length
      ? { id: "runnable", label: "Something to open", state: "pass", detail: runnable.map((f) => f.why).join("; ") }
      : { id: "runnable", label: "Something to open", state: "warn", detail: "Nothing to run or show inside the app; only the source route is open" });
  }
  const ready = !!source && present && !checks.some((c) => c.state === "fail");
  const pick = (f?: IntegrationForm) => (f && forms.find((x) => x.form === f && x.available) ? f : null);
  const recommended = !source || !present ? null : pick(manifest?.form) ?? pick("panel") ?? pick("tool") ?? "source";
  const name = manifest?.title?.trim() || d.name;
  return {
    projectId, name, slug: featureSlug(String(pkg?.name ?? name)), summary: manifest?.summary ?? d.summary ?? String(pkg?.description ?? ""),
    source, checks, forms, recommended, ready, manifest,
  };
}

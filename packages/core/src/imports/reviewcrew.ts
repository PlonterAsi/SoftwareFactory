import { parseJsonBlock } from "../factory/workspace.js";
import type { CodeMap } from "./scan.js";
import { suggestionId, type Severity, type Suggestion } from "./crew.js";
import { evidenceText, type Evidence } from "./evidence.js";

/**
 * What the two agents of a deep review are given and must answer, and the free stand-ins the practice
 * crew uses (docs/review.md).
 *
 *   The Inspector reverse-engineers the app. It gets the code map, the evidence and read access to the
 *   code, and answers with an Understanding: what the app is for, who uses it and how, its features, its
 *   flow step by step, what it stores and what it talks to. The person is never asked first: they may not
 *   know the repo either.
 *
 *   The Assessor judges. It gets the Understanding and the evidence and answers with a RepoVerdict: three
 *   scores, keep or refactor or rewrite, advice on the stack, where the flow falls short of the purpose,
 *   the next steps as ready tickets, and the hard questions it would ask the owner.
 *
 * Whatever the owner later says (an interview answer, a correction of one point) is fact for both.
 */

export const FEATURE_STATES = ["works", "partial", "broken", "unknown"] as const;
export type FeatureState = (typeof FEATURE_STATES)[number];
export const STEP_KINDS = ["page", "action", "api", "job", "external"] as const;
export type StepKind = (typeof STEP_KINDS)[number];
export const STEP_STATES = ["seen", "code-only", "broken"] as const;
export type StepState = (typeof STEP_STATES)[number];

export interface Understanding {
  purpose: string;
  users: string;
  usage: string;
  stack: string;
  features: { id: string; name: string; what: string; where: string[]; state: FeatureState }[];
  flow: {
    steps: { id: string; name: string; kind: StepKind; route?: string; what: string; state: StepState }[];
    links: { from: string; to: string; label?: string }[];
  };
  data: { name: string; what: string; where: string }[];
  integrations: { name: string; what: string; state: "used" | "configured" | "dead" }[];
  /** What the Inspector could not settle from the code. */
  unsure: string[];
}

export const CALLS = ["keep", "refactor", "rewrite"] as const;
export type Call = (typeof CALLS)[number];
export interface Scored { score: number; why: string }
export interface NextStep extends Suggestion { suggestionId?: string }
export interface ReviewQuestion { id: string; question: string; why: string; guess: string }

export interface RepoVerdict {
  headline: string;
  scores: { codeHealth: Scored; goalFit: Scored; costToFix: Scored };
  recommendation: { call: Call; confidence: "low" | "medium" | "high"; why: string; ifKeep: string; ifRewrite: string };
  stack: { call: "keep" | "change"; advice: string; suite: string };
  /** Where the flow that was found falls short of the purpose. */
  gaps: { title: string; detail: string; level: "high" | "medium" | "low" }[];
  strengths: string[];
  nextSteps: NextStep[];
  questions: ReviewQuestion[];
}

/** Something the owner told the review: an answer to one of its questions, or a correction of one point. */
export interface OwnerNote { id: number; kind: "answer" | "correction"; about: string; question: string; text: string; ts: string; applied: number | null }

const s = (x: unknown, max = 400) => String(x ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const arr = (x: unknown): Record<string, unknown>[] => (Array.isArray(x) ? x.filter((y) => y && typeof y === "object") as Record<string, unknown>[] : []);
const strs = (x: unknown, n: number, max = 200) => (Array.isArray(x) ? x.map((y) => s(y, max)).filter(Boolean).slice(0, n) : []);
const one = <T extends string>(x: unknown, all: readonly T[], d: T): T => ((all as readonly string[]).includes(String(x)) ? (x as T) : d);
const slugId = (t: string, i: number) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || `x${i + 1}`;
const pct = (x: unknown, d = 50) => { const n = Number(x); return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : d; };

/** The Inspector's answer, checked. Throws on an answer that says nothing about what the app is. */
export function validateUnderstanding(j: unknown): Understanding {
  const u = (j ?? {}) as Record<string, any>;
  const purpose = s(u.purpose, 600);
  if (!purpose) throw new Error('The understanding is missing "purpose"');
  const seenIds = new Set<string>();
  const uniq = (id: string) => { let k = id; for (let n = 2; seenIds.has(k); n++) k = `${id}-${n}`; seenIds.add(k); return k; };
  const steps = arr(u.flow?.steps).filter((x) => s(x.name)).slice(0, 24).map((x, i) => ({
    id: uniq(s(x.id, 40) || slugId(s(x.name), i)), name: s(x.name, 80), kind: one(x.kind, STEP_KINDS, "page"),
    ...(s(x.route, 120) ? { route: s(x.route, 120) } : {}), what: s(x.what, 300), state: one(x.state, STEP_STATES, "code-only"),
  }));
  const ids = new Set(steps.map((x) => x.id));
  return {
    purpose, users: s(u.users, 400), usage: s(u.usage, 600), stack: s(u.stack, 400),
    features: arr(u.features).filter((x) => s(x.name)).slice(0, 24).map((x, i) => ({ id: s(x.id, 40) || slugId(s(x.name), i), name: s(x.name, 80), what: s(x.what, 300), where: strs(x.where, 6, 160), state: one(x.state, FEATURE_STATES, "unknown") })),
    flow: { steps, links: arr(u.flow?.links).map((x) => ({ from: s(x.from, 40), to: s(x.to, 40), ...(s(x.label, 60) ? { label: s(x.label, 60) } : {}) })).filter((l) => ids.has(l.from) && ids.has(l.to) && l.from !== l.to).slice(0, 48) },
    data: arr(u.data).filter((x) => s(x.name)).slice(0, 16).map((x) => ({ name: s(x.name, 80), what: s(x.what, 240), where: s(x.where, 160) })),
    integrations: arr(u.integrations).filter((x) => s(x.name)).slice(0, 16).map((x) => ({ name: s(x.name, 80), what: s(x.what, 240), state: one(x.state, ["used", "configured", "dead"] as const, "used") })),
    unsure: strs(u.unsure, 8, 300),
  };
}

export function parseUnderstanding(text: string): Understanding | null {
  try { return validateUnderstanding(parseJsonBlock(text)); } catch { return null; }
}

/** The Assessor's answer, checked. Throws on one without a recommendation. */
export function validateVerdict(j: unknown): RepoVerdict {
  const v = (j ?? {}) as Record<string, any>;
  if (!v.recommendation || !(CALLS as readonly string[]).includes(String(v.recommendation.call))) throw new Error('The verdict is missing "recommendation.call" (keep, refactor or rewrite)');
  const scored = (x: any): Scored => ({ score: pct(x?.score ?? x), why: s(x?.why, 400) });
  return {
    headline: s(v.headline, 240) || `Recommendation: ${v.recommendation.call}.`,
    scores: { codeHealth: scored(v.scores?.codeHealth), goalFit: scored(v.scores?.goalFit), costToFix: scored(v.scores?.costToFix) },
    recommendation: { call: v.recommendation.call as Call, confidence: one(v.recommendation.confidence, ["low", "medium", "high"] as const, "medium"), why: s(v.recommendation.why, 900), ifKeep: s(v.recommendation.ifKeep, 500), ifRewrite: s(v.recommendation.ifRewrite, 500) },
    stack: { call: v.stack?.call === "change" ? "change" : "keep", advice: s(v.stack?.advice, 700), suite: s(v.stack?.suite, 500) },
    gaps: arr(v.gaps).filter((x) => s(x.title)).slice(0, 10).map((x) => ({ title: s(x.title, 120), detail: s(x.detail, 400), level: one(x.level, ["high", "medium", "low"] as const, "medium") })),
    strengths: strs(v.strengths, 6, 240),
    nextSteps: arr(v.nextSteps).filter((x) => s(x.title)).slice(0, 10).map((x) => ({
      title: s(x.title, 120), body: String(x.body ?? "").trim().slice(0, 1200), kind: x.kind === "fix" ? "fix" as const : "improvement" as const,
      lens: s(x.lens, 30) || "structure", severity: one(x.severity, ["critical", "high", "medium", "low"] as const, "medium") as Severity,
      effort: (x.effort === "small" || x.effort === "large" ? x.effort : "medium") as Suggestion["effort"], files: strs(x.files, 10, 200),
    })),
    questions: arr(v.questions).filter((x) => s(x.question)).slice(0, 8).map((x, i) => ({ id: s(x.id, 20) || `Q${i + 1}`, question: s(x.question, 300), why: s(x.why, 300), guess: s(x.guess, 300) })),
  };
}

export function parseVerdict(text: string): RepoVerdict | null {
  try { return validateVerdict(parseJsonBlock(text)); } catch { return null; }
}

/** A revision's answer: the understanding and the verdict, both rewritten with what the owner said. */
export function parseRevision(text: string): { understanding: Understanding; verdict: RepoVerdict } | null {
  try {
    const j = parseJsonBlock<{ understanding?: unknown; verdict?: unknown }>(text);
    return { understanding: validateUnderstanding(j.understanding), verdict: validateVerdict(j.verdict) };
  } catch { return null; }
}

/** What the owner said, as the block both agents read first. Empty when they said nothing yet. */
export function ownerFacts(notes: OwnerNote[]): string {
  if (!notes.length) return "";
  const lines = notes.slice(-30).map((n) => (n.kind === "answer" ? `- Asked "${n.question}", the owner answered: ${n.text}` : `- About ${n.about}${n.question ? ` (the review said: "${n.question}")` : ""}, the owner corrects: ${n.text}`));
  return `\n\nWHAT THE OWNER SAID (this is fact; it overrides anything you read or inferred):\n${lines.join("\n")}`;
}

export function inspectPrompt(repo: string, mapTextBlock: string, ev: Evidence, notes: OwnerNote[]): string {
  return `Repo: ${repo}\nThe current folder is a copy of it: read the code before you answer.\n\nCODE MAP (from a static scan and the Cartographer):\n${mapTextBlock}\n\nEVIDENCE (what installing it, running its tests, starting it and scanning it showed):\n${evidenceText(ev)}${ownerFacts(notes)}`;
}

const understandingText = (u: Understanding, maxChars = 6000) => {
  const L = [
    `Purpose: ${u.purpose}`, `Users: ${u.users || "not known"}`, `Usage: ${u.usage || "not known"}`, `Stack: ${u.stack || "not said"}`,
    "Features:", ...u.features.map((f) => `- [${f.state}] ${f.name}: ${f.what}${f.where.length ? ` (${f.where.slice(0, 3).join(", ")})` : ""}`),
    "Flow steps:", ...u.flow.steps.map((x) => `- ${x.id} [${x.kind}, ${x.state}] ${x.name}${x.route ? ` ${x.route}` : ""}: ${x.what}`),
    `Flow links: ${u.flow.links.map((l) => `${l.from} -> ${l.to}${l.label ? ` (${l.label})` : ""}`).join(", ") || "none"}`,
    ...(u.data.length ? ["Data it keeps:", ...u.data.map((d) => `- ${d.name}: ${d.what}${d.where ? ` (${d.where})` : ""}`)] : []),
    ...(u.integrations.length ? ["Outside services:", ...u.integrations.map((i) => `- [${i.state}] ${i.name}: ${i.what}`)] : []),
    ...(u.unsure.length ? ["Not settled from the code:", ...u.unsure.map((x) => `- ${x}`)] : []),
  ].join("\n");
  return L.length > maxChars ? `${L.slice(0, maxChars)}\n[...]` : L;
};

export function verdictPrompt(repo: string, u: Understanding, ev: Evidence, map: CodeMap, notes: OwnerNote[], home: string): string {
  const health = `Static health ${map.health.score}/100. ${map.files} files, ${map.lines} lines. Flags: ${map.health.flags.map((f) => `[${f.level}] ${f.text}`).join("; ") || "none"}. Largest files: ${map.largest.slice(0, 5).map((f) => `${f.path} (${f.lines})`).join(", ") || "none"}.`;
  return `TASK: verdict\nRepo: ${repo}\n\nWHAT THE APP IS (from the Inspector, who read the code):\n${understandingText(u)}\n\nEVIDENCE:\n${evidenceText(ev, 7000)}\n\nCODE HEALTH:\n${health}\n\nTHE OWNER'S OTHER WORK (judge the stack's fit against this):\n${home || "Nothing is known about the owner's other projects yet."}${ownerFacts(notes)}`;
}

export function revisePrompt(repo: string, u: Understanding, v: RepoVerdict, ev: Evidence, notes: OwnerNote[], fresh: OwnerNote[], home: string): string {
  return `TASK: revise\nRepo: ${repo}\n\nYOUR EARLIER UNDERSTANDING:\n${understandingText(u)}\n\nYOUR EARLIER VERDICT:\n${JSON.stringify({ headline: v.headline, scores: v.scores, recommendation: v.recommendation, stack: v.stack, gaps: v.gaps, nextSteps: v.nextSteps.map((n) => ({ title: n.title, kind: n.kind, severity: n.severity })) })}\n\nEVIDENCE:\n${evidenceText(ev, 5000)}\n\nTHE OWNER'S OTHER WORK:\n${home || "Nothing is known yet."}${ownerFacts(notes)}\n\nNEW SINCE YOUR EARLIER VERDICT (${fresh.length}): ${fresh.map((n) => (n.kind === "answer" ? `answer to "${n.question}"` : `correction about ${n.about}`)).join("; ")}.`;
}

// ---------------- the practice crew: free, from the evidence alone ----------------

const firstParagraph = (readme: string) => {
  const body = readme.replace(/\r/g, "").split("\n").filter((l) => !/^\s*(#|!\[|\[!\[|<|---|===)/.test(l)).join("\n");
  return s(body.split(/\n\s*\n/).map((p) => p.trim()).find((p) => p.length > 30) ?? "", 400);
};

/** The practice Inspector: what the routes, the pages and the README say, with no reading between the lines. */
export function heuristicUnderstanding(name: string, readme: string, map: CodeMap, ev: Evidence): Understanding {
  const langs = map.languages.filter((l) => l.lines > 0 && !["JSON", "Markdown", "YAML", "TOML", "Other", "Lockfile"].includes(l.lang)).slice(0, 3).map((l) => l.lang);
  const frameworks = [...new Set(ev.endpoints.map((e) => e.framework))];
  const pages = ev.endpoints.filter((e) => e.method === "GET" || e.method === "ANY").filter((e) => !/^\/(api|static|assets)\b/.test(e.path));
  const apis = ev.endpoints.filter((e) => !pages.includes(e));
  const seen = new Map(ev.site.pages.map((p) => [p.route.replace(/\/+$/, "") || "/", p]));
  const stepState = (e: { path: string; status?: number | null }): StepState => ((e.status ?? 0) >= 500 ? "broken" : seen.has(e.path.replace(/\/+$/, "") || "/") || (e.status != null && e.status < 400) ? "seen" : "code-only");
  const label = (p: string) => (p === "/" ? "Home" : p.replace(/^\//, "").replace(/[<>{}:]/g, "").split("/").filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1).replace(/[-_]/g, " ")).join(" / "));
  const steps: Understanding["flow"]["steps"] = [];
  const idOf = new Map<string, string>();
  for (const e of pages.slice(0, 14)) { const id = slugId(`page ${e.path === "/" ? "home" : e.path}`, steps.length); if ([...idOf.values()].includes(id)) continue; idOf.set(e.path, id); steps.push({ id, name: label(e.path), kind: "page", route: e.path, what: stepState(e) === "broken" ? `Answered with a server error (${e.status}) when it was opened. Served by ${e.file}.` : seen.get(e.path)?.text.slice(0, 160) || `Served by ${e.file}.`, state: stepState(e) }); }
  // A route that takes a form or a call was not asked while the app ran, so it is known from the code only.
  for (const e of apis.slice(0, 8)) { const id = slugId(`${e.method} ${e.path}`, steps.length); if ([...idOf.values()].includes(id)) continue; idOf.set(`${e.method} ${e.path}`, id); steps.push({ id, name: `${e.method} ${e.path}`, kind: "api", route: e.path, what: `Handled in ${e.file}.`, state: (e.status ?? 0) >= 500 ? "broken" : e.status != null && e.status < 400 ? "seen" : "code-only" }); }
  for (const i of ev.integrations.filter((x) => x.kind !== "hosting" && x.kind !== "database").slice(0, 4)) steps.push({ id: slugId(`ext ${i.id}`, steps.length), name: i.name, kind: "external", what: i.evidence[0] ?? "", state: "code-only" });
  const home = idOf.get("/") ?? steps[0]?.id;
  const links: Understanding["flow"]["links"] = [];
  if (home) for (const st of steps) if (st.id !== home && st.kind === "page") links.push({ from: home, to: st.id });
  const firstPage = steps.find((x) => x.kind === "page")?.id;
  if (firstPage) for (const st of steps) if (st.kind === "api") links.push({ from: firstPage, to: st.id, label: "sends" });
  const about = firstParagraph(readme);
  return {
    purpose: about || `${name}: a ${langs.join(" and ") || "code"} project${frameworks.length ? ` built on ${frameworks.join(", ")}` : ""} with ${ev.endpoints.length} route${ev.endpoints.length === 1 ? "" : "s"}. The practice crew reads names and pages only; the real crew says what it is for.`,
    users: "", usage: ev.site.command ? `Started with "${ev.site.command}".${ev.site.started ? " It ran here." : ` It did not run here: ${ev.site.note}.`}` : map.entryPoints.length ? `Entry points: ${map.entryPoints.slice(0, 3).map((e) => e.path).join(", ")}.` : "",
    stack: `${langs.join(", ") || "unknown"}${frameworks.length ? ` with ${frameworks.join(", ")}` : ""}${ev.stack.length ? ` (${ev.stack.join(", ")})` : ""}.`,
    features: steps.filter((x) => x.kind === "page" || x.kind === "api").slice(0, 16).map((x) => ({ id: x.id, name: x.name, what: x.what, where: [ev.endpoints.find((e) => e.path === x.route)?.file ?? ""].filter(Boolean), state: x.state === "seen" ? "works" as const : x.state === "broken" ? "broken" as const : "unknown" as const })),
    flow: { steps, links },
    data: ev.integrations.filter((i) => i.kind === "database").map((i) => ({ name: i.name, what: "Where it keeps its records.", where: i.evidence[0] ?? "" })),
    integrations: ev.integrations.filter((i) => i.kind !== "database").map((i) => ({ name: i.name, what: i.evidence.join("; "), state: "used" as const })),
    unsure: ["What the app is for and who uses it: the practice crew cannot read that from the code. Answer the questions, or switch to the real crew in Systems."],
  };
}

const RISK_STEP: Record<string, Pick<Suggestion, "title" | "lens" | "effort">> = {
  "committed-secret": { title: "Remove the committed secret and rotate it", lens: "security", effort: "small" },
  "debug-on": { title: "Turn debug mode off outside development", lens: "security", effort: "small" },
  "hardcoded-secret": { title: "Read the secret key from a setting, not the code", lens: "security", effort: "small" },
  "sql-format": { title: "Use query parameters instead of building SQL from text", lens: "security", effort: "medium" },
  "eval": { title: "Replace eval/exec with code that does not run text", lens: "security", effort: "medium" },
  "shell": { title: "Run commands without a shell", lens: "security", effort: "small" },
};

/** The practice Assessor: scores and a call from what was measured, with every number explained. */
export function heuristicVerdict(projectId: number, u: Understanding, ev: Evidence, map: CodeMap, notes: OwnerNote[] = []): RepoVerdict {
  const high = ev.risks.filter((r) => r.level === "critical" || r.level === "high");
  const vuln = ev.dependencies.reports.reduce((n, r) => n + r.vulnerable.length, 0);
  const brokenRoutes = ev.endpoints.filter((e) => (e.status ?? 0) >= 500).length;
  const testPenalty = !ev.tests.ran ? 12 : ev.tests.failed ? Math.min(20, ev.tests.failed * 4) : 0;
  const codeHealth = pct(map.health.score - high.length * 6 - Math.min(15, vuln * 3) - testPenalty - (ev.install.ok ? 0 : 8));
  const features = u.features.length || 1;
  const working = u.features.filter((f) => f.state === "works").length;
  const goalFit = pct(ev.site.started ? 45 + (working / features) * 50 - brokenRoutes * 8 : 35);
  const costToFix = pct(15 + high.length * 7 + vuln * 2 + (ev.tests.ran ? ev.tests.failed * 3 : 15) + brokenRoutes * 6 + (ev.install.ok ? 0 : 12) + Math.min(20, map.lines / 2500) + map.health.flags.filter((f) => f.level === "high").length * 6);
  const call: Call = codeHealth < 30 && costToFix > 70 ? "rewrite" : codeHealth < 55 || costToFix > 55 ? "refactor" : "keep";
  const steps: NextStep[] = [];
  const seenStep = new Set<string>();
  const add = (x: Suggestion) => { if (seenStep.has(x.title) || steps.length >= 8) return; seenStep.add(x.title); steps.push({ ...x, suggestionId: suggestionId(projectId, x.title) }); };
  for (const r of high) { const t = RISK_STEP[r.id]; if (t) add({ ...t, body: `${r.text}. Found at ${r.file}:${r.line}.`, kind: "fix", severity: r.level === "critical" ? "critical" : "high", files: [r.file] }); }
  if (!ev.install.ok && ev.install.notes.length) add({ title: "Make the app install cleanly on a fresh computer", body: `Installing it here had problems: ${ev.install.notes.join("; ").slice(0, 500)}. Until that works nobody (and no agent) can run it.`, kind: "fix", lens: "reliability", severity: "high", effort: "small", files: [] });
  if (ev.tests.ran && ev.tests.failed) add({ title: "Fix the failing tests", body: `${ev.tests.failed} of the repo's own tests fail: ${ev.tests.failing.slice(0, 5).join("; ")}.`, kind: "fix", lens: "tests", severity: "high", effort: "medium", files: [] });
  if (brokenRoutes) add({ title: "Fix the routes that answer with a server error", body: `These answered 500 when the app ran here: ${ev.endpoints.filter((e) => (e.status ?? 0) >= 500).map((e) => `${e.path} (${e.file})`).join(", ")}.`, kind: "fix", lens: "reliability", severity: "high", effort: "medium", files: ev.endpoints.filter((e) => (e.status ?? 0) >= 500).map((e) => e.file) });
  if (vuln) add({ title: "Update the packages with known vulnerabilities", body: ev.dependencies.reports.filter((r) => r.vulnerable.length).map((r) => `${r.tool}: ${r.vulnerable.slice(0, 6).map((v) => `${v.name} (${v.detail || v.severity})`).join("; ")}`).join(". "), kind: "fix", lens: "security", severity: "high", effort: "small", files: [] });
  if (!ev.tests.ran) add({ title: "Add a first test for the main flow", body: `${ev.tests.note}. One test that starts the app and opens its main page catches most breakage.`, kind: "improvement", lens: "tests", severity: "medium", effort: "medium", files: [] });
  if (ev.dependencies.unpinned.length) add({ title: "Pin the Python packages to exact versions", body: `${ev.dependencies.unpinned.length} packages have no exact version (${ev.dependencies.unpinned.slice(0, 6).join(", ")}), so every install can differ.`, kind: "improvement", lens: "reliability", severity: "low", effort: "small", files: ["requirements.txt"] });
  const answered = new Set(notes.filter((n) => n.kind === "answer").map((n) => n.question));
  const questions: ReviewQuestion[] = [
    { id: "Q1", question: "What is this app for, in your own words?", why: "The verdict judges the code against its purpose, and the practice crew can only guess it.", guess: u.purpose },
    { id: "Q2", question: "Who uses it, and how often?", why: "An app for one person a month and one for paying customers deserve different amounts of care.", guess: u.users || "Not known." },
    { id: "Q3", question: "Is it running anywhere today (a live site, a server, only your PC)?", why: "Live users make a rewrite riskier and a fix more urgent.", guess: ev.integrations.filter((i) => i.kind === "hosting").map((i) => i.name).join(", ") || "No sign of hosting in the code." },
    { id: "Q4", question: "What do you want from it next: keep it alive, grow it, or fold it into another project?", why: "This decides whether to fix, to refactor, or to rewrite it on your main stack.", guess: "Not known." },
    ...ev.integrations.filter((i) => i.kind !== "hosting" && i.kind !== "database").slice(0, 2).map((i, k) => ({ id: `Q${5 + k}`, question: `Is ${i.name} still in use?`, why: "A service nobody uses any more is code and risk to delete.", guess: `The code still has it (${i.evidence[0] ?? "found in the code"}).` })),
  ].filter((q) => !answered.has(q.question));
  const why = (parts: string[]) => parts.filter(Boolean).join(" ");
  return {
    headline: call === "keep" ? "Worth keeping: it holds together, with a short list of fixes." : call === "refactor" ? "Keep the app, but rework the weak parts before building on it." : "Starting over would likely be cheaper than repairing this.",
    scores: {
      codeHealth: { score: codeHealth, why: why([`The static scan gives ${map.health.score}/100.`, high.length ? `${high.length} high-risk line${high.length === 1 ? "" : "s"}.` : "No high-risk lines.", vuln ? `${vuln} vulnerable package${vuln === 1 ? "" : "s"}.` : "", ev.tests.ran ? `Tests: ${ev.tests.passed} pass, ${ev.tests.failed} fail.` : "Its tests were not run."]) },
      goalFit: { score: goalFit, why: ev.site.started ? `The app ran here: ${ev.site.note}. ${working} of ${u.features.length} features were seen working.` : `The app was not seen running (${ev.site.note}), so this is a guess from the code.` },
      costToFix: { score: costToFix, why: why([`${steps.filter((x) => x.kind === "fix").length} fixes to make.`, `${map.lines.toLocaleString("en-US")} lines to keep in mind.`, ev.install.ok ? "" : "It does not install cleanly."]) },
    },
    recommendation: {
      call, confidence: "low",
      why: `From measurements only: code health ${codeHealth}/100, cost to fix ${costToFix}/100. The practice crew does not read the code's logic; the real crew gives a reasoned call.`,
      ifKeep: steps.length ? `Start with: ${steps.slice(0, 3).map((x) => x.title).join("; ")}.` : "Nothing urgent was found.",
      ifRewrite: `A rewrite must carry over ${u.features.length} feature${u.features.length === 1 ? "" : "s"} and ${ev.endpoints.length} route${ev.endpoints.length === 1 ? "" : "s"}${ev.integrations.length ? `, and reconnect ${ev.integrations.map((i) => i.name).slice(0, 5).join(", ")}` : ""}.`,
    },
    stack: { call: "keep", advice: `It is built on ${u.stack} The practice crew does not judge stacks; the real crew compares it with your other projects.`, suite: "" },
    gaps: [
      ...ev.endpoints.filter((e) => (e.status ?? 0) >= 500).slice(0, 4).map((e) => ({ title: `${e.path} answers with a server error`, detail: `The route exists in ${e.file} but failed when asked (status ${e.status}).`, level: "high" as const })),
      ...(!ev.site.started ? [{ title: "The app was not seen running", detail: ev.site.note, level: "medium" as const }] : []),
    ],
    strengths: [ev.tests.ran && !ev.tests.failed ? `All ${ev.tests.passed} of its own tests pass.` : "", ev.site.started ? "It starts and serves its pages." : "", !high.length ? "No high-risk lines were found." : ""].filter(Boolean),
    nextSteps: steps, questions,
  };
}

/** Give every next step the id its suggestion will have, so the page can show what became of it. */
export function withStepIds(projectId: number, v: RepoVerdict): RepoVerdict {
  return { ...v, nextSteps: v.nextSteps.map((n) => ({ ...n, suggestionId: suggestionId(projectId, n.title) })) };
}

/** Where the brief lives in the repo. */
export const BRIEF_PATH = "docs/softwarefactory/REVIEW.md";

const band = (n: number) => (n >= 75 ? "high" : n >= 45 ? "medium" : "low");

/**
 * The review as one Markdown file: the starting brief for anyone who works on the repo next, a person, a
 * SoftwareFactory agent or an outside tool such as Claude Code. Plain facts first, opinions marked as such.
 */
export function briefMarkdown(x: { name: string; source: string; head: string | null; ts: string; by: string; understanding: Understanding; verdict: RepoVerdict; evidence: Evidence; notes: OwnerNote[] }): string {
  const { understanding: u, verdict: v, evidence: ev } = x;
  const L: string[] = [];
  L.push(`# ${x.name}: review brief`, "", `Written by SoftwareFactory (${x.by}) on ${x.ts.slice(0, 10)}${x.head ? `, from commit \`${x.head.slice(0, 10)}\`` : ""}. Source: ${x.source}.`, "",
    "Read this before changing the code. It says what the app is, how it runs, what works, what does not, and what to do next. Where the owner corrected the review, their words win.", "");
  L.push("## What it is", "", u.purpose, "", `**Who uses it:** ${u.users || "not known"}`, "", `**How it is used:** ${u.usage || "not known"}`, "", `**Stack:** ${u.stack || ev.stack.join(", ")}`, "");
  L.push("## RepoVerdict", "", `**${v.recommendation.call.toUpperCase()}** (confidence ${v.recommendation.confidence}). ${v.headline}`, "", v.recommendation.why, "",
    "| Score | Value | Why |", "| --- | --- | --- |",
    `| Code health | ${v.scores.codeHealth.score}/100 | ${v.scores.codeHealth.why.replace(/\|/g, "/")} |`,
    `| Fit with its purpose | ${v.scores.goalFit.score}/100 | ${v.scores.goalFit.why.replace(/\|/g, "/")} |`,
    `| Cost to fix | ${v.scores.costToFix.score}/100 (${band(v.scores.costToFix.score)}) | ${v.scores.costToFix.why.replace(/\|/g, "/")} |`, "",
    v.recommendation.ifKeep ? `**If kept:** ${v.recommendation.ifKeep}` : "", "", v.recommendation.ifRewrite ? `**If rewritten:** ${v.recommendation.ifRewrite}` : "", "",
    `**Stack advice (${v.stack.call}):** ${v.stack.advice}${v.stack.suite ? ` ${v.stack.suite}` : ""}`, "");
  if (v.strengths.length) L.push("**Strengths:**", "", ...v.strengths.map((t) => `- ${t}`), "");
  if (u.features.length) L.push("## Features", "", "| Feature | State | What it does | Where |", "| --- | --- | --- | --- |", ...u.features.map((f) => `| ${f.name} | ${f.state} | ${f.what.replace(/\|/g, "/")} | ${f.where.slice(0, 3).map((w) => `\`${w}\``).join(", ")} |`), "");
  if (u.flow.steps.length) {
    const name = new Map(u.flow.steps.map((st) => [st.id, st.name]));
    L.push("## App flow", "", ...u.flow.steps.map((st, i) => `${i + 1}. **${st.name}**${st.route ? ` (\`${st.route}\`)` : ""} [${st.kind}, ${st.state === "seen" ? "seen working" : st.state === "broken" ? "BROKEN" : "in the code, not seen running"}]: ${st.what}`), "");
    if (u.flow.links.length) L.push(`Paths: ${u.flow.links.map((l) => `${name.get(l.from)} → ${name.get(l.to)}${l.label ? ` (${l.label})` : ""}`).join("; ")}.`, "");
  }
  if (v.gaps.length) L.push("## Where the flow falls short of the purpose", "", ...v.gaps.map((g) => `- **[${g.level}] ${g.title}.** ${g.detail}`), "");
  if (ev.endpoints.length) L.push("## Routes", "", "| Method | Path | File | Answered |", "| --- | --- | --- | --- |", ...ev.endpoints.slice(0, 80).map((e) => `| ${e.method} | \`${e.path}\` | \`${e.file}:${e.line}\` | ${e.status ?? ""} |`), "");
  if (u.data.length) L.push("## Data it keeps", "", ...u.data.map((d) => `- **${d.name}**: ${d.what}${d.where ? ` (\`${d.where}\`)` : ""}`), "");
  if (u.integrations.length || ev.integrations.length) L.push("## Outside services", "", ...(u.integrations.length ? u.integrations.map((i) => `- **${i.name}** (${i.state}): ${i.what}`) : ev.integrations.map((i) => `- **${i.name}** (${i.kind}): ${i.evidence.join("; ")}`)), "");
  if (ev.envVars.length) L.push(`**Settings it reads from the environment:** ${ev.envVars.map((e) => `\`${e}\``).join(", ")}`, "");
  L.push("## What running it showed", "", `- Install: ${ev.install.ok ? "worked" : ev.install.notes.join("; ")}`, `- Tests: ${ev.tests.note}${ev.tests.failing.length ? `. Failing: ${ev.tests.failing.slice(0, 8).join("; ")}` : ""}`,
    `- Running${ev.site.command ? ` (\`${ev.site.command}\`)` : ""}: ${ev.site.started ? ev.site.note : `not seen running: ${ev.site.note}`}`,
    ...ev.dependencies.reports.map((r) => `- ${r.tool}: ${r.note}`), "");
  if (ev.risks.length) L.push("## Risky lines", "", ...ev.risks.slice(0, 25).map((r) => `- [${r.level}] ${r.text} (\`${r.file}:${r.line}\`)`), "");
  if (v.nextSteps.length) L.push("## Next steps", "", "Each is a ticket in SoftwareFactory that waits for the owner's approval. Nothing here has been started.", "", ...v.nextSteps.map((n, i) => `${i + 1}. **${n.title}** (${n.kind}, ${n.severity}, ${n.effort} effort). ${n.body}${n.files.length ? ` Files: ${n.files.slice(0, 5).map((f) => `\`${f}\``).join(", ")}.` : ""}`), "");
  if (x.notes.length) L.push("## What the owner said", "", ...x.notes.map((n) => (n.kind === "answer" ? `- **${n.question}** ${n.text}` : `- About ${n.about}: ${n.text}`)), "");
  if (v.questions.length) L.push("## Still open", "", ...v.questions.map((q) => `- ${q.question} (assumed: ${q.guess || "nothing"})`), "");
  if (u.unsure.length) L.push("## Not settled from the code", "", ...u.unsure.map((t) => `- ${t}`), "");
  return `${L.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

/** The brief cut down to what a working agent needs in its prompt (a ticket's Builder, an engine run's Designer). */
export function briefForAgents(u: Understanding, v: RepoVerdict, notes: OwnerNote[], maxChars = 2600): string {
  const L = [
    `Purpose: ${u.purpose}`, u.users ? `Users: ${u.users}` : "", u.usage ? `Usage: ${u.usage}` : "", u.stack ? `Stack: ${u.stack}` : "",
    `RepoVerdict: ${v.recommendation.call} (${v.recommendation.confidence} confidence). ${v.headline}`,
    v.stack.advice ? `Stack advice: ${v.stack.advice}` : "",
    u.features.length ? `Features: ${u.features.map((f) => `${f.name} [${f.state}]`).join("; ")}` : "",
    v.gaps.length ? `Known gaps: ${v.gaps.map((g) => g.title).join("; ")}` : "",
    notes.length ? `The owner said: ${notes.slice(-8).map((n) => (n.kind === "answer" ? `${n.question} ${n.text}` : `${n.about}: ${n.text}`)).join(" | ")}` : "",
  ].filter(Boolean).join("\n");
  return L.length > maxChars ? `${L.slice(0, maxChars)}\n[...]` : L;
}

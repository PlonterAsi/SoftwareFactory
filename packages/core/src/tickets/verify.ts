import type { EventLog } from "../events.js";
/**
 * Verification (asked by Assaf, 20 Nov 2026): a ticket that waits for your look says how it was tested, how to test it
 * again, how you can see it works, and which layers were changed and whether each was really tested: backend, UI,
 * database, tests, config, docs. The crew fills it from what actually ran in its pass, never from what it claims; only
 * "how to verify" (the steps a person follows) is the Builder's own words. A layer that was changed but not tested is
 * flagged, so "built" never hides an untested screen or migration.
 */

export const LAYERS = ["Backend", "UI", "Database", "Tests", "Config", "Docs"] as const;
export type Layer = (typeof LAYERS)[number];
export type Tested = "yes" | "partly" | "no" | "n/a";

export interface LayerCheck { layer: Layer; files: string[]; tested: Tested; how: string }
export interface CheckRow { name: string; state: string; note: string }
export interface Verification {
  /** Which route did the work: one Builder session in the repo, or an engine run. */
  route: "session" | "engine";
  run?: number;
  layers: LayerCheck[];
  checks: CheckRow[];
  /** Commands that test it again, from what ran. */
  howToTest: string[];
  /** What a person does to see that it works (the Builder's steps, or the ticket's expected result). */
  howToVerify: string[];
  /** Changed layers no check tested. */
  untested: Layer[];
}

/** Which layer a changed file belongs to, by its path. */
export function layerOf(path: string): Layer {
  const p = path.replace(/\\/g, "/").toLowerCase();
  if (/(^|\/)(test|tests|__tests__|e2e|spec)\/|\.(test|spec)\.[a-z]+$/.test(p)) return "Tests";
  if (/\.md$|(^|\/)docs\//.test(p)) return "Docs";
  if (/\.sql$|(^|\/)(migrations?|db|database|prisma)\/|(^|\/)(tables|schema|storage|projection|migrate)[^/]*\.[a-z]+$/.test(p)) return "Database";
  if (/\.(tsx|jsx|vue|svelte|css|scss|html)$|(^|\/)(apps\/[^/]+\/src|web|ui|views|components|pages|styles|public)\//.test(p)) return "UI";
  if (/\.(json|ya?ml|toml|lock|ini|env\.example)$|(^|\/)(\.github|\.claude)\/|(^|\/)(dockerfile|makefile)$/.test(p)) return "Config";
  return "Backend";
}

/** The Builder's "How to verify:" steps from its answer: the lines under that heading, up to 5. */
export function howToVerifyFrom(text: string): string[] {
  const m = text.match(/how to verify\s*:?\s*\**\s*\n?([\s\S]*)$/i);
  if (!m) return [];
  const out: string[] = [];
  for (const raw of m[1].split("\n")) {
    const l = raw.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim();
    if (!l) { if (out.length) break; continue; }
    if (/^<<<|^```|^#{1,6}\s/.test(l)) break;
    out.push(l.slice(0, 300));
    if (out.length >= 5) break;
  }
  return out;
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/**
 * The verification of one pass, from the files it changed and the checks that ran (name, state, note as the harness
 * logged them). `screens`: a check opened the screens in a real browser (engine runs); `expected`: the ticket's own
 * expected result, the fallback for how to verify.
 */
export function buildVerification(o: {
  route: "session" | "engine"; run?: number; files: string[]; checks: CheckRow[]; builderText?: string; expected?: string;
  screens?: { pass: boolean; count: number } | null;
}): Verification {
  const by = new Map<Layer, string[]>();
  for (const f of o.files) by.set(layerOf(f), [...(by.get(layerOf(f)) ?? []), f]);
  const state = (n: string) => o.checks.find((c) => c.name === n);
  const tests = state("tests");
  const testsRan = tests?.state === "passed";
  const testsNote = tests?.note?.trim() || (o.route === "engine" ? "the repo's own tests" : "the changed packages' tests");
  const gates = state("gates")?.state === "passed";
  const newTests = (by.get("Tests") ?? []).length > 0;
  const layers: LayerCheck[] = [];
  for (const layer of LAYERS) {
    const files = by.get(layer);
    if (!files?.length) continue;
    let tested: Tested;
    let how: string;
    if (layer === "Docs" || layer === "Config") {
      tested = "n/a"; how = layer === "Docs" ? "Documentation: nothing to run." : gates ? "No test applies; the fast gates read it." : "No test applies.";
    } else if (layer === "Tests") {
      tested = testsRan ? "yes" : "no"; how = testsRan ? `The new or changed tests ran and passed (${testsNote}).` : `Written, but not run: ${tests ? `the tests step was ${tests.state}${tests.note ? ` (${tests.note.split("\n")[0].slice(0, 160)})` : ""}` : "no tests step ran"}.`;
    } else if (layer === "UI" && o.screens) {
      tested = o.screens.pass ? "yes" : "no";
      how = o.screens.pass ? `Every screen (${plural(o.screens.count, "screen")}) was opened in a real browser and its code ran without errors.` : "A screen failed to open cleanly in the browser check.";
    } else if (testsRan) {
      tested = newTests ? (layer === "UI" ? "partly" : "yes") : "partly";
      how = newTests
        ? layer === "UI" ? `Tests ran and passed (${testsNote}), but no check opened the screen: look at it yourself.` : `Tests ran and passed, including new or changed tests (${testsNote}).`
        : `The existing tests passed (${testsNote}), but no new test covers this change${layer === "UI" ? ", and no check opened the screen" : ""}.`;
    } else {
      tested = "no";
      how = `${gates ? "Only the fast gates (typecheck, lint) read it; " : ""}no test ran${tests && tests.state !== "passed" ? ` (tests ${tests.state}${tests.note ? `: ${tests.note.split("\n")[0].slice(0, 160)}` : ""})` : ""}${layer === "UI" ? ", and no check opened the screen" : ""}.`;
    }
    layers.push({ layer, files: files.slice(0, 50), tested, how });
  }
  const howToTest: string[] = [];
  if (testsRan && tests?.note) for (const l of tests.note.split("\n").map((x) => x.trim()).filter(Boolean).slice(0, 4)) howToTest.push(l);
  else if (testsRan) howToTest.push(o.route === "engine" ? "Run the repo's own tests (npm test)." : "Run npm test in each changed package.");
  if (gates) howToTest.push("Typecheck and lint the changed files (the fast gates).");
  const fromBuilder = o.builderText ? howToVerifyFrom(o.builderText) : [];
  const howToVerify = fromBuilder.length ? fromBuilder : o.expected?.trim() ? [`Check that: ${o.expected.trim().slice(0, 300)}`] : [];
  return {
    route: o.route, ...(o.run != null ? { run: o.run } : {}), layers, checks: o.checks.map((c) => ({ name: c.name, state: c.state, note: (c.note ?? "").slice(0, 400) })),
    howToTest, howToVerify, untested: layers.filter((l) => l.tested === "no").map((l) => l.layer),
  };
}

/** Told to the Builder: end its answer with the steps a person follows to see the change works. */
export const VERIFY_ASK = "End your answer with a line `How to verify:` and 1 to 3 short steps a person can follow to see it works (what to open or run, what to do, what they should see).";

/** What an engine run checked, for its verification: its test report and its browser check of the screens. */
export function engineChecks(log: EventLog, run: number): { checks: CheckRow[]; screens: { pass: boolean; count: number } | null } {
  const last = (type: string) => {
    const r = log.db.prepare("SELECT payload FROM events WHERE type = ? AND json_extract(payload, '$.run') = ? ORDER BY id DESC LIMIT 1").get(type, run) as { payload: string } | undefined;
    return r ? JSON.parse(r.payload) as Record<string, any> : null;
  };
  const tp = last("factory.tests");
  const sc = last("factory.screens");
  const checks: CheckRow[] = [tp
    ? { name: "tests", state: tp.failed ? "failed" : tp.passed ? "passed" : "skipped", note: `${tp.passed ?? 0} tests green${tp.failed ? `, ${tp.failed} red` : ""} in run #${run} (the repo's own tests, no secrets, no test removed)` }
    : { name: "tests", state: "skipped", note: "no test report" }];
  if (sc && !sc.skipped) checks.push({ name: "screens", state: sc.pass ? "passed" : "failed", note: `${(sc.screens ?? []).length} screen(s) opened in ${sc.browser ?? "a browser"}` });
  return { checks, screens: sc && !sc.skipped ? { pass: !!sc.pass, count: (sc.screens ?? []).length } : null };
}

/** The newest verification of a ticket, with when and by whom, or null. */
export function verificationOf(log: EventLog, id: number): (Verification & { at: string; by: string }) | null {
  const r = log.db.prepare("SELECT ts, payload FROM events WHERE type = 'ticket.verification' AND json_extract(payload, '$.id') = ? ORDER BY id DESC LIMIT 1").get(id) as { ts: string; payload: string } | undefined;
  if (!r) return null;
  const { id: _id, by, ...v } = JSON.parse(r.payload) as Verification & { id: number; by: string };
  return { ...v, at: r.ts, by };
}

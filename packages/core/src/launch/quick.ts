import { detectProfiles, type RunProfile } from "./detect.js";
import { makeSamples, type SampleGuess } from "./files.js";
import { readUsage, type Usage, type UsageField } from "./usage.js";

/** What one press of Start does: which way to run it, with what, and anything made for it first. */
export interface QuickPlan {
  profile: RunProfile;
  argv?: string[];
  stdin?: string;
  /** In words, for the person who pressed it. */
  why: string;
  /** Sample files written so it had something to work on. */
  made: SampleGuess[];
}

const fileExt = (f: UsageField) => (f.hint && /\.(\w+)$/.test(f.hint) ? f.hint.match(/\.(\w+)$/)![1] : f.label.match(/\b(csv|tsv|json|txt|md|log)\b/i)?.[1])?.toLowerCase();
const wantFor = (ext: string | undefined): "table" | "json" | "text" | undefined => (ext === "csv" || ext === "tsv" ? "table" : ext === "json" ? "json" : ext ? "text" : undefined);

/** The example a single Start runs: one that passes files first, then sample text, then a plain run. */
function bestExample(u: Usage) {
  return u.examples.find((e) => e.argv.length) ?? u.examples.find((e) => e.stdin) ?? u.examples.find((e) => !e.argv.length && !u.fields.some((f) => f.required));
}

/**
 * Plan a run that needs nothing from the person: the project's best way to run,
 * and for a command-line tool, real inputs (its own examples, its sample files,
 * or samples made now from its tests and spec). Throws with a plain reason when
 * there is truly nothing it can run on.
 */
export function planQuickRun(dir: string, profileId?: string): QuickPlan {
  const det = detectProfiles(dir);
  if (!det.exists) throw new Error(`There is no folder at ${dir}`);
  const profile = (profileId ? det.profiles.find((p) => p.id === profileId) : null)
    ?? det.profiles.find((p) => p.recommended) ?? det.profiles.find((p) => !p.utility);
  if (!profile) throw new Error(`Nothing to run was found in ${dir}: no package.json start, bin/ tool, index.html, or Python, Rust or Go entry point.`);
  if (profile.kind !== "cli") return { profile, why: profile.kind === "static" ? "Showing its pages." : `Started ${profile.label === "The app" ? "the app" : profile.label}.`, made: [] };

  let u = readUsage(dir, profile);
  let ex = bestExample(u);
  let made: SampleGuess[] = [];
  if (!ex || (!ex.argv.length && !ex.stdin && u.fields.some((f) => f.type === "file"))) {
    // It needs a file nobody has given it: make one from what its tests and spec show.
    const need = u.fields.find((f) => f.type === "file" && !f.suggestions?.length) ?? u.fields.find((f) => f.type === "file");
    made = makeSamples(dir, { want: wantFor(need ? fileExt(need) : undefined) });
    if (!made.length && need) made = makeSamples(dir, { want: "text" });
    if (made.length) { u = readUsage(dir, profile); ex = bestExample(u); }
  }
  if (!ex) {
    const missing = u.fields.filter((f) => f.required && !f.suggestions?.length).map((f) => f.label);
    throw new Error(missing.length
      ? `${profile.label} needs ${missing.join(", ")} and there is no sample to use. Fill in its form below, or press "Make sample data".`
      : `${profile.label} has no example run. Fill in its form below.`);
  }
  const files = ex.argv.filter((a) => /[\\/]/.test(a)).map((a) => a.split(/[\\/]/).pop());
  const why = made.length
    ? `Made ${made.map((m) => m.path).join(", ")} (from ${[...new Set(made.map((m) => m.from))].join(", ")}) and ran ${profile.label} on it. Open it under Data to change it.`
    : ex.stdin ? `Ran ${profile.label} on a sample text.` : files.length ? `Ran ${profile.label} on ${files.join(", ")} from the project.` : `Ran ${profile.label}: ${ex.label}.`;
  return { profile, argv: ex.argv, stdin: ex.stdin, why, made };
}

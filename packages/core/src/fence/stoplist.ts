/**
 * The stop list (docs/fence.md, "The stop list").
 *
 * Inside the fence a run is free. Some kinds of change still wait for the owner's own look before they leave the
 * computer, whatever the checks said: what touches security, what reaches outside or goes live, what touches live
 * data or money, what runs by itself, and a new package. A stop holds that one result; the factory goes on.
 * The list is closed: the families are fixed here, and Settings can only add paths, never take one away.
 */
export type StopFamily = "security" | "leaves the computer" | "live data and money" | "runs by itself" | "new package";

export interface Stop { family: StopFamily; file: string; why: string }

interface PathRule { family: StopFamily; re: RegExp; why: string }

/**
 * The fixed part of the list, by path. Matched against every changed file's full path, forward slashes, whatever
 * its case (the owner's computer does not tell `.Claude` from `.claude`). A folder rule also matches the bare
 * name, so a link that stands where the folder would be is caught too.
 */
export const STOP_PATHS: PathRule[] = [
  { family: "security", re: /(^|\/)(\.claude|\.cursor|\.windsurf|\.vscode|\.devcontainer|\.idea)(\/|$)/i, why: "the project's own settings for AI agents and editors" },
  { family: "security", re: /(^|\/)((CLAUDE|AGENTS|GEMINI)(\.[^/]*)?\.md|\.mcp\.json|\.cursorrules|\.windsurfrules)$/i, why: "the rules and tools every later agent in this project gets" },
  { family: "security", re: /(^|\/)\.env(\.[^/]*)?$/i, why: "a file that usually holds keys and passwords" },
  { family: "security", re: /(^|\/)(id_(rsa|dsa|ecdsa|ed25519)|[^/]*\.(pem|key|p12|pfx|keystore|jks))$/i, why: "a key file" },
  { family: "security", re: /(^|\/)(\.npmrc|\.pypirc|\.netrc|\.yarnrc(\.yml)?|bunfig\.toml|pip\.conf)$/i, why: "where packages come from and with which sign-in" },
  { family: "security", re: /(^|\/)CODEOWNERS$/i, why: "who must approve changes" },
  { family: "leaves the computer", re: /(^|\/)(Dockerfile[^/]*|Containerfile[^/]*|[^/]*\.dockerfile|docker-compose[^/]*\.ya?ml|compose\.ya?ml|Procfile|fly\.toml|vercel\.json|netlify\.toml|render\.ya?ml|railway\.(json|toml)|app\.ya?ml|serverless\.ya?ml|wrangler\.(toml|jsonc?)|\.goreleaser\.ya?ml|deploy[^/]*\.(sh|ps1|cmd|bat))$/i, why: "how the project is put live" },
  { family: "leaves the computer", re: /(^|\/)[^/]*\.(tf|tfvars)$|(^|\/)(k8s|kubernetes|helm|deploy|deployment|infra|terraform)(\/|$)/i, why: "the machines the project runs on" },
  { family: "live data and money", re: /(^|\/)(migrations?|migrate)(\/|$)|(^|\/)[^/]*\.sql$/i, why: "a change to stored data" },
  { family: "runs by itself", re: /(^|\/)(\.husky|\.githooks)(\/|$)|(^|\/)\.git\/hooks(\/|$)|(^|\/)(\.gitlab-ci\.yml|\.circleci(\/.*)?|azure-pipelines\.yml|Jenkinsfile|\.pre-commit-config\.yaml|lefthook(-local)?\.ya?ml|crontab|[^/]*\.cron)$/i, why: "something that runs without anyone pressing" },
  { family: "runs by itself", re: /(^|\/)(Makefile|justfile|Taskfile\.ya?ml)$/i, why: "commands people and machines run by name" },
  { family: "new package", re: /(^|\/)(requirements[^/]*\.txt|pyproject\.toml|setup\.(py|cfg)|Pipfile|Gemfile|Cargo\.toml|composer\.json|pom\.xml|build\.gradle(\.kts)?|package\.json5|package\.ya?ml|pnpm-workspace\.yaml|\.pnpmfile\.cjs|go\.work)$/i, why: "the list of packages the project pulls in" },
  { family: "new package", re: /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|go\.work\.sum|poetry\.lock|uv\.lock|Pipfile\.lock|Cargo\.lock|Gemfile\.lock|composer\.lock)$/i, why: "the exact packages and addresses an install fetches" },
  { family: "new package", re: /(^|\/)(vendor|\.yarn|node_modules)(\/|$)/i, why: "packages kept inside the project" },
];

/**
 * Rules by word. A name is cut into its words first (`PaymentForm` is "payment form", `StripedTable` is
 * "striped table"), so "stripe" does not stop a striped table.
 */
const STOP_WORDS: PathRule[] = [
  { family: "security", re: /(^|[^a-z])(auth|authn|authz|oauth|jwt|login|passwords?|permissions?|rbac|acl|crypto|secrets?|vault)([^a-z]|$)/, why: "sign-in, rights or secrets" },
  { family: "live data and money", re: /(^|[^a-z])(payments?|payouts?|billing|invoices?|checkout|stripe|paypal|lemon[-_ ]?squeezy|paddle|wallets?|ledgers?)([^a-z]|$)/, why: "money" },
];
const words = (path: string) => path.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();

/** Scripts npm runs by itself when packages are installed or the package is published. */
const LIFECYCLE = ["preinstall", "install", "postinstall", "preprepare", "prepare", "postprepare", "prepublish", "prepublishOnly", "prepack", "postpack", "dependencies"];
const DEP_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "overrides", "resolutions"];
/** Other fields that decide what an install fetches or runs. */
const FETCH_FIELDS = ["packageManager", "pnpm", "workspaces", "bundledDependencies", "bundleDependencies", "publishConfig"];

/** One extra path from Settings: plain text, matched anywhere in the path, case does not matter. */
export const cleanExtra = (list: unknown): string[] => (Array.isArray(list) ? list : []).filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter((x) => x.length > 0 && x.length <= 200 && !/[\r\n\0]/.test(x)).slice(0, 100);

const json = (text: string | null): Record<string, any> | null => { try { const j = JSON.parse(text ?? ""); return j && typeof j === "object" && !Array.isArray(j) ? j : null; } catch { return null; } };

/** What a changed package.json changed that waits for a look: a new or moved package, or a script npm runs by itself. */
export function packageStops(file: string, was: string | null, now: string | null): Stop[] {
  const a = json(was) ?? {}, b = json(now);
  // A package.json that cannot be read is not waved through.
  if (now !== null && !b) return [{ family: "new package", file, why: "the package list cannot be read, so what it pulls in is not known" }];
  if (!b) return [];
  const out: Stop[] = [];
  for (const f of DEP_FIELDS) {
    const x = (a[f] && typeof a[f] === "object" ? a[f] : {}) as Record<string, unknown>, y = (b[f] && typeof b[f] === "object" ? b[f] : {}) as Record<string, unknown>;
    for (const name of Object.keys(y)) if (JSON.stringify(x[name]) !== JSON.stringify(y[name])) out.push({ family: "new package", file, why: x[name] === undefined ? `a new package: ${name}` : `another version or source of ${name}` });
  }
  for (const f of FETCH_FIELDS) if (b[f] !== undefined && JSON.stringify(a[f]) !== JSON.stringify(b[f])) out.push({ family: "new package", file, why: `"${f}", which decides what an install fetches` });
  const x = (a.scripts && typeof a.scripts === "object" ? a.scripts : {}) as Record<string, unknown>, y = (b.scripts && typeof b.scripts === "object" ? b.scripts : {}) as Record<string, unknown>;
  for (const k of LIFECYCLE) if (x[k] !== y[k] && y[k] !== undefined) out.push({ family: "runs by itself", file, why: `the "${k}" command, which npm runs by itself` });
  return out;
}

/** A changed go.mod: every line that was not there before. Nothing in that file is small. */
export function goModStops(file: string, was: string | null, now: string | null): Stop[] {
  const lines = (t: string | null) => (t ?? "").split("\n").map((l) => l.replace(/\/\/.*$/, "").replace(/\s+/g, " ").trim()).filter((l) => l && l !== ")" && !/^(require|replace|exclude|retract|tool|godebug) \($/.test(l));
  const a = new Set(lines(was));
  return lines(now).filter((l) => !a.has(l)).map((l) => ({ family: "new package" as const, file, why: `a new line in the module list: ${l}` }));
}

/**
 * Every stop in a result. `changed` is the list of changed files. `read` gives a file's text before and after:
 * null when it is not there, and it throws when it is there and cannot be read (that file is then held, never
 * waved through). `links` names the changed entries that are a link or another project inside this one.
 * Nothing of the result is run to find this out.
 */
export function stopsFor(changed: string[], read: (file: string, when: "before" | "after") => string | null, extra: string[] = [], links: string[] = []): Stop[] {
  const out: Stop[] = [];
  const more = cleanExtra(extra).map((x) => x.toLowerCase());
  const both = (file: string, f: (file: string, was: string | null, now: string | null) => Stop[]) => {
    try { out.push(...f(file, read(file, "before"), read(file, "after"))); }
    catch { out.push({ family: "new package", file, why: "it could not be read, so what it pulls in is not known" }); }
  };
  for (const file of changed) {
    if (links.includes(file)) out.push({ family: "security", file, why: "a link to another place, or another project inside this one" });
    const w = words(file);
    const rule = STOP_PATHS.find((r) => r.re.test(file)) ?? STOP_WORDS.find((r) => r.re.test(w));
    if (rule) out.push({ family: rule.family, file, why: rule.why });
    const mine = more.find((x) => file.toLowerCase().includes(x));
    if (mine) out.push({ family: "security", file, why: `on your own stop list ("${mine}")` });
    if (/(^|\/)package\.json$/i.test(file)) both(file, packageStops);
    if (/(^|\/)go\.mod$/i.test(file)) both(file, goModStops);
  }
  // One line per file and reason, never an endless list, and no line longer than a line.
  const seen = new Set<string>();
  return out.map((s) => ({ family: s.family, file: s.file.slice(0, 300), why: s.why.slice(0, 200) })).filter((s) => { const k = `${s.file}\n${s.why}`; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 40);
}

/** The stops as one sentence for the ticket. */
export function stopSentence(stops: Stop[]): string {
  const first = stops[0]!;
  return `it waits for your look before it leaves: ${first.file} (${first.why})${stops.length > 1 ? `, and ${stops.length - 1} more` : ""}`;
}

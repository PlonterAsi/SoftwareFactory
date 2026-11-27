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

/** The fixed part of the list, by path. Matched against every changed file's full path, forward slashes. */
export const STOP_PATHS: PathRule[] = [
  { family: "security", re: /(^|\/)\.claude\//, why: "the project's own settings for AI agents" },
  { family: "security", re: /(^|\/)(CLAUDE|AGENTS|GEMINI)\.md$/i, why: "the rules every later agent in this project reads" },
  { family: "security", re: /(^|\/)\.env(\.[^/]*)?$/, why: "a file of keys and passwords" },
  { family: "security", re: /(^|\/)(id_(rsa|dsa|ecdsa|ed25519)|[^/]*\.(pem|key|p12|pfx|keystore|jks))$/i, why: "a key file" },
  { family: "security", re: /(^|\/)(\.npmrc|\.pypirc|\.netrc|\.yarnrc(\.yml)?)$/, why: "where packages come from and with which sign-in" },
  { family: "security", re: /(^|\/)CODEOWNERS$/, why: "who must approve changes" },
  { family: "security", re: /(^|\/)(auth|authn|authz|permissions?|rbac|acl|crypto|secrets?|vault)(\/|\.[a-z]+$)/i, why: "sign-in, rights or secrets" },
  { family: "leaves the computer", re: /(^|\/)(Dockerfile[^/]*|docker-compose[^/]*\.ya?ml|compose\.ya?ml|Procfile|fly\.toml|vercel\.json|netlify\.toml|render\.ya?ml|railway\.(json|toml)|app\.ya?ml|serverless\.ya?ml|wrangler\.toml)$/i, why: "how the project is put live" },
  { family: "leaves the computer", re: /(^|\/)[^/]*\.(tf|tfvars)$|(^|\/)(k8s|kubernetes|helm|deploy|deployment|infra|terraform)\//i, why: "the machines the project runs on" },
  { family: "live data and money", re: /(^|\/)(migrations?|migrate)\/|(^|\/)[^/]*\.sql$/i, why: "a change to stored data" },
  { family: "live data and money", re: /(payment|payout|billing|invoice|checkout|stripe|paypal|lemon[-_]?squeezy|paddle|wallet|ledger)/i, why: "money" },
  { family: "runs by itself", re: /(^|\/)(\.husky|\.githooks)\/|(^|\/)\.git\/hooks\/|(^|\/)(\.gitlab-ci\.yml|\.circleci\/.*|azure-pipelines\.yml|Jenkinsfile|\.pre-commit-config\.yaml|crontab|[^/]*\.cron)$/i, why: "something that runs without anyone pressing" },
  { family: "runs by itself", re: /(^|\/)(Makefile|justfile|Taskfile\.ya?ml)$/i, why: "commands people and machines run by name" },
  { family: "new package", re: /(^|\/)(requirements[^/]*\.txt|pyproject\.toml|Pipfile|Gemfile|Cargo\.toml|composer\.json|pom\.xml|build\.gradle(\.kts)?)$/i, why: "the list of packages the project pulls in" },
];

/** Scripts npm runs by itself when packages are installed or the package is published. */
const LIFECYCLE = ["preinstall", "install", "postinstall", "prepare", "prepublish", "prepublishOnly", "prepack", "postpack"];
const DEP_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "overrides", "resolutions"];

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
  const x = (a.scripts && typeof a.scripts === "object" ? a.scripts : {}) as Record<string, unknown>, y = (b.scripts && typeof b.scripts === "object" ? b.scripts : {}) as Record<string, unknown>;
  for (const k of LIFECYCLE) if (x[k] !== y[k] && y[k] !== undefined) out.push({ family: "runs by itself", file, why: `the "${k}" command, which npm runs by itself` });
  return out;
}

/** A changed go.mod: every module line that was not there before. */
export function goModStops(file: string, was: string | null, now: string | null): Stop[] {
  const mods = (t: string | null) => new Set((t ?? "").split("\n").map((l) => l.replace(/\/\/.*$/, "").trim()).filter((l) => /^(require\s+)?[\w.\-/~]+\.[\w.\-/~]+\S*\s+v\d/.test(l) || /^replace\s/.test(l)).map((l) => l.replace(/^require\s+/, "")));
  const a = mods(was);
  return [...mods(now)].filter((l) => !a.has(l)).map((l) => ({ family: "new package" as const, file, why: /^replace\s/.test(l) ? `a package taken from another place: ${l.slice(0, 80)}` : `a new or moved package: ${l.split(/\s+/)[0]}` }));
}

/**
 * Every stop in a result. `changed` is the list of changed files; `read` gives a file's text before and after
 * (null when it is not there). Nothing of the result is run to find this out.
 */
export function stopsFor(changed: string[], read: (file: string, when: "before" | "after") => string | null, extra: string[] = []): Stop[] {
  const out: Stop[] = [];
  const more = cleanExtra(extra).map((x) => x.toLowerCase());
  for (const file of changed) {
    for (const r of STOP_PATHS) if (r.re.test(file)) { out.push({ family: r.family, file, why: r.why }); break; }
    const mine = more.find((x) => file.toLowerCase().includes(x));
    if (mine) out.push({ family: "security", file, why: `on your own stop list ("${mine}")` });
    if (/(^|\/)package\.json$/.test(file)) out.push(...packageStops(file, read(file, "before"), read(file, "after")));
    if (/(^|\/)go\.mod$/.test(file)) out.push(...goModStops(file, read(file, "before"), read(file, "after")));
  }
  // One line per file and reason, and never an endless list.
  const seen = new Set<string>();
  return out.filter((s) => { const k = `${s.file}\n${s.why}`; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 40);
}

/** The stops as one sentence for the ticket. */
export function stopSentence(stops: Stop[]): string {
  const first = stops[0]!;
  return `it waits for your look before it leaves: ${first.file} (${first.why})${stops.length > 1 ? `, and ${stops.length - 1} more` : ""}`;
}

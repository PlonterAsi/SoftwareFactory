import { spawn, execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { prepareEnv, readPages, runRepoTests, siteProfile, withSite, type RepoEnv } from "../factory/repoenv.js";
import { killTree, projectEnv } from "../launch/launcher.js";
import { findSecrets } from "../safety/secrets.js";

/**
 * The free half of a deep review (docs/review.md): what the code and the running app prove, gathered
 * without any agent.
 *
 *   read   every route the code serves, every outside service it talks to, every setting it reads from
 *          the environment, and the risky lines a reviewer would circle;
 *   run    its packages are installed, its own tests are run, its site is started and its pages are
 *          opened, and every plain GET route is asked once, so "does it work" is seen and not guessed;
 *   check  its packages are looked up for known vulnerabilities, with the tool each stack already has.
 *
 * The agents that follow (the Inspector, then the Assessor) get this as fact. Whatever could not be done
 * is said in words on the review ("the site could not be started here: ..."), never passed over.
 */

export interface Endpoint {
  method: string;
  path: string;
  file: string;
  line: number;
  framework: string;
  /** What asking it answered while the app ran (GET routes without a parameter only). */
  status?: number | null;
}

export const INTEGRATION_KINDS = ["payments", "email", "database", "auth", "ai", "storage", "messaging", "analytics", "hosting", "api", "other"] as const;
export type IntegrationKind = (typeof INTEGRATION_KINDS)[number];
export interface RepoIntegration { id: string; name: string; kind: IntegrationKind; evidence: string[] }

export type RiskLevel = "critical" | "high" | "medium" | "low";
export interface RiskFinding { id: string; level: RiskLevel; text: string; file: string; line: number }

export interface DependencyReport {
  /** "npm audit", "pip-audit" */
  tool: string;
  ran: boolean;
  /** Why it could not run, or what it found in one line. */
  note: string;
  vulnerable: { name: string; severity: string; detail: string }[];
}

export interface PageSeen { route: string; text: string; controls: string[] }

export interface Evidence {
  /** The commit that was looked at. */
  head: string | null;
  stack: string[];
  install: { ok: boolean; notes: string[] };
  tests: { ran: boolean; passed: number; failed: number; failing: string[]; note: string };
  site: { started: boolean; note: string; command: string | null; pages: PageSeen[] };
  endpoints: Endpoint[];
  integrations: RepoIntegration[];
  envVars: string[];
  /** Hosts the code calls by name. */
  hosts: string[];
  risks: RiskFinding[];
  dependencies: { reports: DependencyReport[]; unpinned: string[]; total: number };
  ms: number;
}

const CODE_EXT = new Set([".py", ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".php", ".rb", ".go", ".java", ".kt", ".cs", ".html", ".htm", ".vue", ".svelte", ".jinja", ".j2"]);
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "out", "target", "vendor", ".venv", "venv", "env", "__pycache__", ".next", ".nuxt", ".cache", "coverage", ".sf", ".idea", ".vscode", "site-packages", "migrations"]);
const MAX_FILE = 400_000;

/** The code files of a working copy, as text: git's own list when it is a repo, else a walk. */
export function readCode(dir: string, maxFiles = 4000): Map<string, string> {
  let paths: string[] = [];
  try { paths = execFileSync("git", ["-C", dir, "ls-files", "-co", "--exclude-standard"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true, maxBuffer: 32 * 1024 * 1024 }).split("\n").filter(Boolean); } catch { /* not a repo */ }
  if (!paths.length) {
    const walk = (rel: string, depth: number) => {
      if (depth > 8 || paths.length > maxFiles * 4) return;
      let names: string[] = [];
      try { names = readdirSync(join(dir, rel)); } catch { return; }
      for (const n of names) {
        const p = rel ? `${rel}/${n}` : n;
        let st; try { st = statSync(join(dir, p)); } catch { continue; }
        if (st.isDirectory()) { if (!SKIP_DIRS.has(n)) walk(p, depth + 1); } else paths.push(p);
      }
    };
    walk("", 0);
  }
  const out = new Map<string, string>();
  for (const p of paths) {
    if (out.size >= maxFiles) break;
    if (p.split("/").some((s) => SKIP_DIRS.has(s))) continue;
    if (!CODE_EXT.has(extname(p).toLowerCase())) continue;
    if (/\.min\.(js|css)$/.test(p)) continue;
    try {
      const st = statSync(join(dir, p));
      if (!st.isFile() || st.size > MAX_FILE) continue;
      out.set(p, readFileSync(join(dir, p), "utf8"));
    } catch { /* gone */ }
  }
  return out;
}

const lineOf = (text: string, index: number) => text.slice(0, index).split("\n").length;
const isTest = (p: string) => /(^|\/)(tests?|__tests__|spec|e2e)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]*\.py$|_test\.py$/.test(p);

/** Every route the code serves, read from the way each web framework declares one. */
export function extractEndpoints(files: Map<string, string>): Endpoint[] {
  const out: Endpoint[] = [];
  const seen = new Set<string>();
  const add = (e: Endpoint) => {
    const path = e.path.startsWith("/") ? e.path : `/${e.path}`;
    const k = `${e.method} ${path}`;
    if (seen.has(k) || out.length >= 300) return;
    seen.add(k);
    out.push({ ...e, path });
  };
  for (const [file, text] of files) {
    if (isTest(file)) continue;
    const ext = extname(file).toLowerCase();
    if (ext === ".py") {
      // Flask and its blueprints: @app.route("/x", methods=["GET", "POST"]), @bp.get("/x")
      for (const m of text.matchAll(/@\s*(\w+)\.route\(\s*(['"])(.*?)\2([^)]*)\)/g)) {
        const methods = [...(m[4].match(/methods\s*=\s*[[(]([^\])]*)/)?.[1] ?? "'GET'").matchAll(/['"](\w+)['"]/g)].map((x) => x[1].toUpperCase());
        for (const method of methods.length ? methods : ["GET"]) add({ method, path: m[3], file, line: lineOf(text, m.index!), framework: "Flask" });
      }
      // FastAPI, and Flask 2's short forms.
      for (const m of text.matchAll(/@\s*(\w+)\.(get|post|put|patch|delete)\(\s*(['"])(.*?)\3/g)) add({ method: m[2].toUpperCase(), path: m[4], file, line: lineOf(text, m.index!), framework: /fastapi|APIRouter/.test(text) ? "FastAPI" : "Flask" });
      // Django: path("x/", view), re_path(r"^x/$", view)
      if (/urlpatterns/.test(text)) for (const m of text.matchAll(/\b(?:re_)?path\(\s*r?(['"])(.*?)\1/g)) add({ method: "ANY", path: m[2].replace(/^\^|\$$/g, ""), file, line: lineOf(text, m.index!), framework: "Django" });
    } else if ([".js", ".mjs", ".cjs", ".ts", ".jsx", ".tsx"].includes(ext)) {
      // Express, Koa routers, Fastify, Hono: app.get("/x", ...), router.post("/x", ...)
      for (const m of text.matchAll(/\b(app|router|server|api|fastify|route|routes)\.(get|post|put|patch|delete|all)\(\s*(['"`])(\/[^'"`]*)\3/g)) add({ method: m[2] === "all" ? "ANY" : m[2].toUpperCase(), path: m[4], file, line: lineOf(text, m.index!), framework: "Node" });
      // Next.js: a file is a route.
      const page = file.match(/(?:^|\/)(?:src\/)?pages\/(.*)\.(?:jsx?|tsx?)$/);
      if (page && !/^_/.test(page[1].split("/").pop()!)) add({ method: page[1].startsWith("api/") ? "ANY" : "GET", path: `/${page[1].replace(/(^|\/)index$/, "")}`, file, line: 1, framework: "Next.js" });
      const appRoute = file.match(/(?:^|\/)(?:src\/)?app\/(.*?)\/?(page|route)\.(?:jsx?|tsx?)$/);
      if (appRoute) add({ method: appRoute[2] === "route" ? "ANY" : "GET", path: `/${appRoute[1].replace(/\([^)]*\)\/?/g, "")}`, file, line: 1, framework: "Next.js" });
    } else if (ext === ".php") {
      for (const m of text.matchAll(/Route::(get|post|put|patch|delete|any)\(\s*(['"])(.*?)\2/g)) add({ method: m[1].toUpperCase(), path: m[3], file, line: lineOf(text, m.index!), framework: "Laravel" });
    } else if (ext === ".rb") {
      for (const m of text.matchAll(/^\s*(get|post|put|patch|delete)\s+(['"])(\/.*?)\2/gm)) add({ method: m[1].toUpperCase(), path: m[3], file, line: lineOf(text, m.index!), framework: "Ruby" });
    } else if (ext === ".go") {
      for (const m of text.matchAll(/\.(?:HandleFunc|Handle|GET|POST|PUT|DELETE)\(\s*"(\/[^"]*)"/g)) add({ method: /\.(GET|POST|PUT|DELETE)\(/.exec(m[0])?.[1] ?? "ANY", path: m[1], file, line: lineOf(text, m.index!), framework: "Go" });
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

/** Outside services, by the package that talks to them, the setting that names them, or the host that is called. */
const SERVICES: { id: string; name: string; kind: IntegrationKind; pkg?: RegExp; env?: RegExp; host?: RegExp; code?: RegExp }[] = [
  { id: "stripe", name: "Stripe", kind: "payments", pkg: /^stripe$|^@stripe\//, env: /^STRIPE_/, host: /stripe\.com/ },
  { id: "paypal", name: "PayPal", kind: "payments", pkg: /paypal/, env: /^PAYPAL_/, host: /paypal\.com/ },
  { id: "sendgrid", name: "SendGrid", kind: "email", pkg: /sendgrid/, env: /^SENDGRID_/, host: /sendgrid\.(com|net)/ },
  { id: "mailgun", name: "Mailgun", kind: "email", pkg: /mailgun/, env: /^MAILGUN_/, host: /mailgun\.(net|org)/ },
  { id: "smtp", name: "Email over SMTP", kind: "email", pkg: /^(flask-mail|nodemailer|yagmail)$/i, env: /^(SMTP|MAIL)_/, code: /\bsmtplib\b/ },
  { id: "resend", name: "Resend", kind: "email", pkg: /^resend$/, env: /^RESEND_/ },
  { id: "postgres", name: "PostgreSQL", kind: "database", pkg: /^(pg|psycopg2?(-binary)?|asyncpg|postgres)$/, env: /^(PG|POSTGRES)/, code: /postgres(ql)?:\/\// },
  { id: "mysql", name: "MySQL", kind: "database", pkg: /^(mysql2?|pymysql|mysqlclient|mysql-connector-python)$/i, env: /^MYSQL_/, code: /mysql:\/\// },
  { id: "sqlite", name: "SQLite (a file on disk)", kind: "database", pkg: /^(sqlite3|better-sqlite3)$/, code: /\bsqlite3\b|sqlite:\/\/|node:sqlite/ },
  { id: "mongodb", name: "MongoDB", kind: "database", pkg: /^(mongodb|mongoose|pymongo|motor)$/, env: /^MONGO/, code: /mongodb(\+srv)?:\/\// },
  { id: "redis", name: "Redis", kind: "database", pkg: /^(redis|ioredis)$/, env: /^REDIS_/, code: /redis:\/\// },
  { id: "sqlalchemy", name: "SQLAlchemy (a SQL database)", kind: "database", pkg: /sqlalchemy/i, env: /^(DATABASE_URL|SQLALCHEMY_)/ },
  { id: "prisma", name: "Prisma (a SQL database)", kind: "database", pkg: /^(prisma|@prisma\/client)$/ },
  { id: "supabase", name: "Supabase", kind: "database", pkg: /supabase/, env: /^SUPABASE_/, host: /supabase\.(co|com)/ },
  { id: "firebase", name: "Firebase", kind: "database", pkg: /^firebase(-admin)?$/, env: /^FIREBASE_/, host: /firebase(io|app)\.com|firebaseapp/ },
  { id: "google-apis", name: "Google APIs", kind: "api", pkg: /^(googleapis|google-api-python-client|gspread|google-auth.*|@google-cloud\/.*|google-cloud-.*)$/, env: /^GOOGLE_/, host: /googleapis\.com/ },
  { id: "oauth", name: "Sign-in with another account (OAuth)", kind: "auth", pkg: /^(passport.*|authlib|flask-dance|next-auth|@auth\/.*|oauthlib|requests-oauthlib)$/i, env: /^(OAUTH|AUTH0)_/ },
  { id: "auth0", name: "Auth0", kind: "auth", pkg: /auth0/, host: /auth0\.com/ },
  { id: "login", name: "Its own sign-in (sessions or tokens)", kind: "auth", pkg: /^(flask-login|flask-jwt-extended|jsonwebtoken|pyjwt|bcrypt(js)?|express-session|django-allauth)$/i },
  { id: "openai", name: "OpenAI", kind: "ai", pkg: /^openai$/, env: /^OPENAI_/, host: /api\.openai\.com/ },
  { id: "anthropic", name: "Anthropic (Claude)", kind: "ai", pkg: /^(anthropic|@anthropic-ai\/.*)$/, env: /^ANTHROPIC_/, host: /api\.anthropic\.com/ },
  { id: "gemini", name: "Google Gemini", kind: "ai", pkg: /^(google-generativeai|@google\/generative-ai|google-genai)$/, env: /^GEMINI_/ },
  { id: "s3", name: "Amazon S3 / AWS", kind: "storage", pkg: /^(boto3|aws-sdk|@aws-sdk\/.*)$/, env: /^AWS_/, host: /amazonaws\.com/ },
  { id: "cloudinary", name: "Cloudinary", kind: "storage", pkg: /cloudinary/, env: /^CLOUDINARY_/, host: /cloudinary\.com/ },
  { id: "twilio", name: "Twilio", kind: "messaging", pkg: /^twilio$/, env: /^TWILIO_/, host: /twilio\.com/ },
  { id: "telegram", name: "Telegram", kind: "messaging", pkg: /telegram|telebot|telegraf/i, env: /^TELEGRAM_/, host: /api\.telegram\.org/ },
  { id: "whatsapp", name: "WhatsApp", kind: "messaging", pkg: /whatsapp/i, env: /^WHATSAPP_/, host: /wa\.me|api\.whatsapp\.com|graph\.facebook\.com/ },
  { id: "slack", name: "Slack", kind: "messaging", pkg: /^(@slack\/.*|slack-sdk|slack_sdk|slackclient)$/, env: /^SLACK_/, host: /slack\.com\/api|hooks\.slack\.com/ },
  { id: "discord", name: "Discord", kind: "messaging", pkg: /^discord(\.js|\.py)?$/, env: /^DISCORD_/, host: /discord(app)?\.com\/api/ },
  { id: "sentry", name: "Sentry", kind: "analytics", pkg: /sentry/, env: /^SENTRY_/, host: /sentry\.io/ },
  { id: "google-analytics", name: "Google Analytics / Tag Manager", kind: "analytics", host: /googletagmanager\.com|google-analytics\.com/, code: /\bgtag\(/ },
  { id: "meta-pixel", name: "Meta Pixel", kind: "analytics", host: /connect\.facebook\.net/, code: /\bfbq\(/ },
  { id: "recaptcha", name: "reCAPTCHA", kind: "auth", env: /RECAPTCHA/, host: /google\.com\/recaptcha/ },
  { id: "github-api", name: "GitHub API", kind: "api", pkg: /^(@octokit\/.*|octokit|pygithub)$/i, env: /^(GITHUB|GH)_TOKEN$/, host: /api\.github\.com/ },
  { id: "vercel", name: "Vercel", kind: "hosting", env: /^VERCEL_/ },
  { id: "heroku", name: "Heroku", kind: "hosting", code: /\bProcfile\b/ },
  { id: "docker", name: "Docker", kind: "hosting" },
];

/** Package names from the manifests a folder has (Node and Python). */
export function packagesOf(dir: string): { name: string; version: string; manifest: string }[] {
  const out: { name: string; version: string; manifest: string }[] = [];
  const read = (p: string) => { try { return readFileSync(join(dir, p), "utf8"); } catch { return ""; } };
  try {
    const pkg = JSON.parse(read("package.json") || "{}");
    for (const [name, v] of Object.entries({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) })) out.push({ name, version: String(v), manifest: "package.json" });
  } catch { /* does not parse */ }
  for (const f of ["requirements.txt", "requirements-dev.txt", "requirements_dev.txt", "dev-requirements.txt"]) {
    for (const raw of read(f).split(/\r?\n/)) {
      const l = raw.replace(/#.*$/, "").trim();
      if (!l || l.startsWith("-")) continue;
      const m = l.match(/^([A-Za-z0-9_.-]+)(?:\[[^\]]*\])?\s*(.*)$/);
      if (m) out.push({ name: m[1], version: m[2].trim(), manifest: f });
    }
  }
  const py = read("pyproject.toml");
  for (const m of py.matchAll(/^\s*["']([A-Za-z0-9_.-]+)\s*([<>=!~][^"']*)?["']\s*,?\s*$/gm)) out.push({ name: m[1], version: (m[2] ?? "").trim(), manifest: "pyproject.toml" });
  return out;
}

/** Settings the code reads from the environment: os.environ, os.getenv, process.env, import.meta.env, env(). */
export function extractEnvVars(files: Map<string, string>): string[] {
  const out = new Set<string>();
  for (const [file, text] of files) {
    if (isTest(file)) continue;
    for (const m of text.matchAll(/os\.environ(?:\.get)?\s*[[(]\s*['"]([A-Z][A-Z0-9_]{2,})['"]|os\.getenv\(\s*['"]([A-Z][A-Z0-9_]{2,})['"]|process\.env\.([A-Z][A-Z0-9_]{2,})|process\.env\[\s*['"]([A-Z][A-Z0-9_]{2,})['"]|import\.meta\.env\.([A-Z][A-Z0-9_]{2,})|\benv\(\s*['"]([A-Z][A-Z0-9_]{2,})['"]|config\(\s*['"]([A-Z][A-Z0-9_]{2,})['"]/g)) {
      const name = m.slice(1).find(Boolean);
      if (name && !/^(NODE_ENV|PATH|HOME|PORT|HOST|DEBUG|CI|PWD|TZ)$/.test(name)) out.add(name);
    }
  }
  return [...out].sort().slice(0, 80);
}

/** Hosts the code names in an address it calls or loads from. */
export function extractHosts(files: Map<string, string>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [file, text] of files) {
    if (isTest(file)) continue;
    for (const m of text.matchAll(/https?:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)(\/[^\s'"`<>)]*)?/gi)) {
      const host = m[1].toLowerCase();
      if (/^(localhost|127\.|0\.0\.0\.0|example\.|www\.w3\.org|schema\.org|json-schema\.org)/.test(host) || /\.(test|local|invalid)$/.test(host)) continue;
      const list = out.get(host) ?? [];
      if (list.length < 3 && !list.includes(file)) list.push(file);
      out.set(host, list);
    }
  }
  return out;
}

export function extractIntegrations(dir: string, files: Map<string, string>, envVars = extractEnvVars(files), hosts = extractHosts(files)): RepoIntegration[] {
  const pkgs = packagesOf(dir);
  const out: RepoIntegration[] = [];
  const has = (f: string) => existsSync(join(dir, f));
  for (const s of SERVICES) {
    const ev: string[] = [];
    for (const p of pkgs) if (s.pkg?.test(p.name)) ev.push(`package ${p.name} (${p.manifest})`);
    for (const v of envVars) if (s.env?.test(v)) ev.push(`setting ${v}`);
    for (const [h, where] of hosts) if (s.host?.test(h)) ev.push(`calls ${h} (${where[0]})`);
    if (s.code) for (const [file, text] of files) { if (!isTest(file) && s.code.test(text)) { ev.push(`used in ${file}`); break; } }
    if (s.id === "docker" && (has("Dockerfile") || has("docker-compose.yml") || has("compose.yaml") || has("docker-compose.yaml"))) ev.push("has a Dockerfile or compose file");
    if (s.id === "heroku" && has("Procfile")) ev.push("has a Procfile");
    if (s.id === "vercel" && has("vercel.json")) ev.push("has vercel.json");
    if (ev.length) out.push({ id: s.id, name: s.name, kind: s.kind, evidence: [...new Set(ev)].slice(0, 5) });
  }
  return out;
}

/**
 * A file that holds scan rules themselves (this one) names every risky call in its patterns, so it would be circled
 * for each of them (SF-58: "a shell command is built from text" at this very list). A file carrying the marker
 * `sf-scan: rules` is skipped by these patterns; its secrets are still looked for.
 */
const RULES_MARKER = "sf-scan: rules";

// sf-scan: rules
const RISKS: { id: string; level: RiskLevel; text: string; re: RegExp; ext?: RegExp }[] = [
  { id: "debug-on", level: "high", text: "The app starts in debug mode, which lets anyone who reaches an error page run code on the server", re: /\.run\([^)]*debug\s*=\s*True|^\s*DEBUG\s*=\s*True\b/m, ext: /\.py$/ },
  { id: "hardcoded-secret", level: "high", text: "A secret key is written in the code instead of read from a setting", re: /\b\w*(?:secret_?key|jwt_?secret|api_?key|password|passwd)\b\s*[:=]\s*['"](?=[^'"\n]*[^\s'"])[^'"\n{}$<>]{6,}['"]|\.login\(\s*['"][^'"\n]+['"]\s*,\s*['"][^'"\n]{6,}['"]/i },
  { id: "eval", level: "high", text: "Code is built from text and run (eval or exec): unsafe when any of that text comes from a visitor", re: /(^|[^.\w])(eval|exec)\(\s*[^)'"]/m, ext: /\.(py|js|ts|jsx|tsx|mjs|cjs|php)$/ },
  { id: "shell", level: "high", text: "A shell command is built from text (shell=True or os.system): unsafe when any of it comes from a visitor", re: /shell\s*=\s*True|os\.system\(|child_process['"]\)?\.exec\(/ },
  { id: "sql-format", level: "high", text: "A database query is put together from text, which allows SQL injection", re: /(execute|query)\(\s*(f['"]|['"][^'"]*['"]\s*(%|\+)|`[^`]*\$\{)[^)]*\b(SELECT|INSERT|UPDATE|DELETE)\b|\b(SELECT\b[^'"`\n]*\bFROM|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b[^'"`\n]*['"`]\s*(\+|%)\s*\w/i },
  { id: "pickle", level: "medium", text: "Data is loaded with pickle, which runs code hidden in the data", re: /pickle\.loads?\(/, ext: /\.py$/ },
  { id: "tls-off", level: "medium", text: "A web call skips the certificate check (verify=False)", re: /verify\s*=\s*False|rejectUnauthorized\s*:\s*false/ },
  { id: "cors-any", level: "medium", text: "Any website may call this app's API (CORS is open to *)", re: /Access-Control-Allow-Origin['"]?\s*[,:]\s*['"]\*['"]|CORS\(\s*app\s*\)|origins?\s*[=:]\s*['"]\*['"]/ },
  { id: "raw-html", level: "medium", text: "Text is put on the page as raw HTML, which allows script injection when it comes from a visitor", re: /\|\s*safe\b|dangerouslySetInnerHTML|\.innerHTML\s*=\s*[^'"`\s]|Markup\(/ },
  { id: "weak-hash", level: "medium", text: "A weak hash (MD5 or SHA-1) is used, which is not safe for passwords", re: /hashlib\.(md5|sha1)\(|createHash\(\s*['"](md5|sha1)['"]\)/ },
  { id: "no-csrf", level: "low", text: "Forms are accepted without a CSRF check", re: /WTF_CSRF_ENABLED\s*=\s*False|csrf_exempt/ },
  { id: "bare-except", level: "low", text: "Errors are swallowed without a trace (a bare except that passes)", re: /except\s*:\s*\n\s*pass\b|catch\s*\(\s*\w*\s*\)\s*\{\s*\}/ },
];

/** Lines a security reviewer would circle, plus anything that looks like a committed key. */
export function riskScan(files: Map<string, string>): RiskFinding[] {
  const out: RiskFinding[] = [];
  const count = new Map<string, number>();
  const push = (r: RiskFinding) => { const n = count.get(r.id) ?? 0; count.set(r.id, n + 1); if (n < 4) out.push(r); };
  for (const [file, text] of files) {
    if (isTest(file)) continue;
    for (const r of text.includes(RULES_MARKER) ? [] : RISKS) {
      if (r.ext && !r.ext.test(file)) continue;
      const m = r.re.exec(text);
      if (m) push({ id: r.id, level: r.level, text: r.text, file, line: lineOf(text, m.index + (m[0].startsWith("\n") ? 1 : 0)) });
    }
    for (const h of findSecrets(text, file).slice(0, 3)) push({ id: "committed-secret", level: "critical", text: `Looks like a ${h.kind} committed in the code`, file, line: h.line });
  }
  const rank = { critical: 0, high: 1, medium: 2, low: 3 };
  return out.sort((a, b) => rank[a.level] - rank[b.level] || a.file.localeCompare(b.file)).slice(0, 40);
}

function sh(file: string, args: string[], o: { cwd: string; shell?: boolean; timeoutMs: number }): Promise<{ status: number | null; out: string }> {
  return new Promise((resolve) => {
    let out = "";
    let child: ReturnType<typeof spawn>;
    try { child = spawn(file, args, { cwd: o.cwd, shell: !!o.shell, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: projectEnv(o.cwd, process.execPath, null) }); }
    catch (e) { return resolve({ status: 1, out: (e as Error).message }); }
    const timer = setTimeout(() => { killTree(child, true); }, o.timeoutMs);
    child.stdout!.on("data", (x) => { if (out.length < 4_000_000) out += x; });
    child.stderr!.on("data", (x) => { if (out.length < 4_000_000) out += x; });
    child.on("error", (e) => { clearTimeout(timer); resolve({ status: 1, out: `${out}\n${e.message}` }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ status: code, out }); });
  });
}

/** What `npm audit --json` says, as a list. Null when the text is not its report. */
export function parseNpmAudit(text: string): DependencyReport["vulnerable"] | null {
  try {
    const j = JSON.parse(text.slice(text.indexOf("{")));
    if (!j || typeof j !== "object" || (!j.vulnerabilities && !j.advisories)) return null;
    const v = Object.values((j.vulnerabilities ?? {}) as Record<string, any>);
    return v.map((x) => ({
      name: String(x.name), severity: String(x.severity ?? "unknown"),
      detail: (Array.isArray(x.via) ? x.via.map((y: any) => (typeof y === "string" ? `through ${y}` : String(y.title ?? ""))).filter(Boolean).slice(0, 2).join("; ") : "") || (x.fixAvailable ? "a fix is available" : ""),
    })).slice(0, 40);
  } catch { return null; }
}

/** What `pip-audit -f json` says, as a list. Null when the text is not its report. */
export function parsePipAudit(text: string): DependencyReport["vulnerable"] | null {
  try {
    const start = text.search(/[[{]/);
    const j = JSON.parse(text.slice(start));
    const deps = (Array.isArray(j) ? j : j.dependencies) as any[] | undefined;
    if (!Array.isArray(deps)) return null;
    return deps.filter((d) => Array.isArray(d.vulns) && d.vulns.length).map((d) => ({
      name: `${d.name} ${d.version ?? ""}`.trim(), severity: "known vulnerability",
      detail: [...new Set(d.vulns.map((x: any) => `${x.id}${x.fix_versions?.length ? `, fixed in ${x.fix_versions[0]}` : ""}`) as string[])].slice(0, 3).join("; "),
    })).slice(0, 40);
  } catch { return null; }
}

/** Look the repo's packages up for known vulnerabilities, with each stack's own tool. Needs the network; says so when it has none. */
export async function dependencyScan(dir: string, env: Pick<RepoEnv, "pathFirst">, o: { install?: boolean } = {}): Promise<Evidence["dependencies"]> {
  const pkgs = packagesOf(dir);
  const reports: DependencyReport[] = [];
  const unpinned = pkgs.filter((p) => p.manifest.startsWith("requirements") && !/==/.test(p.version)).map((p) => p.name).slice(0, 30);
  if (existsSync(join(dir, "package.json")) && pkgs.some((p) => p.manifest === "package.json")) {
    if (!existsSync(join(dir, "package-lock.json"))) reports.push({ tool: "npm audit", ran: false, note: "there is no package-lock.json, so the exact versions are not known", vulnerable: [] });
    else {
      const r = await sh("npm", ["audit", "--json"], { cwd: dir, shell: true, timeoutMs: 120_000 });
      const v = parseNpmAudit(r.out);
      reports.push(v ? { tool: "npm audit", ran: true, note: v.length ? `${v.length} package${v.length === 1 ? "" : "s"} with a known vulnerability` : "no known vulnerabilities", vulnerable: v }
        : { tool: "npm audit", ran: false, note: `it gave no report (no network, or the registry refused): ${r.out.trim().slice(0, 160)}`, vulnerable: [] });
    }
  }
  const reqs = ["requirements.txt"].filter((f) => existsSync(join(dir, f)));
  if (reqs.length) {
    const py = env.pathFirst.flatMap((d) => ["python.exe", "python"].map((n) => join(d, n))).find((p) => existsSync(p));
    if (!py) reports.push({ tool: "pip-audit", ran: false, note: "its Python packages are not installed here, so they could not be checked", vulnerable: [] });
    else {
      let has = (await sh(py, ["-m", "pip_audit", "--version"], { cwd: dir, timeoutMs: 30_000 })).status === 0;
      // Into SoftwareFactory's own environment under .sf/, never into the repo's files.
      if (!has && o.install !== false) has = (await sh(py, ["-m", "pip", "install", "-q", "--disable-pip-version-check", "pip-audit"], { cwd: dir, timeoutMs: 240_000 })).status === 0;
      if (!has) reports.push({ tool: "pip-audit", ran: false, note: "pip-audit could not be installed (no network?)", vulnerable: [] });
      else {
        const r = await sh(py, ["-m", "pip_audit", "-r", reqs[0], "-f", "json", "--progress-spinner", "off"], { cwd: dir, timeoutMs: 240_000 });
        const v = parsePipAudit(r.out);
        reports.push(v ? { tool: "pip-audit", ran: true, note: v.length ? `${v.length} package${v.length === 1 ? "" : "s"} with a known vulnerability` : "no known vulnerabilities", vulnerable: v }
          : { tool: "pip-audit", ran: false, note: `it gave no report: ${r.out.trim().slice(-200)}`, vulnerable: [] });
      }
    }
  }
  return { reports, unpinned, total: pkgs.length };
}

/** What gathering evidence does through the computer; tests replace any of them. */
export interface EvidenceTools {
  prepareEnv: (dir: string) => Promise<RepoEnv> | RepoEnv;
  runTests: typeof runRepoTests;
  withSite: typeof withSite;
  readPages: typeof readPages;
  dependencyScan: typeof dependencyScan;
}

export const realEvidenceTools: EvidenceTools = { prepareEnv: (dir) => prepareEnv(dir), runTests: runRepoTests, withSite, readPages, dependencyScan };

/**
 * Everything the code and the running app prove. `step` is told what is happening, for the review's strip.
 * `run: false` reads only (no install, no tests, no site): what a review does when it may not touch the folder.
 */
export async function gatherEvidence(dir: string, o: { head?: string | null; run?: boolean; tools?: Partial<EvidenceTools>; step?: (station: "read" | "install" | "tests" | "site" | "deps", state: "active" | "pass" | "fail" | "skipped", note?: string) => void } = {}): Promise<Evidence> {
  const t0 = Date.now();
  const tools = { ...realEvidenceTools, ...(o.tools ?? {}) };
  const step = o.step ?? (() => {});
  const run = o.run !== false;

  step("read", "active");
  const files = readCode(dir);
  const envVars = extractEnvVars(files);
  const hostMap = extractHosts(files);
  const endpoints = extractEndpoints(files);
  const integrations = extractIntegrations(dir, files, envVars, hostMap);
  const risks = riskScan(files);
  step("read", "pass", `${files.size} code files read: ${endpoints.length} route${endpoints.length === 1 ? "" : "s"}, ${integrations.length} outside service${integrations.length === 1 ? "" : "s"}, ${risks.length} risky line${risks.length === 1 ? "" : "s"}`);

  const ev: Evidence = {
    head: o.head ?? null, stack: [], install: { ok: false, notes: [] },
    tests: { ran: false, passed: 0, failed: 0, failing: [], note: "not run" },
    site: { started: false, note: "not started", command: null, pages: [] },
    endpoints, integrations, envVars, hosts: [...hostMap.keys()].sort().slice(0, 40), risks,
    dependencies: { reports: [], unpinned: [], total: packagesOf(dir).length }, ms: 0,
  };
  if (!run) {
    const why = "this review only read the code";
    ev.install.notes.push(why); ev.tests.note = why; ev.site.note = why;
    for (const s of ["install", "tests", "site", "deps"] as const) step(s, "skipped", why);
    ev.ms = Date.now() - t0;
    return ev;
  }

  step("install", "active", "installing what the app needs");
  let env: RepoEnv = { stack: [], tests: [], pathFirst: [], commands: [], notes: [], testHint: "" };
  try { env = await tools.prepareEnv(dir); ev.install = { ok: !env.notes.length, notes: env.notes }; }
  catch (e) { ev.install = { ok: false, notes: [`could not be set up: ${(e as Error).message.slice(0, 300)}`] }; }
  ev.stack = env.stack;
  step("install", ev.install.ok ? "pass" : "fail", ev.install.ok ? `ready (${env.stack.join(", ") || "no known stack"})` : ev.install.notes.join("; ").slice(0, 300));

  step("tests", "active", "running the repo's own tests");
  if (!env.tests.length) { ev.tests.note = "the repo has no tests SoftwareFactory knows how to run"; step("tests", "skipped", ev.tests.note); }
  else {
    try {
      const r = await tools.runTests(dir, env, 300_000);
      ev.tests = { ran: true, passed: r.passed, failed: r.failed, failing: r.cases.filter((c) => !c.pass).map((c) => `${c.file ? `${c.file}: ` : ""}${c.name}`).slice(0, 12), note: r.timedOut ? "the tests did not finish in time" : `${r.passed} passed, ${r.failed} failed (${env.testHint})` };
      step("tests", r.failed ? "fail" : "pass", ev.tests.note);
    } catch (e) { ev.tests.note = `the tests could not be run: ${(e as Error).message.slice(0, 200)}`; step("tests", "fail", ev.tests.note); }
  }

  step("site", "active", "starting the app and opening its pages");
  ev.site.command = siteProfile(dir)?.command ?? null;
  try {
    // Pages the code names but the home page may not link to are opened too.
    const extra = endpoints.filter((e) => (e.method === "GET" || e.method === "ANY") && !/[<:{[*]/.test(e.path) && e.path !== "/" && !/^\/(api|static|assets)\b/.test(e.path)).map((e) => e.path).slice(0, 10);
    const r = await tools.withSite(dir, { pathFirst: env.pathFirst }, async (url) => {
      const pages = await tools.readPages(url, { extra, max: 12 });
      // Every plain GET route is asked once: a route that answers 500 is a broken step of the flow.
      for (const e of endpoints.filter((x) => (x.method === "GET" || x.method === "ANY") && !/[<:{[*]/.test(x.path)).slice(0, 40)) {
        try { const res = await fetch(`${url}${e.path}`, { redirect: "manual", signal: AbortSignal.timeout(8000) }); e.status = res.status; } catch { e.status = null; }
      }
      return pages;
    });
    if (Array.isArray(r)) {
      ev.site.started = true;
      ev.site.pages = r.map((p) => ({ route: `/${p.route}`, text: p.text.slice(0, 1200), controls: p.controls.slice(0, 20) }));
      const broken = endpoints.filter((e) => (e.status ?? 0) >= 500).length;
      ev.site.note = `${r.length} page${r.length === 1 ? "" : "s"} opened${broken ? `, ${broken} route${broken === 1 ? "" : "s"} answered with a server error` : ""}`;
      step("site", r.length && !broken ? "pass" : "fail", ev.site.note);
    } else { ev.site.note = r.skipped; step("site", "skipped", r.skipped.slice(0, 300)); }
  } catch (e) { ev.site.note = `the site could not be looked at: ${(e as Error).message.slice(0, 200)}`; step("site", "fail", ev.site.note); }

  step("deps", "active", "looking its packages up for known vulnerabilities");
  try { ev.dependencies = await tools.dependencyScan(dir, env); }
  catch (e) { ev.dependencies.reports.push({ tool: "dependency check", ran: false, note: (e as Error).message.slice(0, 200), vulnerable: [] }); }
  const vuln = ev.dependencies.reports.reduce((s, r) => s + r.vulnerable.length, 0);
  const ranAny = ev.dependencies.reports.some((r) => r.ran);
  step("deps", !ev.dependencies.reports.length ? "skipped" : !ranAny ? "skipped" : vuln ? "fail" : "pass", !ev.dependencies.reports.length ? "no package list to check" : ev.dependencies.reports.map((r) => `${r.tool}: ${r.note}`).join("; ").slice(0, 300));

  ev.ms = Date.now() - t0;
  return ev;
}

/** The evidence in plain text, for the agents. */
export function evidenceText(ev: Evidence, maxChars = 9000): string {
  const L: string[] = [];
  L.push(`Stack: ${ev.stack.join(", ") || "unknown"}. ${ev.dependencies.total} packages declared.`);
  L.push(`Install: ${ev.install.ok ? "worked" : `problems: ${ev.install.notes.join("; ")}`}.`);
  L.push(`Its own tests: ${ev.tests.note}.${ev.tests.failing.length ? ` Failing: ${ev.tests.failing.slice(0, 6).join(" | ")}.` : ""}`);
  L.push(`Running it${ev.site.command ? ` (${ev.site.command})` : ""}: ${ev.site.started ? ev.site.note : `NOT seen running: ${ev.site.note}`}.`);
  for (const p of ev.site.pages.slice(0, 8)) L.push(`  Page ${p.route}: "${p.text.slice(0, 380).replace(/\s+/g, " ")}"${p.controls.length ? ` Controls: ${p.controls.slice(0, 12).join(" | ")}` : ""}`);
  if (ev.endpoints.length) {
    L.push(`Routes in the code (${ev.endpoints.length}):`);
    for (const e of ev.endpoints.slice(0, 60)) L.push(`  ${e.method} ${e.path}  [${e.file}:${e.line}]${e.status != null ? ` answered ${e.status}` : ""}`);
  } else L.push("Routes in the code: none found by the static reader.");
  if (ev.integrations.length) L.push(`Outside services: ${ev.integrations.map((i) => `${i.name} [${i.kind}: ${i.evidence.slice(0, 2).join(", ")}]`).join("; ")}.`);
  if (ev.envVars.length) L.push(`Settings read from the environment: ${ev.envVars.slice(0, 40).join(", ")}.`);
  if (ev.hosts.length) L.push(`Hosts named in the code: ${ev.hosts.slice(0, 25).join(", ")}.`);
  if (ev.risks.length) { L.push("Risky lines:"); for (const r of ev.risks.slice(0, 20)) L.push(`  [${r.level}] ${r.text} (${r.file}:${r.line})`); }
  for (const r of ev.dependencies.reports) L.push(`${r.tool}: ${r.note}.${r.vulnerable.length ? ` ${r.vulnerable.slice(0, 8).map((v) => `${v.name} (${v.severity}${v.detail ? `: ${v.detail}` : ""})`).join("; ")}` : ""}`);
  if (ev.dependencies.unpinned.length) L.push(`Python packages without an exact version: ${ev.dependencies.unpinned.slice(0, 15).join(", ")}.`);
  const out = L.join("\n");
  return out.length > maxChars ? `${out.slice(0, maxChars)}\n[...]` : out;
}

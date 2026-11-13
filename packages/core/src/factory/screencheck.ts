import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killTree } from "../launch/launcher.js";

/**
 * Every screen, opened in a real browser (the done-claim check, H8). The app check proves the server
 * starts and the schema works, but nothing ever ran the page's own code: a view that throws, an
 * app.js cut off halfway or a module that does not load all passed it (run 2099 shipped a cut-off
 * web/app.js). This starts the app the way Start does, opens its home in the browser already on the
 * computer (Edge on Windows, else Chrome or Chromium), follows every link in its navigation plus each
 * entity's "new" form, and fails a screen that shows the kit's error box, draws nothing, or logs an
 * uncaught error. Free: no AI call. With no browser on the computer it is skipped, never passed.
 */

export interface ScreenResult { route: string; ok: boolean; problem?: string }
export interface ScreenCheck { pass: boolean; skipped?: string; browser?: string; screens: ScreenResult[] }

/** A headless-capable browser on this computer, or null. SF_BROWSER wins. */
export function findBrowser(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string | null {
  const c: string[] = [];
  if (env.SF_BROWSER) c.push(env.SF_BROWSER);
  if (platform === "win32") {
    // The usual folders too: a scrubbed environment may not name them.
    for (const base of [...new Set([env["ProgramFiles(x86)"], env.ProgramFiles, env.LOCALAPPDATA, "C:\\Program Files (x86)", "C:\\Program Files"].filter(Boolean) as string[])]) {
      c.push(join(base, "Microsoft", "Edge", "Application", "msedge.exe"), join(base, "Google", "Chrome", "Application", "chrome.exe"));
    }
  } else if (platform === "darwin") {
    c.push("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", "/Applications/Chromium.app/Contents/MacOS/Chromium");
  } else {
    // Playwright's headless shell first: full Chrome can hang on --dump-dom in a container.
    try {
      for (const d of readdirSync("/opt/pw-browsers").filter((n) => n.startsWith("chromium_headless_shell")).sort().reverse()) {
        for (const sub of readdirSync(join("/opt/pw-browsers", d))) c.push(join("/opt/pw-browsers", d, sub, "chrome-headless-shell"));
      }
    } catch { /* not there */ }
    c.push("/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome", "/usr/bin/microsoft-edge");
  }
  return c.find((p) => { try { return existsSync(p); } catch { return false; } }) ?? null;
}

/**
 * The environment a browser is started with. Windows' app-health shim gives the SF app
 * __COMPAT_LAYER=DetectorsAppHealth, every child inherits it, and with it Edge's --dump-dom exits at once
 * with no output (found on Assaf's PC, 2026-11-13: the screen check was always skipped inside the app).
 */
export function browserEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const k of Object.keys(out)) if (k.toUpperCase() === "__COMPAT_LAYER") delete out[k];
  return out;
}

/** One screen: the DOM after its scripts ran, and the console's uncaught errors. */
export function dumpScreen(browser: string, url: string, timeoutMs = 20_000): Promise<{ dom: string; errors: string[]; timedOut: boolean }> {
  return new Promise((resolve) => {
    const profile = mkdtempSync(join(tmpdir(), "sf-screen-"));
    const headless = /headless[-_]shell/.test(browser) ? [] : ["--headless=new"];
    const child = spawn(browser, [...headless, "--disable-gpu", "--no-sandbox", "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--no-proxy-server",
      `--user-data-dir=${profile}`, "--enable-logging=stderr", "--v=0", "--virtual-time-budget=4000", "--dump-dom", url], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env: browserEnv() });
    let dom = "";
    let err = "";
    let timedOut = false;
    child.stdout.on("data", (d) => (dom += d));
    child.stderr.on("data", (d) => (err += d));
    const t = setTimeout(() => { timedOut = true; killTree(child, true); }, timeoutMs);
    const done = () => {
      clearTimeout(t);
      try { rmSync(profile, { recursive: true, force: true }); } catch { /* the OS cleans tmp */ }
      const errors = err.split("\n").filter((l) => /CONSOLE/.test(l) && /Uncaught|Error:/.test(l)).map((l) => (l.match(/"(.*)", source: (.*)$/) ? `${l.match(/"(.*)", source/)![1]} (${l.match(/source: (.*)$/)![1]})` : l)).slice(0, 5);
      resolve({ dom, errors, timedOut });
    };
    child.on("close", done);
    child.on("error", () => { clearTimeout(t); resolve({ dom: "", errors: [], timedOut: true }); });
  });
}

/** The routes a kit app's navigation links to (#/home, #/e/piece, #/v/board, #/system), from its home screen's DOM. */
export function routesOf(dom: string): string[] {
  const nav = dom.match(/<nav[^>]*kit-nav[\s\S]*?<\/nav>/)?.[0] ?? dom;
  return [...new Set([...nav.matchAll(/href="#\/([^"]*)"/g)].map((m) => m[1]).filter(Boolean))];
}

/** What is wrong with one dumped screen, or null. */
export function screenProblem(dom: string, errors: string[]): string | null {
  if (!/class="kit-app"/.test(dom)) return "the app did not start on this screen (web/app.js or a module it imports failed to load, or startApp never ran)";
  const kitError = dom.match(/class="kit-error"[\s\S]*?<h2>([\s\S]*?)<\/h2>[\s\S]*?(?:<pre>([\s\S]*?)<\/pre>)?/);
  if (kitError) return `${strip(kitError[1])}${kitError[2] ? `: ${strip(kitError[2]).slice(0, 400)}` : ""}`;
  const main = dom.match(/<main[^>]*class="kit-main"[^>]*>([\s\S]*?)<\/main>/)?.[1] ?? "x";
  if (!strip(main).trim()) return "the screen is blank";
  if (errors.length) return `uncaught error in the page: ${errors[0]}`;
  return null;
}

const strip = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();

/**
 * Open every screen of a running app at `baseUrl` (the app's server must already be up). At most
 * `max` screens; a browser that does not answer skips the check instead of failing it.
 */
export async function checkScreens(baseUrl: string, o: { browser?: string | null; max?: number; entities?: string[] } = {}): Promise<ScreenCheck> {
  const browser = o.browser === undefined ? findBrowser() : o.browser;
  if (!browser) return { pass: true, skipped: "no browser on this computer (Edge, Chrome or Chromium)", screens: [] };
  const home = await dumpScreen(browser, `${baseUrl}/#/home`);
  // No output at all (timed out, or a browser that exits at once, as Edge does when started from Git Bash):
  // a broken environment must not fail a good app.
  if (!home.dom.trim()) return { pass: true, skipped: home.timedOut ? "the browser did not answer" : "the browser gave no output", browser, screens: [] };
  const screens: ScreenResult[] = [];
  const homeProblem = screenProblem(home.dom, home.errors);
  screens.push({ route: "home", ok: !homeProblem, ...(homeProblem ? { problem: homeProblem } : {}) });
  if (/class="kit-app"/.test(home.dom)) {
    const routes = routesOf(home.dom).filter((r) => r !== "home");
    // Each entity's "new" form too: the form is a screen of its own.
    const forms = routes.filter((r) => /^e\/[^/]+$/.test(r)).map((r) => `${r}/new`);
    for (const route of [...routes, ...forms].slice(0, (o.max ?? 14) - 1)) {
      const s = await dumpScreen(browser, `${baseUrl}/#/${route}`);
      if (!s.dom.trim()) { screens.push({ route, ok: true, problem: "skipped: the browser did not answer" }); continue; }
      const p = screenProblem(s.dom, s.errors);
      screens.push({ route, ok: !p, ...(p ? { problem: p } : {}) });
    }
  }
  return { pass: screens.every((s) => s.ok), browser, screens };
}

/** The check as one cell in the test grid, fixed like a failing test. */
export function screenCase(c: ScreenCheck) {
  const bad = c.screens.filter((s) => !s.ok);
  return {
    name: `every screen draws in a real browser (${c.screens.length - bad.length} of ${c.screens.length})`,
    file: "web/app.js",
    pass: c.pass,
    error: c.pass ? undefined : bad.map((s) => `#/${s.route}: ${s.problem}`).join("\n").slice(0, 2000),
    durationMs: 0,
  };
}

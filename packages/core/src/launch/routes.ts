import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { EventLog } from "../events.js";
import { linkToProject, registerProjectFacet, unlinkFromProject } from "../projects/service.js";
import { detectProfiles } from "./detect.js";
import { openConsoleWindow, type Launcher, type OutputLine } from "./launcher.js";
import { serveStatic } from "./static.js";
import { readUsage } from "./usage.js";

/** A folder a project can run from, and where it came from. */
export interface ProjectFolder { dir: string; source: "folder" | "import" | "run"; label: string; ref?: number; exists: boolean }

const isDir = (p: string) => { try { return statSync(p).isDirectory(); } catch { return false; } };

/**
 * Every folder a project lives in, the one to run first: a folder you chose,
 * then its imported repo, then its newest shipped build, then any other build.
 */
export function projectFolders(log: EventLog, projectId: number): ProjectFolder[] {
  const out: ProjectFolder[] = [];
  const add = (f: Omit<ProjectFolder, "exists">) => { if (f.dir && !out.some((x) => x.dir === f.dir)) out.push({ ...f, exists: isDir(f.dir) }); };
  const links = log.db.prepare("SELECT kind, ref FROM project_links WHERE project_id = ? ORDER BY ts DESC").all(projectId) as { kind: string; ref: string }[];
  for (const l of links) if (l.kind === "folder") add({ dir: l.ref, source: "folder", label: "Your folder" });
  const hasImports = log.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'repo_imports'").get();
  if (hasImports) {
    const imp = log.db.prepare("SELECT dir, source FROM repo_imports WHERE project_id = ?").get(projectId) as { dir: string; source: string } | undefined;
    if (imp) add({ dir: imp.dir, source: "import", label: `Imported from ${imp.source}` });
  }
  const runIds = links.filter((l) => l.kind === "factory_run").map((l) => Number(l.ref));
  if (runIds.length) {
    const rows = log.db.prepare(`SELECT id, dir, outcome, plan_name FROM factory_runs WHERE dir IS NOT NULL AND id IN (${runIds.map(() => "?").join(",")}) ORDER BY id DESC`).all(...runIds) as Record<string, any>[];
    for (const r of rows.filter((x) => x.outcome === "shipped")) add({ dir: r.dir, source: "run", ref: Number(r.id), label: `Run #${r.id}${r.plan_name ? ` · ${r.plan_name}` : ""} (shipped)` });
    for (const r of rows.filter((x) => x.outcome !== "shipped")) add({ dir: r.dir, source: "run", ref: Number(r.id), label: `Run #${r.id}${r.plan_name ? ` · ${r.plan_name}` : ""} (${r.outcome ?? "in progress"})` });
  }
  // Folders that exist come first, in the order above.
  return [...out.filter((f) => f.exists), ...out.filter((f) => !f.exists)];
}

/**
 * The launch API: run a finished project from its own folder and see it.
 *
 *   GET  /api/launch/projects/:id?dir=        its folders, the run profiles found in one, running and recent sessions
 *   POST /api/launch/projects/:id/start       { profileId, args?, dir?, mode? }   mode "window" opens a console window of its own
 *   POST /api/launch/projects/:id/folder      { dir }   run it from a folder of yours (links kind "folder"); { dir, remove: true } forgets it
 *   POST /api/launch/projects/:id/terminal    { dir? }  open a terminal in the folder
 *   GET  /api/launch/sessions/:sid?after=     the session and its output after line n
 *   GET  /api/launch/sessions/:sid/stream     server-sent events: output lines and state changes
 *   POST /api/launch/sessions/:sid/stop
 *   POST /api/launch/sessions/:sid/input      { text } a line of typed input, or { end: true } to close it
 *   POST /api/launch/open                     { url } open a local address in your browser
 *   GET  /api/launch/browse?path=             a folder's folders and files, for the file and folder pickers
 *   GET  /preview/:id/...                     a project's plain pages, while its preview is on
 */
export async function launchRoute(
  ctx: { log: EventLog; launcher: Launcher; readJson: (req: IncomingMessage) => Promise<Record<string, unknown>>; openUrl: (url: string) => void },
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<[number, unknown] | "handled" | null> {
  const { log, launcher } = ctx;
  const path = url.pathname;

  const pv = path.match(/^\/preview\/(\d+)(\/.*)?$/);
  if (pv && (req.method === "GET" || req.method === "HEAD")) {
    const at = launcher.staticRoot(Number(pv[1]));
    if (!pv[2]) { res.writeHead(302, { location: `/preview/${pv[1]}/` }); res.end(); return "handled"; }
    if (!at) { res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }); res.end("This project's preview is off. Press Start on its Run tab."); return "handled"; }
    serveStatic(res, resolve(at.dir, at.root), pv[2], req.method);
    return "handled";
  }
  if (!path.startsWith("/api/launch/")) return null;

  if (req.method === "GET" && path === "/api/launch/browse") return [200, browse(url.searchParams.get("path"))];
  if (req.method === "POST" && path === "/api/launch/open") {
    const body = await ctx.readJson(req);
    const u = String(body.url ?? "");
    if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(u)) return [400, { error: "Only local addresses open from here." }];
    ctx.openUrl(u);
    return [200, { ok: true }];
  }

  let m = path.match(/^\/api\/launch\/projects\/(\d+)(?:\/(start|folder|terminal))?$/);
  if (m) {
    const id = Number(m[1]);
    if (!log.db.prepare("SELECT 1 FROM projects WHERE id = ?").get(id)) return [404, { error: `No project #${id}` }];
    const folders = projectFolders(log, id);
    const pick = (want: unknown) => {
      const w = typeof want === "string" && want ? want : null;
      const f = w ? folders.find((x) => x.dir === w) : folders[0];
      if (w && !f) throw new Error("That folder does not belong to this project. Add it first.");
      return f ?? null;
    };
    if (req.method === "GET" && !m[2]) {
      const f = pick(url.searchParams.get("dir"));
      const det = f ? detectProfiles(f.dir) : null;
      // Command-line tools carry how to use them, so nobody has to know their arguments.
      const profiles = (det?.profiles ?? []).map((p) => (p.kind === "cli" && f ? { ...p, usage: readUsage(f.dir, p) } : p));
      return [200, { projectId: id, folders, dir: f?.dir ?? null, exists: det?.exists ?? false, stack: det?.stack ?? [], profiles, sessions: launcher.sessionsOf(id), running: launcher.running(id) }];
    }
    if (req.method !== "POST") return null;
    const body = await ctx.readJson(req);
    if (m[2] === "folder") {
      const dir = String(body.dir ?? "").trim().replace(/^"|"$/g, "");
      if (body.remove === true) { unlinkFromProject(log, id, "folder", dir); return [200, { folders: projectFolders(log, id) }]; }
      if (!dir || !isAbsolute(dir)) return [400, { error: "Give the full path of the folder, for example C:\\Dev\\my-app" }];
      if (!isDir(dir)) return [400, { error: `There is no folder at ${dir}` }];
      linkToProject(log, id, "folder", dir);
      return [200, { folders: projectFolders(log, id) }];
    }
    if (m[2] === "terminal") {
      const f = pick(body.dir);
      if (!f?.exists) return [404, { error: "This project has no folder on disk yet." }];
      openConsoleWindow(f.dir, null, "SoftwareFactory");
      return [200, { ok: true, dir: f.dir }];
    }
    if (m[2] === "start") {
      const f = pick(body.dir);
      if (!f?.exists) return [404, { error: "This project has no folder on disk yet. Build it, import a repo, or add a folder on the Run tab." }];
      const det = detectProfiles(f.dir);
      const profile = det.profiles.find((p) => p.id === String(body.profileId ?? "")) ?? (body.profileId ? null : det.profiles.find((p) => p.recommended));
      if (!profile) return [404, { error: body.profileId ? `No way to run "${body.profileId}" in ${f.dir}` : `Nothing to run was found in ${f.dir}` }];
      const s = await launcher.start({
        projectId: id, dir: f.dir, profile, args: body.args ? String(body.args) : undefined,
        argv: Array.isArray(body.argv) ? body.argv.map(String) : undefined,
        stdin: typeof body.stdin === "string" ? body.stdin.slice(0, 1_000_000) : undefined,
        mode: body.mode === "window" ? "window" : "inline",
      });
      return [202, s];
    }
    return null;
  }

  m = path.match(/^\/api\/launch\/sessions\/(\d+)(?:\/(stream|stop|input))?$/);
  if (!m) return null;
  const sid = Number(m[1]);
  if (req.method === "GET" && !m[2]) {
    const v = launcher.view(sid);
    if (!v) return [404, { error: `No session #${sid}` }];
    return [200, { session: v, ...launcher.output(sid, Number(url.searchParams.get("after") ?? 0)) }];
  }
  if (req.method === "GET" && m[2] === "stream") {
    const v = launcher.view(sid);
    if (!v) return [404, { error: `No session #${sid}` }];
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    const after = Number(url.searchParams.get("after") ?? 0);
    const sendState = (s: { id: number }) => { if (s.id === sid) res.write(`event: state\ndata: ${JSON.stringify(s)}\n\n`); };
    const sendLine = (id: number, l: OutputLine) => { if (id === sid) res.write(`event: line\ndata: ${JSON.stringify(l)}\n\n`); };
    sendState(v);
    for (const l of launcher.output(sid, after).lines) sendLine(sid, l);
    launcher.on("state", sendState);
    launcher.on("line", sendLine);
    const ping = setInterval(() => res.write(": ping\n\n"), 20_000);
    req.on("close", () => { clearInterval(ping); launcher.off("state", sendState); launcher.off("line", sendLine); });
    return "handled";
  }
  if (req.method !== "POST") return null;
  const body = await ctx.readJson(req);
  if (m[2] === "stop") { const v = launcher.stop(sid); return v ? [200, v] : [404, { error: `No session #${sid}` }]; }
  if (m[2] === "input") {
    try { launcher.input(sid, body.end === true ? null : String(body.text ?? "")); } catch (e) { return [409, { error: (e as Error).message }]; }
    return [200, { ok: true }];
  }
  return null;
}

// Every project's detail says whether it is running and where its pages are.
registerProjectFacet({
  id: "launch",
  compute(log, project) {
    const hasTable = log.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'launch_sessions'").get();
    if (!hasTable) return null;
    const live = log.db.prepare("SELECT id, kind, label, url FROM launch_sessions WHERE project_id = ? AND ended_at IS NULL ORDER BY id DESC").all(project.id) as Record<string, any>[];
    const last = log.db.prepare("SELECT started_at FROM launch_sessions WHERE project_id = ? ORDER BY id DESC LIMIT 1").get(project.id) as { started_at: string } | undefined;
    const folders = projectFolders(log, project.id);
    return { running: live.length, live: live.map((r) => ({ id: Number(r.id), kind: r.kind, label: r.label, url: r.url })), lastStartedAt: last?.started_at ?? null, folder: folders.find((f) => f.exists)?.dir ?? null };
  },
});

/** One folder for the pickers: its subfolders and files, its parent, and where to start (home, drives). */
export function browse(path: string | null) {
  const home = homedir();
  const roots = process.platform === "win32"
    ? "CDEFGHIJKLMNOPQRSTUVWXYZ".split("").map((d) => `${d}:\\`).filter((d) => { try { return existsSync(d); } catch { return false; } })
    : ["/"];
  const at = path && isAbsolute(path) && isDir(path) ? resolve(path) : home;
  const entries: { name: string; path: string; dir: boolean; size?: number }[] = [];
  let error: string | null = null;
  try {
    for (const name of readdirSync(at)) {
      if (name.startsWith(".") || name === "node_modules" || /^(\$Recycle\.Bin|System Volume Information|pagefile\.sys|hiberfil\.sys|swapfile\.sys|DumpStack\.log\.tmp)$/i.test(name)) continue;
      const p = join(at, name);
      try { const st = statSync(p); entries.push({ name, path: p, dir: st.isDirectory(), size: st.isFile() ? st.size : undefined }); } catch { /* no access */ }
      if (entries.length >= 2000) break;
    }
  } catch (e) { error = (e as Error).message; }
  entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }) : a.dir ? -1 : 1));
  const parent = dirname(at) === at ? null : dirname(at);
  return { path: at, parent, home, roots, entries, error };
}

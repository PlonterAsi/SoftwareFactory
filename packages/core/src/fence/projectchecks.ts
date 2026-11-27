/**
 * The project tells its own checks (build list: own-checks), so nothing has to be filled in.
 *
 * SoftwareFactory reads the file list of the starting point, before any run touched it, and finds what the project
 * can be built and type-checked with, so a run cannot add, drop or reorder checks. The commands still run the
 * project's own scripts as the run left them; a result that changes the script behind a found check is therefore held
 * for the owner's look (see `watch`). A build's own settings files can still loosen a build: that limit is real, and
 * the second pair of eyes on a result is what answers it later. What is found
 * is only the kind of check that needs nothing but the code: build, type check, vet. Tests often need a database or
 * a key; they come in when a project is brought in and SoftwareFactory has proven which of them run in the room.
 * Checks written in Settings win over anything found here.
 */
export interface FoundChecks {
  /** Commands the run does first, with the listed addresses, to fetch what the checks need. */
  prepare: string[];
  /** Commands SoftwareFactory runs on the result, in this order, without network. */
  checks: string[];
  /** Where each came from, in plain words, for the record and the story. */
  found: string[];
  /** The script entries the found checks stand on: a result that changes one of them is held. */
  watch: { path: string; scripts: string[] }[];
  /** The folders the found checks look at ("" is the whole project). A change outside them was checked by nothing. */
  covers: string[];
}

/** Folder names go into a command line, and a project's files are data: only plain names are used. */
const PLAIN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
const SKIP = new Set(["node_modules", "vendor", "dist", "build", "out", "target", "examples", "example", "testdata", "fixtures"]);

export function scriptsOf(text: string | null): { scripts: Record<string, string>; workspaces: boolean } | null {
  if (!text) return null;
  try {
    const j = JSON.parse(text) as { scripts?: unknown; workspaces?: unknown };
    const scripts: Record<string, string> = {};
    if (j.scripts && typeof j.scripts === "object") for (const [k, v] of Object.entries(j.scripts as Record<string, unknown>)) if (typeof v === "string") scripts[k] = v;
    return { scripts, workspaces: !!j.workspaces };
  } catch { return null; }
}

/**
 * `files`: every tracked path of the starting point. `read`: the text of one of them (null when it cannot be read).
 * Looks at the project's top folder and the folders right under it.
 */
export function findChecks(files: string[], read: (path: string) => string | null): FoundChecks {
  const has = new Set(files);
  const dirs = ["", ...[...new Set(files.filter((f) => f.split("/").length === 2).map((f) => f.split("/")[0]!))].filter((d) => PLAIN.test(d) && !SKIP.has(d)).sort()];
  const at = (d: string, f: string) => (d ? `${d}/${f}` : f);
  const out: FoundChecks = { prepare: [], checks: [], found: [], watch: [], covers: [] };
  const go: FoundChecks = { prepare: [], checks: [], found: [], watch: [], covers: [] };
  const root = has.has("package.json") ? scriptsOf(read("package.json")) : null;
  for (const d of dirs) {
    // Node. With workspaces the top folder speaks for the folders under it.
    if (has.has(at(d, "package.json")) && !(d && root?.workspaces)) {
      const pkg = d ? scriptsOf(read(at(d, "package.json"))) : root;
      const where = d ? ` --prefix ${d}` : "";
      if (pkg && (has.has(at(d, "pnpm-lock.yaml")) || has.has(at(d, "yarn.lock"))) && !has.has(at(d, "package-lock.json"))) out.found.push(`${at(d, "package.json")}: uses pnpm or yarn, which the room does not have yet, so no check was taken from it`);
      else if (pkg) {
        const wanted = ["typecheck", "build"].filter((k) => pkg.scripts[k]);
        if (wanted.length) {
          out.prepare.push(has.has(at(d, "package-lock.json")) ? `npm ci${where}` : `npm install --no-audit --no-fund${where}`);
          out.watch.push({ path: at(d, "package.json"), scripts: wanted });
          out.covers.push(d);
          for (const k of wanted) { out.checks.push(`npm run ${k}${where}`); out.found.push(`${at(d, "package.json")}: ${k}`); }
        }
      }
    }
    // Go. After Node, because a Go program often carries the built web pages inside it.
    if (has.has(at(d, "go.mod"))) {
      const c = d ? ` -C ${d}` : "";
      go.prepare.push(`go${c} mod download`);
      go.checks.push(`go${c} vet ./...`, `go${c} build ./...`);
      go.found.push(`${at(d, "go.mod")}: vet and build`);
      go.covers.push(d);
    }
  }
  return { prepare: [...out.prepare, ...go.prepare], checks: [...out.checks, ...go.checks], found: [...out.found, ...go.found], watch: out.watch, covers: [...new Set([...out.covers, ...go.covers])] };
}

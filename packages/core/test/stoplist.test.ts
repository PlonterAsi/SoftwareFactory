import { describe, expect, it } from "vitest";
import { cleanExtra, goModStops, packageStops, stopSentence, stopsFor } from "../src/fence/stoplist.js";

const none = () => null;
const fam = (files: string[], extra: string[] = []) => stopsFor(files, none, extra).map((s) => `${s.family}: ${s.file}`);

describe("the stop list", () => {
  it("lets ordinary work through", () => {
    expect(fam(["web/src/pages/Money.tsx", "backend/internal/store/store.go", "README.md", "web/src/hooks/useMoney.ts", "docs/keynote.md"])).toEqual([]);
  });
  it("stops each family by its paths", () => {
    expect(fam([".claude/settings.json", "CLAUDE.md", "web/.env.local", "certs/server.pem", ".npmrc", "backend/internal/auth/token.go"])).toEqual(["security: .claude/settings.json", "security: CLAUDE.md", "security: web/.env.local", "security: certs/server.pem", "security: .npmrc", "security: backend/internal/auth/token.go"]);
    expect(fam(["Dockerfile", "fly.toml", "infra/main.tf"])).toEqual(["leaves the computer: Dockerfile", "leaves the computer: fly.toml", "leaves the computer: infra/main.tf"]);
    expect(fam(["backend/migrations/0007_add.sql", "web/src/pages/Checkout.tsx", "backend/payouts.go"])).toEqual(["live data and money: backend/migrations/0007_add.sql", "live data and money: web/src/pages/Checkout.tsx", "live data and money: backend/payouts.go"]);
    expect(fam([".husky/pre-commit", "Makefile", "requirements.txt"])).toEqual(["runs by itself: .husky/pre-commit", "runs by itself: Makefile", "new package: requirements.txt"]);
  });
  it("takes your own paths too, and only plain ones", () => {
    expect(fam(["roadtomill/status.json"], ["roadtomill/Status"])).toEqual(["security: roadtomill/status.json"]);
    expect(cleanExtra(["  a ", "", 5, "x\ny", "b"])).toEqual(["a", "b"]);
  });
  it("reads a changed package.json: a new package, a moved one, a command npm runs by itself; not a plain script", () => {
    const was = JSON.stringify({ scripts: { build: "vite build" }, dependencies: { react: "^19.0.0" } });
    const now = JSON.stringify({ scripts: { build: "vite build --mode x", postinstall: "node x.js" }, dependencies: { react: "^19.1.0", "left-pad": "1.0.0" } });
    expect(packageStops("web/package.json", was, now).map((s) => s.why)).toEqual(["another version or source of react", "a new package: left-pad", 'the "postinstall" command, which npm runs by itself']);
    expect(packageStops("web/package.json", was, JSON.stringify({ scripts: { build: "x", lint: "eslint ." }, dependencies: { react: "^19.0.0" } }))).toEqual([]);
    expect(packageStops("web/package.json", was, "{ not json")).toHaveLength(1);
    expect(packageStops("web/package.json", was, null)).toEqual([]);
    const got = stopsFor(["web/package.json"], (_f, when) => (when === "before" ? was : now));
    expect(got.map((s) => s.family)).toEqual(["new package", "new package", "runs by itself"]);
    expect(stopSentence(got)).toBe("it waits for your look before it leaves: web/package.json (another version or source of react), and 2 more");
  });
  it("reads a changed go.mod", () => {
    const was = "module x\n\ngo 1.23\n\nrequire (\n\tgithub.com/jackc/pgx/v5 v5.6.0\n)\n";
    const now = "module x\n\ngo 1.23\n\nrequire (\n\tgithub.com/jackc/pgx/v5 v5.7.0\n\tgithub.com/evil/pkg v0.0.1 // indirect\n)\nreplace github.com/a/b => ../b\n";
    expect(goModStops("backend/go.mod", was, now).map((s) => s.why)).toEqual(["a new line in the module list: github.com/jackc/pgx/v5 v5.7.0", "a new line in the module list: github.com/evil/pkg v0.0.1", "a new line in the module list: replace github.com/a/b => ../b"]);
    // Inside a block that was already there, and the newer words of the file.
    const block = "module x\nreplace (\n\tgithub.com/a/b => ../b\n)\n";
    expect(goModStops("go.mod", block, block.replace(")\n", "\tgithub.com/c/d => github.com/evil/d v1.0.0\n)\ntoolchain go1.99.0\n"))).toHaveLength(2);
    expect(goModStops("backend/go.mod", was, was)).toEqual([]);
  });
  it("is not fooled by case, a link, a lockfile, a word inside a word, or a file it cannot read", () => {
    expect(fam([".Claude/settings.json", ".ENV", "Package.JSON5", ".mcp.json", ".vscode/tasks.json"]).map((x) => x.split(":")[0])).toEqual(["security", "security", "new package", "security", "security"]);
    // A link standing where the folder would be.
    expect(fam([".claude", ".husky", "migrations"])).toHaveLength(3);
    expect(stopsFor(["tools/cfg"], none, [], ["tools/cfg"])).toMatchObject([{ family: "security", file: "tools/cfg" }]);
    expect(fam(["web/package-lock.json", "pnpm-lock.yaml", "go.work", "vendor/modules.txt", ".pnpmfile.cjs"])).toHaveLength(5);
    expect(fam(["web/src/components/StripedTable.tsx", "web/src/authorList.ts"])).toEqual([]);
    expect(fam(["web/src/PaymentForm.tsx", "backend/internal/authService.go", "src/login.go"])).toHaveLength(3);
    const now = JSON.stringify({ packageManager: "yarn@https://evil.example/yarn.tgz", scripts: { dependencies: "node x.js" } });
    expect(packageStops("package.json", "{}", now).map((s) => s.family)).toEqual(["new package", "runs by itself"]);
    expect(stopsFor(["packages/x/package.json"], () => { throw new Error("cannot read"); })).toMatchObject([{ family: "new package", why: "it could not be read, so what it pulls in is not known" }]);
    const long = stopsFor(["package.json"], (_f, when) => (when === "before" ? "{}" : JSON.stringify({ dependencies: { ["a".repeat(100000)]: "1" } })));
    expect(long[0]!.why.length).toBeLessThanOrEqual(200);
  });
});

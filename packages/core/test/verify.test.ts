import { describe, it, expect } from "vitest";
import { buildVerification, howToVerifyFrom, layerOf, engineChecks } from "../src/tickets/verify.js";
import { EventLog } from "../src/index.js";

/** Verification: how a ticket's pass was tested, layer by layer, from what actually ran. */

describe("layerOf", () => {
  it("sorts changed files into backend, UI, database, tests, config and docs", () => {
    expect(layerOf("packages/core/src/server.ts")).toBe("Backend");
    expect(layerOf("apps/bridge/src/Tickets.tsx")).toBe("UI");
    expect(layerOf("apps/bridge/src/styles/bridge.css")).toBe("UI");
    expect(layerOf("packages/core/src/tickets/tables.ts")).toBe("Database");
    expect(layerOf("db/migrations/002_add.sql")).toBe("Database");
    expect(layerOf("packages/core/test/verify.test.ts")).toBe("Tests");
    expect(layerOf("src/foo.spec.js")).toBe("Tests");
    expect(layerOf("package.json")).toBe("Config");
    expect(layerOf(".github/workflows/ci.yml")).toBe("Config");
    expect(layerOf("docs/tickets.md")).toBe("Docs");
  });
});

describe("howToVerifyFrom", () => {
  it("reads the Builder's steps under How to verify, up to five", () => {
    expect(howToVerifyFrom("Done: the button works.\n\nHow to verify:\n1. Open Tickets.\n2. Press Login.\n- You see your name.\n\nThanks")).toEqual(["Open Tickets.", "Press Login.", "You see your name."]);
    expect(howToVerifyFrom("**How to verify:** run the app")).toEqual(["run the app"]);
    expect(howToVerifyFrom("No section here.")).toEqual([]);
  });
});

describe("buildVerification", () => {
  const checks = (tests: string, note = "cd packages/core && npx vitest related --run src/server.ts") => [
    { name: "gates", state: "passed", note: "" }, { name: "test integrity", state: "passed", note: "" }, { name: "tests", state: tests, note }, { name: "review", state: "passed", note: "" },
  ];
  it("a backend change with a new test that ran is tested; the screen it touched is only partly, and flagged as not opened", () => {
    const v = buildVerification({ route: "session", files: ["packages/core/src/server.ts", "packages/core/test/server.test.ts", "apps/bridge/src/Tickets.tsx", "docs/x.md"], checks: checks("passed"), builderText: "How to verify:\n- Open a ticket" });
    const by = Object.fromEntries(v.layers.map((l) => [l.layer, l]));
    expect(by.Backend.tested).toBe("yes");
    expect(by.Tests.tested).toBe("yes");
    expect(by.UI.tested).toBe("partly");
    expect(by.UI.how).toMatch(/no check opened the screen/);
    expect(by.Docs.tested).toBe("n/a");
    expect(v.untested).toEqual([]);
    expect(v.howToTest[0]).toMatch(/vitest related/);
    expect(v.howToVerify).toEqual(["Open a ticket"]);
  });
  it("existing tests passing without a new one is partly; tests that did not run leave every code layer untested", () => {
    expect(buildVerification({ route: "session", files: ["src/a.ts"], checks: checks("passed") }).layers[0].tested).toBe("partly");
    const v = buildVerification({ route: "session", files: ["src/a.ts", "db/schema.sql"], checks: checks("skipped", "dependencies are not installed"), expected: "It saves" });
    expect(v.untested).toEqual(["Backend", "Database"]);
    expect(v.layers[0].how).toMatch(/dependencies are not installed/);
    expect(v.howToVerify).toEqual(["Check that: It saves"]);
  });
  it("an engine run's browser check tests the UI, from its own events", () => {
    const log = new EventLog();
    log.append("factory.tests", { run: 5, passed: 12, failed: 0 });
    log.append("factory.screens", { run: 5, pass: true, browser: "chrome", screens: [{}, {}] });
    const e = engineChecks(log, 5);
    expect(e.checks.map((c) => [c.name, c.state])).toEqual([["tests", "passed"], ["screens", "passed"]]);
    const v = buildVerification({ route: "engine", run: 5, files: ["web/app.js", "src/logic.js", "test/logic.test.js"], ...e });
    expect(Object.fromEntries(v.layers.map((l) => [l.layer, l.tested]))).toEqual({ Backend: "yes", UI: "yes", Tests: "yes" });
    expect(v.layers.find((l) => l.layer === "UI")!.how).toMatch(/2 screens/);
  });
});

import { describe, expect, it } from "vitest";
import { ClaudeCodeRuntime, advisorFor } from "../src/runtime.js";

const work = { prompt: "x", cwd: "/w", tools: ["Read", "Edit"] };

describe("advisor tool on agent calls", () => {
  it("gives a working session on a cheaper model an opus advisor", () => {
    const args = new ClaudeCodeRuntime({ advisorSupported: true }).buildArgs({ ...work, model: "sonnet" });
    expect(args.join(" ")).toContain("--advisor opus");
  });

  it("leaves answer-only station calls without one", () => {
    const args = new ClaudeCodeRuntime({ advisorSupported: true }).buildArgs({ prompt: "x", model: "haiku" });
    expect(args).not.toContain("--advisor");
  });

  it("drops a default advisor that is not stronger than the agent", () => {
    expect(advisorFor({ ...work }, "opus", "opus")).toBeNull();
    expect(advisorFor({ ...work }, "claude-opus-5-5", "opus")).toBeNull();
    expect(advisorFor({ ...work }, "claude-haiku-5-5", "opus")).toBe("opus");
  });

  it("follows an explicit request: a model on any call, null for none", () => {
    expect(advisorFor({ prompt: "x", advisor: "fable" }, "opus", "opus")).toBe("fable");
    expect(advisorFor({ ...work, advisor: null }, "haiku", "opus")).toBeNull();
  });

  it("is off when the runtime is set to off, or the CLI lacks the flag", () => {
    expect(new ClaudeCodeRuntime({ advisor: "off", advisorSupported: true }).buildArgs({ ...work, model: "haiku" })).not.toContain("--advisor");
    expect(new ClaudeCodeRuntime({ advisorSupported: false }).buildArgs({ ...work, model: "haiku" })).not.toContain("--advisor");
  });

  it("asks a CLI without the flag and gets no advisor", () => {
    // A command that is not Claude Code never answers the probe the way the CLI does.
    const args = new ClaudeCodeRuntime({ command: process.execPath, commandArgs: ["-e", "process.exit(0)"] }).buildArgs({ ...work, model: "haiku" });
    expect(args).not.toContain("--advisor");
  });
});

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * A secret gate for what agents write (SF-17). Plain patterns for the keys people actually leak,
 * so it runs anywhere with no binary to install. gitleaks finds more; this catches the common ones.
 */
export const SECRET_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "private key", re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/ },
  { name: "AWS access key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: "GitHub token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/ },
  { name: "Anthropic API key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: "OpenAI API key", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/ },
  { name: "Slack token", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
  { name: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: "Stripe live key", re: /\b[rs]k_live_[0-9A-Za-z]{20,}/ },
];

export interface SecretHit { file: string; line: number; kind: string }

/** Where in this text a secret appears. Each line is reported once, by the first pattern that matches. */
export function findSecrets(text: string, file = ""): SecretHit[] {
  const out: SecretHit[] = [];
  text.split(/\r?\n/).forEach((l, i) => {
    const p = SECRET_PATTERNS.find((x) => x.re.test(l));
    if (p) out.push({ file, line: i + 1, kind: p.name });
  });
  return out;
}

/** Secrets in a set of files (path to content). Data folders are skipped: the person's own data is not code. */
export function scanFiles(files: Record<string, string>): SecretHit[] {
  return Object.entries(files).filter(([f]) => !/(^|\/)(data|node_modules|\.git)\//.test(f)).flatMap(([f, t]) => findSecrets(t, f));
}

export function describeSecrets(hits: SecretHit[]): string {
  return hits.slice(0, 10).map((h) => `${h.file ? `${h.file}:` : "line "}${h.line}: looks like a ${h.kind}`).join("\n");
}

/**
 * A Claude Code PostToolUse hook for Edit and Write: it scans the file the agent just wrote and,
 * on a hit, exits 2 so the agent sees why and takes the secret out. Written as a self-contained
 * Node script, so it runs on Windows without Git Bash.
 */
export function secretHookScript(): string {
  const pats = SECRET_PATTERNS.map((p) => `[${JSON.stringify(p.name)}, ${p.re.toString()}]`).join(",\n  ");
  return `// SoftwareFactory secret gate (generated; see packages/core/src/safety/secrets.ts).
import { readFileSync } from "node:fs";
const PATTERNS = [
  ${pats}
];
let raw = "";
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", () => {
  let file = "";
  try { const j = JSON.parse(raw || "{}"); file = (j.tool_input && (j.tool_input.file_path || j.tool_input.path)) || ""; } catch {}
  if (!file) process.exit(0);
  let text = "";
  try { text = readFileSync(file, "utf8"); } catch { process.exit(0); }
  const hits = [];
  text.split(/\\r?\\n/).forEach((l, i) => { const p = PATTERNS.find(([, re]) => re.test(l)); if (p) hits.push(file + ":" + (i + 1) + ": looks like a " + p[0]); });
  if (!hits.length) process.exit(0);
  process.stderr.write("SoftwareFactory secret gate: this file now holds what looks like a real secret. Take it out (read it from an environment variable or a config file that is not committed) before going on.\\n" + hits.slice(0, 10).join("\\n") + "\\n");
  process.exit(2);
});
`;
}

/** Write the hook script once into a folder; returns its path. */
export function secretHookFile(dir: string): string {
  const file = join(dir, "secret-gate.mjs");
  const body = secretHookScript();
  mkdirSync(dir, { recursive: true });
  if (!existsSync(file) || readSafe(file) !== body) writeFileSync(file, body);
  return file;
}

function readSafe(f: string): string {
  try { return readFileSync(f, "utf8"); } catch { return ""; }
}

/** The --settings JSON that wires the gate after every Edit and Write. */
export function secretHookSettings(hookFile: string, node = process.execPath): string {
  const q = (s: string) => `"${s.replace(/"/g, '\\"')}"`;
  return JSON.stringify({ hooks: { PostToolUse: [{ matcher: "Edit|Write|MultiEdit", hooks: [{ type: "command", command: `${q(node)} ${q(hookFile)}` }] }] } });
}

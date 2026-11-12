/**
 * Test output an agent reads, trimmed to what it needs (SF-16): the lines that say what failed and
 * where, with a little context, and a short summary. A green run's chatter and stack frames from
 * node internals cost tokens on every fix round and help no one.
 */
const SIGNAL = /\b(not ok|fail(?:ed|ing|ure)?|error|assert|expected|actual|received|throws?|timed? ?out|cannot|undefined is not|is not a function|syntaxerror|typeerror|referenceerror)\b|^\s*[-+]\s|✖|×/i;
const NOISE = /^\s*at .*\((?:node:|internal\/)|^\s*at (?:node:|internal\/)|^# (?:tests|suites|pass|cancelled|skipped|todo|duration_ms)\b/;
const SUMMARY = /^#?\s*(tests|pass|fail|suites|duration_ms)\s+\d/i;

export function failureLines(output: string, max = 100, maxChars = 3000): string {
  const lines = output.replace(/\r\n/g, "\n").split("\n");
  if (lines.length <= max && output.length <= maxChars) return output.trim();
  const keep = new Set<number>();
  lines.forEach((l, i) => {
    if (NOISE.test(l) || !SIGNAL.test(l)) return;
    // The failing line, the one before it (often the test name) and two after (usually the location).
    for (let j = Math.max(0, i - 1); j <= Math.min(lines.length - 1, i + 2); j++) if (!NOISE.test(lines[j])) keep.add(j);
  });
  const summary = lines.filter((l) => SUMMARY.test(l.trim())).slice(-4);
  const picked: string[] = [];
  let last = -2;
  for (const i of [...keep].sort((a, b) => a - b)) {
    if (picked.length >= max - summary.length - 1) break;
    if (i !== last + 1 && picked.length) picked.push("…");
    picked.push(lines[i].slice(0, 300));
    last = i;
  }
  const head = picked.length ? picked : lines.slice(-(max - summary.length - 1));
  return [...head, ...(summary.length ? ["", ...summary] : [])].join("\n").trim().slice(0, maxChars);
}

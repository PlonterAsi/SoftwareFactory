/**
 * SF-40: a project started from the Run tab that dies is a bug in that project, not a line in a console nobody
 * reads again. When a program ends by itself with a failing exit code, or cannot start at all, its output is read
 * for the error it printed (a JavaScript or Python error and its stack, a Rust panic, a Go panic), and that is what
 * the bug says; with no recognisable error the exit code is. A program stopped by you, or one that ended with 0, is
 * not a fault.
 */

export interface RunFault { message: string; stack?: string }

/** A line that starts an error report: `TypeError: x`, `Error: x`, `Uncaught ...`, a Python traceback, a panic. */
const HEADER = /^\s*(?:Uncaught\s+)?(?:[A-Z][A-Za-z]*(?:Error|Exception)\b[:\s]|Error:|Traceback \(most recent call last\)|thread '.*' panicked|panic:|Fatal error|FATAL\b|Unhandled\b)/;
/** A line that belongs to the stack under it. */
const FRAME = /^\s+(?:at\s|File\s"|\d+:\s|in\s)|^\s*\^+\s*$|^\s{2,}\S/;

/** The first error report in a program's output: its header line and the stack lines under it. */
export function faultInOutput(lines: string[]): RunFault | null {
  const i = lines.findIndex((l) => HEADER.test(l));
  if (i < 0) return null;
  const stack: string[] = [];
  for (const l of lines.slice(i + 1, i + 40)) { if (!FRAME.test(l) && !(stack.length === 0 && /^\s/.test(l))) break; stack.push(l); }
  let message = lines[i].trim();
  // A Python traceback names the error on its last line, after the frames.
  if (/^Traceback/.test(message)) {
    const last = lines.slice(i + 1 + stack.length).find((l) => l.trim());
    if (last) message = last.trim();
  }
  return { message: message.slice(0, 300), ...(stack.length ? { stack: [lines[i], ...stack].join("\n").slice(0, 6000) } : {}) };
}

/** Whether a program's end is a fault worth a bug, and what the bug says. */
export function runFault(code: number | null, how: "exited" | "stopped" | "failed" | "replaced", tail: string[]): RunFault | null {
  if (how === "stopped" || how === "replaced") return null;
  if (how === "exited" && (code === 0 || code == null)) return null;
  return faultInOutput(tail) ?? { message: how === "failed" ? ([...tail].reverse().find((l) => /could not start/i.test(l)) ?? "It could not start.").trim().slice(0, 300) : `It exited with code ${code}.` };
}

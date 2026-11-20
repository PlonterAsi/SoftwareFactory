// Record-then-replay gate (idea from erkamyaman/rust-anything, adapted).
// Record what a module does for a set of inputs, then replay the same inputs
// against a changed version. A unit counts as done only when nothing differs.
// It only catches what was recorded.

export interface RecordedCase { name: string; input: unknown[]; output?: unknown; error?: string }
export interface Recording { module: string; recordedAt: string; cases: RecordedCase[] }
export interface ReplayDiff { name: string; expected: string; actual: string }
export interface ReplayResult { ok: boolean; total: number; diffs: ReplayDiff[]; summary: string }

type Fn = (...args: any[]) => unknown;

function show(c: { output?: unknown; error?: string }): string {
  return c.error !== undefined ? `throws ${c.error}` : `returns ${JSON.stringify(c.output) ?? "undefined"}`;
}

async function run(fn: Fn, input: unknown[]): Promise<{ output?: unknown; error?: string }> {
  try { return { output: await fn(...input) }; }
  catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
}

/** Run `fn` on each input and keep what it returned or threw. */
export async function recordBehavior(module: string, fn: Fn, inputs: { name: string; input: unknown[] }[], now = new Date()): Promise<Recording> {
  const cases: RecordedCase[] = [];
  for (const i of inputs) cases.push({ name: i.name, input: i.input, ...(await run(fn, i.input)) });
  // JSON round trip so a stored recording and a fresh one compare the same way.
  return JSON.parse(JSON.stringify({ module, recordedAt: now.toISOString(), cases })) as Recording;
}

/** Replay a recording against `fn`; every difference is listed in plain words. */
export async function replayBehavior(rec: Recording, fn: Fn): Promise<ReplayResult> {
  const diffs: ReplayDiff[] = [];
  for (const c of rec.cases) {
    const got = await run(fn, c.input);
    const actual = show(JSON.parse(JSON.stringify(got)));
    const expected = show(c);
    if (actual !== expected) diffs.push({ name: c.name, expected, actual });
  }
  const ok = diffs.length === 0;
  const summary = ok
    ? `${rec.module}: all ${rec.cases.length} recorded cases behave the same.`
    : `${rec.module}: ${diffs.length} of ${rec.cases.length} recorded cases changed: ${diffs.map((d) => `"${d.name}" ${d.expected} became ${d.actual}`).join("; ")}.`;
  return { ok, total: rec.cases.length, diffs, summary };
}

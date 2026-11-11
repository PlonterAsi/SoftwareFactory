import type { FactoryRunView } from "../api";
import { GateActions, STEP } from "../GateActions";
import { StatusGlyph, StatusTag } from "../ui";

/**
 * One approval, with what you are approving laid out beside the question: for the plan, its
 * summary, tasks, acceptance checks and budget; for the build, its tests, review and files. The
 * shared approval bar sits at the bottom of the card and stays in view while you read.
 */
export function ApprovalCard({ run, onShowRun }: { run: FactoryRunView; onShowRun: (run: number) => void }) {
  const w = run.waiting!;
  const name = run.plan?.name ?? run.idea;
  const lastTests = run.tests.at(-1);
  const review = run.reviews.at(-1);
  const files = Object.entries(run.files);
  const failedStep = w.kind === "retry" && w.station;
  const what = failedStep ? `${STEP[w.station!] ?? w.station} failed` : w.gate === "gateA" ? "Your OK on the plan" : w.gate === "gateB" ? "Your OK on the build" : "Your call";
  return (
    <article className="approval" aria-label={`${what}: ${name}`}>
      <header className="approval-head">
        <StatusTag status={failedStep ? "failed" : "needs"}>{what}</StatusTag>
        <h2 className="approval-title">{name}</h2>
        <span className="muted mono">build #{run.run}</span>
        <button className="link approval-open" onClick={() => onShowRun(run.run)}>Open the build</button>
      </header>
      <div className="approval-cols">
        {w.gate === "gateA" && run.plan ? <>
          <section className="approval-col">
            <h3>What it will be</h3>
            <p className="approval-summary">{run.plan.summary}</p>
            <h3>Tasks <span className="muted">{run.plan.tasks.length}</span></h3>
            <ol className="approval-tasks">{run.plan.tasks.map((t) => <li key={t.id}><span className="mono muted">{t.id}</span> {t.title}</li>)}</ol>
          </section>
          <section className="approval-col">
            <h3>Done means <span className="muted">{run.plan.acceptance.length} checks</span></h3>
            <ul className="approval-checks">{run.plan.acceptance.map((a, i) => <li key={i}><StatusGlyph status="idle" size={13} label="" />{a}</li>)}</ul>
            <h3>Budget</h3>
            <p className="approval-summary"><span className="num">${run.spentUsd.toFixed(2)}</span> spent so far of a <span className="num">${run.maxUsd.toFixed(2)}</span> cap for this build.</p>
          </section>
        </> : w.gate === "gateB" ? <>
          <section className="approval-col">
            <h3>Tests {lastTests && <span className="muted">round {lastTests.round}</span>}</h3>
            {lastTests ? <>
              <p className="approval-summary"><StatusTag status={lastTests.failed ? "failed" : "done"}>{lastTests.passed} passed{lastTests.failed ? `, ${lastTests.failed} failed` : ""}</StatusTag></p>
              <ul className="approval-checks">{lastTests.cases.slice(0, 8).map((c, i) => <li key={i}><StatusGlyph status={c.pass ? "done" : "failed"} size={13} label="" />{c.name}</li>)}</ul>
            </> : <p className="muted">No test results yet.</p>}
            {run.fixRounds > 0 && <p className="muted">{run.fixRounds} fix round{run.fixRounds > 1 ? "s" : ""} on the way.</p>}
          </section>
          <section className="approval-col">
            <h3>Review</h3>
            {review ? <>
              <p className="approval-summary"><StatusTag status={review.verdict === "pass" ? "done" : "failed"}>{review.verdict === "pass" ? "Reviewer passed it" : "Reviewer asked for fixes"}</StatusTag></p>
              {review.findings.length > 0 && <ul className="approval-checks">{review.findings.slice(0, 5).map((f, i) => <li key={i}><StatusGlyph status={f.severity === "high" ? "failed" : "idle"} size={13} label="" />{f.text}</li>)}</ul>}
            </> : <p className="muted">No review yet.</p>}
            <h3>Files <span className="muted">{files.length}</span></h3>
            <p className="approval-summary mono approval-files">{files.slice(0, 6).map(([f]) => f).join("  ·  ") || "None yet"}</p>
          </section>
        </> : (
          <section className="approval-col wide">
            <p className="approval-summary">{w.question}</p>
            <p className="muted">Open the build to see everything that led here.</p>
          </section>
        )}
      </div>
      <footer className="approval-bar"><GateActions run={run} /></footer>
    </article>
  );
}

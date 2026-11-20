/**
 * How a ticket's latest pass was tested (core tickets/verify.ts): each layer it changed (backend, UI, database,
 * tests, config, docs) and whether a check really tested it, how to test it again, and how to see it works.
 * A ticket waiting for your look shows it open; a changed layer nothing tested is flagged.
 */
export type Tested = "yes" | "partly" | "no" | "n/a";
export interface VerificationView {
  route: "session" | "engine"; run?: number; at: string; by: string;
  layers: { layer: string; files: string[]; tested: Tested; how: string }[];
  checks: { name: string; state: string; note: string }[];
  howToTest: string[]; howToVerify: string[]; untested: string[];
}

const WORD: Record<Tested, string> = { yes: "Tested", partly: "Partly tested", no: "Not tested", "n/a": "No test applies" };
const MARK: Record<Tested, string> = { yes: "✓", partly: "◐", no: "✕", "n/a": "–" };

export function TicketVerify({ v, lookNow }: { v: VerificationView; lookNow: boolean }) {
  const partly = v.layers.filter((l) => l.tested === "partly").map((l) => l.layer);
  const verdict = v.untested.length
    ? `Not tested: ${v.untested.join(", ")}. Check ${v.untested.length === 1 ? "it" : "them"} yourself before you close it.`
    : partly.length ? `Partly tested: ${partly.join(", ")}.` : v.layers.length ? "Every changed layer was tested." : "No changed files were reported.";
  return (
    <details className={`tk-verify ${v.untested.length ? "v-gap" : partly.length ? "v-part" : "v-ok"}`} open={lookNow || v.untested.length > 0} aria-label="Verification">
      <summary>
        <b>Verification</b> <span className="tk-verify-verdict">{verdict}</span>
        <span className="muted small"> · {v.route === "engine" ? `run #${v.run}` : "one Builder session"} · {new Date(v.at).toLocaleString()}</span>
      </summary>
      {!!v.layers.length && (
        <table className="tk-verify-layers">
          <thead><tr><th>Layer</th><th>Tested?</th><th>How</th><th>Files</th></tr></thead>
          <tbody>
            {v.layers.map((l) => (
              <tr key={l.layer} className={`t-${l.tested === "n/a" ? "na" : l.tested}`}>
                <td>{l.layer}</td>
                <td className="tk-verify-mark">{MARK[l.tested]} {WORD[l.tested]}</td>
                <td>{l.how}</td>
                <td className="muted small" title={l.files.join("\n")}>{l.files.length} file{l.files.length === 1 ? "" : "s"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="tk-verify-cols">
        <div>
          <h4>How to verify</h4>
          {v.howToVerify.length ? <ol>{v.howToVerify.map((s, i) => <li key={i}>{s}</li>)}</ol> : <p className="muted small">The crew gave no steps. Read the change on its branch or pull request.</p>}
        </div>
        <div>
          <h4>How to test it again</h4>
          {v.howToTest.length ? <ul className="mono small">{v.howToTest.map((s, i) => <li key={i}>{s}</li>)}</ul> : <p className="muted small">No test ran in this pass.</p>}
        </div>
      </div>
      {!!v.checks.length && (
        <p className="tk-verify-checks small">
          Checks: {v.checks.map((c) => <span key={c.name} className={`tk-step s-${c.state}`} title={c.note || c.state}>{c.state === "passed" ? "✓" : c.state === "failed" ? "✕" : "–"} {c.name}</span>)}
        </p>
      )}
    </details>
  );
}

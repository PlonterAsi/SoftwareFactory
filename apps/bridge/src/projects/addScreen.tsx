import { useState } from "react";
import { post } from "../api";
import type { PanelContext } from "./panels";

/**
 * visualizeEverything for finished projects: a project with no page (built before
 * the GUI default, or CLI only) gets one button that asks the crew to add a screen.
 * Same folder, the locked tests are kept, it ships as the next version.
 */
export function AddScreen({ ctx }: { ctx: PanelContext }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function go() {
    setBusy(true); setErr(null);
    try {
      const r = await post(`/api/projects/${ctx.project.id}/screen`, {});
      ctx.showRun(r.run);
    } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  }
  return (
    <section className="rn-screen" aria-label="Add a screen">
      <h3>No screen yet</h3>
      <p className="muted rn-note">This project only runs as a command. The crew can add a page you use right here: same folder, its tests kept, shipped as the next version. You accept it at the build gate.</p>
      <button className="sm" onClick={go} disabled={busy}>{busy ? "Starting…" : "Add a screen"}</button>
      {err && <p className="error rn-note" role="alert">{err}</p>}
    </section>
  );
}

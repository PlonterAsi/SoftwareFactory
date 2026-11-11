import { useState } from "react";
import { post } from "../api";
import type { PanelContext } from "./panels";

/**
 * visualizeEverything for finished projects: a project with no page (built before
 * the GUI default, or CLI only) gets one button that asks the crew to add a screen.
 * Same folder, the locked tests are kept, it ships as the next version.
 */
export function AddScreen({ ctx, baseRun }: { ctx: PanelContext; baseRun: number }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function go() {
    setBusy(true); setErr(null);
    try {
      const r = await post(`/api/projects/${ctx.project.id}/screen`, { baseRun });
      ctx.showRun(r.run);
    } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  }
  return (
    <section className="rn-screen" aria-label="Turn into an app">
      <h3>This is a script, not an app yet</h3>
      <p className="muted rn-note">This project only runs as a command. The crew can turn it into a real app you use right here: screens to create, edit and delete what it works on, its results kept and shown, one press to start. Same folder, its tests kept, shipped as the next version; you accept it at the build gate.</p>
      <button className="sm" onClick={go} disabled={busy}>{busy ? "Starting…" : "Turn into an app"}</button>
      {err && <p className="error rn-note" role="alert">{err}</p>}
    </section>
  );
}

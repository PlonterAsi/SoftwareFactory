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
      <p className="muted rn-note">This project only runs as a command. The crew can turn it into a real app you use right here: screens to create, edit and delete what it works on, its results kept and shown, one press to start. Same folder, its tests kept, shipped as the next version; you give your OK on the build.</p>
      <button className="sm" onClick={go} disabled={busy}>{busy ? "Starting…" : "Turn into an app"}</button>
      {err && <p className="error rn-note" role="alert">{err}</p>}
    </section>
  );
}

/**
 * Pages built before the factory made full apps are small demos: a page over the project's logic,
 * often with sample data baked in. One press asks the crew to rebuild it on the app kit in the same
 * folder (records you add, edit and delete, kept on disk, a System view), its tests kept.
 */
export function UpgradeToApp({ ctx, baseRun, name }: { ctx: PanelContext; baseRun: number; name?: string }) {
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
    <section className="rn-screen rn-upgrade" aria-label="Upgrade to a full app">
      <h3>{name ? `${name} is an early demo page` : "This is an early demo page"}</h3>
      <p className="muted rn-note">It was built before SoftwareFactory made full apps, so it is one page over its logic with sample data, nothing you can keep. The crew can rebuild it as a full app in the same folder: lists and forms to add, edit and delete its records, kept on disk, its own views, and a System view of every part. Its tests are kept; you give your OK on the build. Usually $0.30 to $1.</p>
      <button className="sm" onClick={go} disabled={busy}>{busy ? "Starting…" : "Upgrade to a full app"}</button>
      {err && <p className="error rn-note" role="alert">{err}</p>}
    </section>
  );
}

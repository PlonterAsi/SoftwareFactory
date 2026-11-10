import { useEffect, useState } from "react";
import { shell, type CoreStatus } from "./api";

/**
 * Shown when the Bridge cannot reach the core for a few seconds. Inside the
 * desktop app it asks the shell why (did Node start, what did the core print)
 * and offers a restart; in a browser it says which command starts the core.
 */
export function CoreDown({ online }: { online: boolean }) {
  const [show, setShow] = useState(false);
  const [st, setSt] = useState<CoreStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const desktop = "__TAURI_INTERNALS__" in window;

  // Give the core a moment to start before raising the alarm.
  useEffect(() => {
    if (online) { setShow(false); return; }
    const t = setTimeout(() => setShow(true), 4000);
    return () => clearTimeout(t);
  }, [online]);
  useEffect(() => {
    if (!show || !desktop) return;
    shell<CoreStatus>("core_status").then(setSt);
    const t = setInterval(() => shell<CoreStatus>("core_status").then(setSt), 3000);
    return () => clearInterval(t);
  }, [show, desktop]);

  if (!show) return null;
  const restart = async () => { setBusy(true); setSt(await shell<CoreStatus>("restart_core")); setTimeout(() => setBusy(false), 3000); };
  return (
    <div className="scrim solid">
      <div className="coredown" role="alert">
        <div className="setup-kicker mono">ENGINE ROOM</div>
        <h2>The factory core is not answering</h2>
        {desktop ? <>
          <p>The Bridge is the window; the core is the engine behind it (a small Node.js process on this computer). {st?.running ? "It is running but not answering yet; give it a few seconds." : "It is not running."}</p>
          {st?.error && <p className="err">{st.error}</p>}
          {st && !st.bundledNode && /not found|cannot find|program not found|os error 2/i.test(st.error ?? "") && (
            <p>This build expects Node.js 22.5 or newer on the computer. Install it from nodejs.org (LTS), then press Restart.</p>
          )}
          <div className="coredown-actions">
            <button disabled={busy} onClick={restart}>{busy ? "Restarting…" : "Restart the core"}</button>
          </div>
          {st && <details>
            <summary>Details for a bug report</summary>
            <pre className="mono">{`node:  ${st.node}\ncore:  ${st.entry}\ndata:  ${st.dataDir}\nlog:   ${st.log}\n\n${st.logTail || "(the core printed nothing)"}`}</pre>
          </details>}
        </> : <>
          <p>Start it in a terminal from the repo folder, then this page reconnects by itself:</p>
          <pre className="mono">npm run dev -w @sf/core</pre>
        </>}
      </div>
    </div>
  );
}

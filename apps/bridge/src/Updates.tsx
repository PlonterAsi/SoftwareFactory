import { useCallback, useEffect, useRef, useState } from "react";
import { API, shell } from "./api";

/**
 * In-app updates. The desktop shell checks GitHub for a newer signed build
 * (`update_check`), downloads and installs it (`update_install`), and reports
 * progress (`update_status`). This file decides when:
 *
 * - a check 5 s after the window opens, then every 6 hours, and on the button;
 * - with "Install updates by themselves" on (the default), an update found while
 *   no factory run is working installs after a 15 s countdown you can stop;
 *   one found mid-run waits until the factory is idle;
 * - with it off, the update waits for the Install button.
 *
 * Installing stops the core (the database stays where it is), the installer
 * replaces the app and starts the new version, and any run it cut resumes.
 */
export interface UpdateStatus {
  phase: "idle" | "checking" | "current" | "available" | "downloading" | "installing" | "error";
  current: string;
  version: string | null;
  notes: string | null;
  date: string | null;
  downloaded: number;
  total: number | null;
  error: string | null;
  checkedAt: string | null;
}
export interface UpdatesReport { auto: boolean; appVersion: string | null; activeRuns: number; history: { ts: string; from: string | null; to: string }[] }

const COUNTDOWN_S = 15;
const FIRST_CHECK_MS = 5_000;
const EVERY_MS = 6 * 3_600_000;

export function useUpdates(online: boolean) {
  const desktop = "__TAURI_INTERNALS__" in window;
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [report, setReport] = useState<UpdatesReport | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [snoozed, setSnoozed] = useState<string | null>(null);

  const loadReport = useCallback(async () => {
    try { setReport(await (await fetch(`${API}/api/updates`)).json()); } catch { /* core down: CoreDown speaks */ }
  }, []);
  const check = useCallback(async () => {
    if (!desktop) return;
    setStatus((s) => (s ? { ...s, phase: "checking", error: null } : s));
    const s = await shell<UpdateStatus>("update_check");
    if (s) setStatus(s);
  }, [desktop]);
  const install = useCallback(async () => {
    setCountdown(null);
    setStatus((s) => (s ? { ...s, phase: "downloading", downloaded: 0, error: null } : s));
    // On success the app exits inside this call and the new version starts.
    const s = await shell<UpdateStatus>("update_install");
    if (s) setStatus(s);
  }, []);
  const setAuto = useCallback(async (auto: boolean) => {
    const r = await fetch(`${API}/api/updates`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ auto }) });
    if (r.ok) setReport(await r.json());
  }, []);

  // First look, then every few hours.
  useEffect(() => {
    if (!desktop) return;
    shell<UpdateStatus>("update_status").then((s) => s && setStatus(s));
    const first = setTimeout(check, FIRST_CHECK_MS);
    const every = setInterval(check, EVERY_MS);
    return () => { clearTimeout(first); clearInterval(every); };
  }, [desktop, check]);
  useEffect(() => { if (online) loadReport(); }, [online, loadReport]);

  // Progress while something is moving.
  const moving = status?.phase === "checking" || status?.phase === "downloading" || status?.phase === "installing";
  useEffect(() => {
    if (!moving) return;
    const t = setInterval(() => shell<UpdateStatus>("update_status").then((s) => s && setStatus(s)), 500);
    return () => clearInterval(t);
  }, [moving]);

  // While an update waits, keep an eye on whether the factory went idle.
  const waiting = status?.phase === "available";
  useEffect(() => {
    if (!waiting || !online) return;
    loadReport();
    const t = setInterval(loadReport, 10_000);
    return () => clearInterval(t);
  }, [waiting, online, loadReport]);

  // Automatic install: when idle, count down, then go.
  const autoGo = !!(waiting && report?.auto && report.activeRuns === 0 && status?.version && snoozed !== status.version);
  const fired = useRef(false);
  useEffect(() => {
    if (!autoGo) { setCountdown(null); return; }
    fired.current = false;
    setCountdown(COUNTDOWN_S);
    const t = setInterval(() => setCountdown((c) => (c == null ? null : c - 1)), 1000);
    return () => clearInterval(t);
  }, [autoGo]);
  useEffect(() => {
    if (countdown != null && countdown <= 0 && !fired.current) { fired.current = true; install(); }
  }, [countdown, install]);

  return {
    desktop, status, report, countdown, check, install, setAuto,
    snooze: () => { setSnoozed(status?.version ?? null); setCountdown(null); },
    version: status?.current ?? report?.appVersion ?? null,
  };
}
export type Updates = ReturnType<typeof useUpdates>;

const mb = (n: number) => (n / 1_048_576).toFixed(1);
function pct(s: UpdateStatus) { return s.total ? Math.min(100, Math.round((s.downloaded / s.total) * 100)) : null; }

/** Small chip in the top bar: the version, lit when an update is waiting. */
export function VersionChip({ u, onOpen }: { u: Updates; onOpen: () => void }) {
  if (!u.version) return null;
  const s = u.status;
  const ready = s?.phase === "available" || s?.phase === "downloading" || s?.phase === "installing";
  return (
    <button className={`version-chip${ready ? " ready" : ""}`} onClick={onOpen} title={ready ? `Version ${s?.version} is ready. Click for updates.` : "Click for updates"}>
      v{u.version}{ready ? ` → v${s?.version}` : ""}
    </button>
  );
}

/** A strip under the top bar while an update is counting down, waiting for idle, or installing. */
export function UpdateBanner({ u }: { u: Updates }) {
  const s = u.status;
  if (!s || !s.version) return null;
  if (s.phase === "downloading" || s.phase === "installing") {
    const p = pct(s);
    return (
      <div className="update-banner" role="status">
        <span>{s.phase === "installing" ? `Installing v${s.version}. The app closes and opens again in a moment; running work resumes.` : `Downloading v${s.version}${p != null ? ` · ${p}%` : ""}`}</span>
        <span className="update-bar" aria-hidden><span style={{ width: `${s.phase === "installing" ? 100 : p ?? 30}%` }} className={p == null && s.phase === "downloading" ? "indeterminate" : ""} /></span>
      </div>
    );
  }
  if (s.phase !== "available") return null;
  if (u.countdown != null) return (
    <div className="update-banner" role="status">
      <span>Updating to v{s.version} in {Math.max(0, u.countdown)} s. Nothing is lost: the factory is idle and your data stays put.</span>
      <button className="sm" onClick={u.install}>Update now</button>
      <button className="ghost sm" onClick={u.snooze}>Not now</button>
    </div>
  );
  if (u.report?.auto && u.report.activeRuns > 0) return (
    <div className="update-banner quiet" role="status">
      <span>v{s.version} is ready. It installs by itself when the {u.report.activeRuns === 1 ? "running build finishes" : `${u.report.activeRuns} running builds finish`}.</span>
      <button className="ghost sm" onClick={u.install}>Install now (the run resumes after)</button>
    </div>
  );
  return null;
}

/** The Updates section of Ship's systems: version, status, buttons, setting and history. */
export function UpdatesSection({ u }: { u: Updates }) {
  const s = u.status;
  const r = u.report;
  const p = s ? pct(s) : null;
  const busy = s?.phase === "checking" || s?.phase === "downloading" || s?.phase === "installing";
  return (
    <section className="setup-sec updates">
      <h3>Updates {u.desktop && <button className="link" disabled={busy} onClick={u.check}>{s?.phase === "checking" ? "checking…" : "Check for updates"}</button>}</h3>
      {!u.desktop ? <p className="place-hint">Updates run in the installed desktop app. This browser view always shows the core it talks to.</p> : <>
        <div className="update-line">
          <span className="mono">v{u.version ?? "?"}</span>
          <span className={`update-state ${s?.phase ?? "idle"}`}>
            {!s || s.phase === "idle" ? "Not checked yet"
              : s.phase === "checking" ? "Looking for a newer version…"
              : s.phase === "current" ? "Up to date"
              : s.phase === "available" ? `v${s.version} is available`
              : s.phase === "downloading" ? `Downloading v${s.version} · ${mb(s.downloaded)} MB${s.total ? ` of ${mb(s.total)} MB` : ""}`
              : s.phase === "installing" ? `Installing v${s.version}…`
              : "Could not update"}
          </span>
          {s?.checkedAt && <span className="muted mono">checked {new Date(Number(s.checkedAt) * 1000).toLocaleTimeString()}</span>}
        </div>
        {(s?.phase === "downloading" || s?.phase === "installing") && (
          <span className="update-bar" aria-hidden><span style={{ width: `${s.phase === "installing" ? 100 : p ?? 30}%` }} className={p == null && s.phase === "downloading" ? "indeterminate" : ""} /></span>
        )}
        {s?.phase === "error" && <p className="setup-blocker">{s.error}</p>}
        {s?.phase === "available" && <>
          {s.notes && <p className="place-hint">{s.notes}</p>}
          <button onClick={u.install}>Install v{s.version} now</button>
          {r && r.activeRuns > 0 && <p className="place-hint">{r.activeRuns} build{r.activeRuns > 1 ? "s are" : " is"} running. Installing now pauses {r.activeRuns > 1 ? "them" : "it"}; {r.activeRuns > 1 ? "they resume" : "it resumes"} from the last finished station when the new version starts.</p>}
        </>}
      </>}
      {r && <label className="update-auto">
        <input type="checkbox" checked={r.auto} onChange={(e) => u.setAuto(e.target.checked)} />
        Install updates by themselves when the factory is idle (15 s warning, you can say Not now)
      </label>}
      {r && r.history.length > 0 && <ol className="update-history" aria-label="Versions this install has run">
        {r.history.map((h) => <li key={h.ts + h.to}><span className="mono">v{h.to}</span> <span className="muted">{h.from ? `from v${h.from}` : "first run"} · {new Date(h.ts).toLocaleString()}</span></li>)}
      </ol>}
      <p className="place-hint">Updates come from this project's GitHub releases and must carry the SoftwareFactory signature; anything else is refused. Your database, projects and settings stay in the data folder and are not touched.</p>
    </section>
  );
}

import { useEffect, useRef, useState, type FormEvent } from "react";
import { API } from "./api";
import { ago } from "./projects/builtin";

type State = "not-set-up" | "setting-up" | "off" | "starting" | "idle" | "busy" | "waiting" | "stopping";
export interface RunnerView {
  id: string; repo: string; name: string; labels: string[]; dir: string; on: boolean; createdAt: string;
  state: State; note: string | null; pid: number | null; runningSince: string | null; restarts: number; retryInSecs: number | null;
  job: string | null; version: string | null; registered: boolean; runsOn: string[]; log: string; lines: number;
}
interface LocalJob { runner: string; repo: string; name: string; startedAt: string; endedAt: string | null; result: string | null }
interface PcLoad { cpuBusy: number | null; cores: number; memFreeGb: number; memTotalGb: number }
interface Report { runners: RunnerView[]; jobs: LocalJob[]; busy: number; pc?: PcLoad }
interface GhStep { number: number; name: string; status: string; conclusion: string | null; startedAt: string | null; endedAt: string | null }
interface GhJob { name: string; status: string; conclusion: string | null; runner: string | null; here: boolean | null; startedAt: string | null; endedAt: string | null; url?: string | null; steps?: GhStep[] }
interface GhRun { id: number; name: string; title: string; event: string; branch: string | null; status: string; conclusion: string | null; createdAt: string; url: string; jobs: GhJob[] }
interface GitHubSide { repo: string; private: boolean | null; runners: { name: string; status: string; busy: boolean; labels: string[] }[]; route: { variable: string; value: string | null; isolatedVariable: string; isolated: string | null; sandbox: boolean }; runs: GhRun[] }
interface Line { n: number; ts: string; text: string }

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${API}/api/runners${path}`, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `The core said ${r.status}`);
  return j as T;
}

const STATE: Record<State, { label: string; tone: "good" | "work" | "warn" | "off" }> = {
  "not-set-up": { label: "Not set up", tone: "warn" },
  "setting-up": { label: "Setting up", tone: "work" },
  off: { label: "Off", tone: "off" },
  starting: { label: "Starting", tone: "work" },
  idle: { label: "Ready, waiting for a job", tone: "good" },
  busy: { label: "Running a job", tone: "work" },
  waiting: { label: "Stopped by itself, starting again", tone: "warn" },
  stopping: { label: "Stopping", tone: "off" },
};
const took = (a: string | null, b: string | null) => {
  if (!a) return "";
  const s = Math.max(0, Math.round(((b ? Date.parse(b) : Date.now()) - Date.parse(a)) / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
};

/**
 * Build runners: GitHub's checks and builds for a repository, run on this PC instead of on
 * GitHub's machines. One page shows every runner this app keeps, what it is doing, the jobs
 * waiting and done (and which machine ran each one), and its live log. Everything is a button:
 * add, start, stop, restart, send builds here or back, remove.
 */
export function RunnersPage() {
  const [rep, setRep] = useState<Report | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const refresh = () => call<Report>("GET", "").then((r) => { setRep(r); setErr((e) => (e?.startsWith("The core") ? null : e)); }).catch((e) => setErr((e as Error).message));
  useEffect(() => { refresh(); const t = setInterval(refresh, 2000); return () => clearInterval(t); }, []);
  const runners = rep?.runners ?? [];
  const cur = runners.find((r) => r.id === sel) ?? runners[0] ?? null;
  const act = async (f: () => Promise<unknown>) => { setErr(null); try { await f(); await refresh(); } catch (e) { setErr((e as Error).message); } };

  return (
    <section className="pane fleet runners" aria-label="Build runners">
      <header className="fleet-head">
        <div>
          <h1>Build runners</h1>
          <p className="muted">GitHub's checks and builds, run on this PC for free instead of on GitHub's machines. SoftwareFactory starts each runner, keeps it running, and stops it when the app closes.</p>
        </div>
        <button onClick={() => setAdding(true)}>Add a runner</button>
      </header>
      {err && <div className="err bases-err" role="alert">{err}</div>}
      {!rep ? <div className="empty">Reading the runners…</div>
        : !runners.length ? (
          <div className="fleet-empty">
            <p>No runner on this PC yet.</p>
            <p className="muted">Add one for a repository. SoftwareFactory downloads GitHub's runner program, registers it with your GitHub sign-in on this PC, and starts it. Nothing to copy or paste.</p>
            <button onClick={() => setAdding(true)}>Add a runner</button>
          </div>
        ) : (
          <div className="rn-body">
            <div className="rn-list" role="list">
              {runners.map((r) => (
                <button key={r.id} role="listitem" className={`rn-row${cur?.id === r.id ? " on" : ""}`} onClick={() => setSel(r.id)} aria-current={cur?.id === r.id}>
                  <span className={`rn-dot ${STATE[r.state].tone}`} aria-hidden />
                  <span className="rn-row-main"><b>{r.name}</b><span className="muted">{r.repo}</span></span>
                  <span className="rn-row-state">{r.state === "busy" && r.job ? `Running: ${r.job}` : STATE[r.state].label}</span>
                </button>
              ))}
            </div>
            {cur && <RunnerDetail key={cur.id} r={cur} jobs={(rep.jobs ?? []).filter((j) => j.runner === cur.name && j.repo === cur.repo)} act={act} pc={rep.pc} onRemoved={() => setSel(null)} />}
          </div>
        )}
      {adding && <AddRunner onClose={() => setAdding(false)} onAdded={(id) => { setAdding(false); setSel(id); refresh(); }} />}
    </section>
  );
}

function RunnerDetail({ r, jobs, act, pc, onRemoved }: { r: RunnerView; jobs: LocalJob[]; pc?: PcLoad; act: (f: () => Promise<unknown>) => Promise<void>; onRemoved: () => void }) {
  const [tab, setTab] = useState<"jobs" | "log">("jobs");
  const [confirm, setConfirm] = useState<"stop" | "remove" | null>(null);
  const [removed, setRemoved] = useState<string | null>(null);
  const [gh, setGh] = useState<GitHubSide | null>(null);
  const [ghErr, setGhErr] = useState<string | null>(null);
  const [routeNote, setRouteNote] = useState<string | null>(null);
  const loadGh = () => call<GitHubSide>("GET", `/github?repo=${encodeURIComponent(r.repo)}`).then((g) => { setGh(g); setGhErr(null); }).catch((e) => setGhErr((e as Error).message));
  // GitHub's side changes slower than the runner itself, and each look costs API calls: every 20 s, and when the runner's state changes.
  // While a job runs here GitHub is asked often, so the steps move as the job moves.
  const working = r.state === "busy";
  useEffect(() => { loadGh(); const t = setInterval(loadGh, working ? 8000 : 20_000); return () => clearInterval(t); }, [r.repo, r.state, r.job]); // eslint-disable-line react-hooks/exhaustive-deps
  const live = r.state === "idle" || r.state === "busy" || r.state === "starting";
  const here = !!gh?.route.value;
  const st = STATE[r.state];
  const onGitHub = gh?.runners.find((x) => x.name === r.name);
  const stop = () => (r.state === "busy" ? setConfirm("stop") : act(() => call("POST", `/${r.id}/stop`)));

  return (
    <div className="rn-detail">
      <div className="rn-head">
        <div>
          <h2>{r.name} <span className={`rn-state ${st.tone}`}><span className={`rn-dot ${st.tone}`} aria-hidden /> {r.state === "busy" && r.job ? `Running a job: ${r.job}` : st.label}{r.state === "waiting" && r.retryInSecs != null ? ` in ${r.retryInSecs} s` : ""}</span></h2>
          <p className="muted">For <b>{r.repo}</b>{gh?.private != null ? ` (${gh.private ? "private" : "public"})` : ""} · folder <code>{r.dir}</code>{r.version ? ` · runner program ${r.version}` : ""}{r.runningSince ? ` · up since ${ago(r.runningSince)}` : ""}{r.restarts ? ` · started again ${r.restarts} time${r.restarts > 1 ? "s" : ""}` : ""}</p>
          {r.note && <p className={r.state === "setting-up" ? "rn-note" : "rn-note warn"}>{r.note}</p>}
        </div>
        <div className="rn-actions">
          {r.state === "not-set-up" && <button onClick={() => act(() => call("POST", `/${r.id}/setup`))}>Set up</button>}
          {r.registered && !live && r.state !== "setting-up" && <button onClick={() => act(() => call("POST", `/${r.id}/start`))}>Start</button>}
          {(live || r.state === "waiting") && <button className="ghost" onClick={stop}>Stop</button>}
          {live && <button className="ghost" onClick={() => (r.state === "busy" ? setConfirm("stop") : act(() => call("POST", `/${r.id}/restart`)))}>Restart</button>}
          <button className="ghost" disabled={r.state === "setting-up"} onClick={() => setConfirm("remove")}>Remove</button>
        </div>
      </div>

      {confirm === "stop" && (
        <div className="rn-confirm" role="alertdialog" aria-label="Stop while a job runs">
          <span>A job is running on it ({r.job}). Stopping now cuts the job off, and GitHub shows it as failed.</span>
          <button onClick={() => { setConfirm(null); act(() => call("POST", `/${r.id}/stop`)); }}>Stop anyway</button>
          <button className="ghost" onClick={() => setConfirm(null)}>Keep it running</button>
        </div>
      )}
      {confirm === "remove" && (
        <div className="rn-confirm" role="alertdialog" aria-label="Remove this runner">
          <span>Remove {r.name}? It is stopped and taken off {r.repo} on GitHub. Its folder {r.dir} stays on disk.{here ? " Builds are sent to this PC right now: send them back to GitHub's machines first, or they will wait with no runner." : ""}</span>
          <button onClick={() => { setConfirm(null); act(async () => { const x = await call<{ note: string | null; dir: string }>("POST", `/${r.id}/remove`); setRemoved(x.note); onRemoved(); }); }}>Remove</button>
          <button className="ghost" onClick={() => setConfirm(null)}>Cancel</button>
        </div>
      )}
      {removed && <p className="rn-note warn">{removed}</p>}

      <Now r={r} gh={gh} pc={pc} />
      <div className="rn-route">
        <div>
          <b>Where {r.repo}'s builds run</b>
          {ghErr ? <p className="rn-note warn">{ghErr}</p>
            : !gh ? <p className="muted">Asking GitHub…</p>
            : <p className="muted">{here
              ? <>On <b>this PC</b>. Workflows that read the repository variable <code>{gh.route.variable}</code> land on this runner. {onGitHub ? `GitHub sees it ${onGitHub.status}${onGitHub.busy ? ", busy" : ""}.` : "GitHub does not list this runner yet."}{!live && " The runner is off, so builds wait until you start it."}{" "}{gh.route.isolated ? "The smoke test runs here too, inside a Windows Sandbox that opens on your desktop and closes by itself." : gh.route.sandbox ? "The smoke test still runs on GitHub's machines." : "The smoke test stays on GitHub's machines, because Windows Sandbox is not turned on on this PC."}</>
              : <>On <b>GitHub's machines</b>. Send them here and workflows that read the repository variable <code>{gh.route.variable}</code> run on this PC instead.</>}</p>}
        </div>
        {gh && (here
          ? <span className="rn-actions">{!gh.route.isolated && gh.route.sandbox && <button onClick={() => act(async () => { const x = await call<{ route: { note?: string | null } }>("POST", `/${r.id}/route`, { on: true }); setRouteNote(x.route.note ?? null); await loadGh(); })}>Send the smoke test here too</button>}<button className="ghost" onClick={() => act(async () => { await call("POST", `/${r.id}/route`, { on: false }); setRouteNote(null); await loadGh(); })}>Send builds back to GitHub</button></span>
          : <button disabled={!r.registered} title={r.registered ? "" : "Set the runner up first"} onClick={() => act(async () => { const x = await call<{ route: { note?: string | null } }>("POST", `/${r.id}/route`, { on: true }); setRouteNote(x.route.note ?? null); await loadGh(); })}>Send builds to this PC</button>)}
      </div>

      {routeNote && <p className="rn-note">{routeNote}</p>}

      <div className="seg rn-tabs" role="tablist">
        <button role="tab" aria-selected={tab === "jobs"} className={tab === "jobs" ? "on" : ""} onClick={() => setTab("jobs")}>Jobs</button>
        <button role="tab" aria-selected={tab === "log"} className={tab === "log" ? "on" : ""} onClick={() => setTab("log")}>Live log</button>
      </div>
      {tab === "jobs" ? <Jobs gh={gh} local={jobs} ghErr={ghErr} /> : <LogView id={r.id} file={r.log} />}
    </div>
  );
}

/** What a step is called for a person: "Run npm test" is "npm test", an action is its short name. */
function stepName(n: string): string {
  const x = n.replace(/^Run /, "").replace(/^npx tauri build\b.*$/, "Build the app (the long Rust compile)");
  const known: Record<string, string> = { checkout: "Get the code", "setup-node": "Set up Node", "rust-toolchain": "Set up Rust", "rust-cache": "Bring back the Rust cache", "upload-artifact": "Upload the result", "download-artifact": "Fetch the build" };
  const a = x.match(/^(Post )?[\w.-]+\/([\w.-]+)@\S+$/);
  return a ? `${a[1] ? "Clean up after " : ""}${known[a[2]] ?? a[2]}` : x.replace(/^Post Run [\w.-]+\/([\w.-]+)@\S+$/, "Clean up after $1");
}

/**
 * The job this runner is working on right now, step by step: which step runs, for how long,
 * what is done and what is still to come. Nothing to guess.
 */
function Now({ r, gh, pc }: { r: RunnerView; gh: GitHubSide | null; pc?: PcLoad }) {
  const [, tick] = useState(0);
  const [open, setOpen] = useState(true);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, []);
  const found = (gh?.runs ?? []).flatMap((x) => x.jobs.filter((j) => j.status === "in_progress" && j.runner === r.name).map((j) => ({ run: x, job: j })))[0];
  if (!found) {
    if (r.state !== "busy") return null;
    return <div className="rn-now"><div className="rn-now-top"><span className="rn-dot work" aria-hidden /><b>Working on {r.job ?? "a job"}</b><span className="muted">Asking GitHub for its steps…</span></div></div>;
  }
  const { run, job } = found;
  const steps = (job.steps ?? []).filter((s) => !/^Post /.test(s.name) && s.name !== "Complete job");
  const done = steps.filter((s) => s.status === "completed").length;
  const cur = steps.find((s) => s.status === "in_progress");
  const failed = steps.find((s) => s.conclusion === "failure");
  const pct = steps.length ? Math.round(((done + (cur ? 0.5 : 0)) / steps.length) * 100) : 0;
  return (
    <div className="rn-now">
      <div className="rn-now-top">
        <span className="rn-dot work" aria-hidden />
        <b>Running now: {job.name}</b>
        <span className="muted">{run.title || run.name}{run.branch ? ` on ${run.branch}` : ""} · on this PC for {took(job.startedAt ?? run.createdAt, null)}</span>
        <span className="rn-now-end">
          {job.url && <a href={job.url} target="_blank" rel="noreferrer">Open on GitHub</a>}
          <button className="ghost" onClick={() => setOpen(!open)}>{open ? "Hide steps" : "Show steps"}</button>
        </span>
      </div>
      <div className="rn-prog" role="progressbar" aria-valuemin={0} aria-valuemax={steps.length} aria-valuenow={done}><div className="rn-prog-fill" style={{ width: `${pct}%` }} /></div>
      <p className="rn-now-line">
        {steps.length ? <>Step <b>{Math.min(done + 1, steps.length)}</b> of <b>{steps.length}</b>{cur ? <>: <b>{stepName(cur.name)}</b>, for {took(cur.startedAt ?? job.startedAt ?? run.createdAt, null)}</> : done === steps.length ? ": finishing up" : ": starting the next step"}</> : "GitHub has not listed the steps yet."}
        {failed && <span className="rn-bad"> A step failed: {stepName(failed.name)}.</span>}
      </p>
      {pc && pc.cpuBusy != null && (
        <p className={`rn-pc${pc.cpuBusy >= 90 ? " hot" : ""}`}>
          This PC: processor {pc.cpuBusy}% busy ({pc.cores} cores), {pc.memFreeGb} of {pc.memTotalGb} GB memory free.
          {pc.cpuBusy >= 90 && " The processor is full. That is normal while a build compiles, but if other heavy programs run at the same time they share it and the build takes longer."}
        </p>
      )}
      {open && steps.length > 0 && (
        <ol className="rn-steps">
          {steps.map((s) => (
            <li key={s.number} className={s.status === "in_progress" ? "cur" : s.status === "completed" ? (s.conclusion === "failure" ? "bad" : s.conclusion === "skipped" ? "skip" : "done") : "todo"}>
              <span className="rn-step-mark" aria-hidden>{s.status === "in_progress" ? "▶" : s.status === "completed" ? (s.conclusion === "failure" ? "✕" : s.conclusion === "skipped" ? "–" : "✓") : "○"}</span>
              <span className="rn-step-name">{stepName(s.name)}</span>
              <span className="muted">{s.status === "in_progress" ? `running, ${took(s.startedAt ?? job.startedAt ?? run.createdAt, null)}` : s.status === "completed" ? (s.conclusion === "skipped" ? "skipped" : s.conclusion === "failure" ? `failed after ${took(s.startedAt ?? "", s.endedAt)}` : took(s.startedAt ?? "", s.endedAt)) : "to come"}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function Jobs({ gh, local, ghErr }: { gh: GitHubSide | null; local: LocalJob[]; ghErr: string | null }) {
  const asking = ghErr ? "GitHub could not be asked (the reason is above)." : "Asking GitHub…";
  const queued = gh?.runs.filter((x) => x.status !== "completed") ?? [];
  const done = gh?.runs.filter((x) => x.status === "completed") ?? [];
  const row = (x: GhRun) => (
    <div className="rn-run" key={x.id}>
      <div className="rn-run-top">
        <span className={`rn-dot ${x.status !== "completed" ? "work" : x.conclusion === "success" ? "good" : x.conclusion === "cancelled" ? "off" : "warn"}`} aria-hidden />
        <b>{x.title || x.name}</b>
        <span className="muted">{x.name} · {x.event}{x.branch ? ` on ${x.branch}` : ""} · {ago(x.createdAt)} · {x.status === "completed" ? x.conclusion : x.status.replace("_", " ")}</span>
      </div>
      <div className="rn-jobs">
        {x.jobs.map((j) => (
          <span key={j.name} className="rn-job" title={j.runner ?? "no machine yet"}>
            <span className={`rn-dot ${j.status !== "completed" ? "work" : j.conclusion === "success" ? "good" : j.conclusion === "skipped" || j.conclusion === "cancelled" ? "off" : "warn"}`} aria-hidden />
            {j.name}
            <span className={`rn-where${j.here ? " here" : ""}`}>{j.here == null ? (j.status === "queued" ? "waiting for a machine" : j.conclusion ?? j.status) : j.here ? "this PC" : "GitHub's machine"}</span>
            {j.startedAt && j.status === "completed" && j.conclusion !== "skipped" && <span className="muted">{took(j.startedAt, j.endedAt)}</span>}
          </span>
        ))}
        {!x.jobs.length && <span className="muted">No jobs yet.</span>}
      </div>
    </div>
  );
  return (
    <div className="rn-pane">
      <h3>Waiting and running <span className="muted">{queued.length}</span></h3>
      {queued.length ? queued.map(row) : <p className="muted">{gh ? "Nothing is waiting or running." : asking}</p>}
      <h3>Latest runs on GitHub</h3>
      {done.length ? done.map(row) : <p className="muted">{gh ? "No finished runs yet." : asking}</p>}
      <h3>Jobs this runner took <span className="muted">{local.length}</span></h3>
      {local.length ? (
        <table className="pj-table rn-table"><thead><tr><th>Job</th><th>Started</th><th>Took</th><th>Result</th></tr></thead>
          <tbody>{local.slice(0, 30).map((j, i) => (
            <tr key={i}><td>{j.name}</td><td>{ago(j.startedAt)}</td><td>{took(j.startedAt, j.endedAt)}</td><td className={j.result === "Succeeded" ? "rn-ok" : j.result ? "rn-bad" : ""}>{j.result ?? "running"}</td></tr>
          ))}</tbody></table>
      ) : <p className="muted">It has not taken a job yet.</p>}
    </div>
  );
}

function LogView({ id, file }: { id: string; file: string }) {
  const [lines, setLines] = useState<Line[]>([]);
  const last = useRef(0);
  const box = useRef<HTMLPreElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    let off = false;
    last.current = 0; setLines([]);
    const pull = () => call<{ lines: Line[] }>("GET", `/${id}/log?after=${last.current}`).then((x) => {
      if (off || !x.lines.length) return;
      last.current = x.lines[x.lines.length - 1].n;
      setLines((old) => [...old, ...x.lines].slice(-2000));
    }).catch(() => { /* the page says when the core is away */ });
    pull();
    const t = setInterval(pull, 1500);
    return () => { off = true; clearInterval(t); };
  }, [id]);
  useEffect(() => { const b = box.current; if (b && stick.current) b.scrollTop = b.scrollHeight; }, [lines]);
  return (
    <div className="rn-pane">
      <pre ref={box} className="rn-log" tabIndex={0} aria-label="What the runner printed"
        onScroll={(e) => { const b = e.currentTarget; stick.current = b.scrollHeight - b.scrollTop - b.clientHeight < 40; }}>
        {lines.length ? lines.map((l) => `${l.ts.slice(11, 19)}  ${l.text}`).join("\n") : "Nothing printed since the app started. Older lines are in the file below."}
      </pre>
      <p className="muted">The whole log is kept in <code>{file}</code>. A job's own steps are on GitHub, under the run.</p>
    </div>
  );
}

function AddRunner({ onClose, onAdded }: { onClose: () => void; onAdded: (id: string) => void }) {
  const [repo, setRepo] = useState("PlonterAsi/SoftwareFactory");
  const [name, setName] = useState("");
  const [dir, setDir] = useState("");
  const [labels, setLabels] = useState("");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // The name, labels and folder follow the repository until you change one of them.
  useEffect(() => {
    if (touched) return;
    const t = setTimeout(() => call<{ dir: string; name: string; labels: string[] }>("GET", `/suggest?repo=${encodeURIComponent(repo)}`).then((s) => { setName(s.name); setDir(s.dir); setLabels(s.labels.join(", ")); }).catch(() => {}), 200);
    return () => clearTimeout(t);
  }, [repo, touched]);
  const edit = (set: (v: string) => void) => (e: { target: { value: string } }) => { setTouched(true); set(e.target.value); };
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try {
      const r = await call<{ runner: RunnerView }>("POST", "", { repo: repo.trim(), name: name.trim(), dir: dir.trim(), labels: labels.split(",").map((s) => s.trim()).filter(Boolean) });
      onAdded(r.runner.id);
    } catch (x) { setErr((x as Error).message); setBusy(false); }
  };
  return (
    <div className="scrim solid" onClick={onClose}>
      <form className="picker base-new" role="dialog" aria-modal="true" aria-label="Add a runner" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="setup-kicker mono">NEW RUNNER</div>
        <h2>Add a runner</h2>
        <p className="muted">SoftwareFactory downloads GitHub's runner program into the folder, checks it against GitHub's checksum, registers it on the repository with your GitHub sign-in on this PC, and starts it.</p>
        <label className="base-field"><span>Repository</span><input autoFocus value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="owner/name" /></label>
        <label className="base-field"><span>Runner name on GitHub</span><input value={name} onChange={edit(setName)} /></label>
        <label className="base-field"><span>Labels</span><input value={labels} onChange={edit(setLabels)} /><span className="muted base-hint">Workflows ask for a runner by these. GitHub adds self-hosted and the system by itself.</span></label>
        <label className="base-field"><span>Folder on this PC</span><input value={dir} onChange={edit(setDir)} /><span className="muted base-hint">A short path with no spaces. Builds are kept inside it.</span></label>
        {err && <div className="err" role="alert">{err}</div>}
        <div className="base-new-actions">
          <button type="button" className="ghost" onClick={onClose}>Cancel</button>
          <button type="submit" disabled={busy || !repo.trim()}>{busy ? "Adding…" : "Add and set up"}</button>
        </div>
      </form>
    </div>
  );
}

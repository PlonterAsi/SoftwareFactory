import { useEffect, useState, type FormEvent } from "react";
import { scoutApi, type AutoFileRuleView, type ScoutCountsView, type ScoutFindView, type ScoutLookView, type ScoutSettingsView, type ScoutSourceView, type ScoutVerdictView, type ScoutWeekView } from "../api";
import { showTicket } from "../BugReport";
import { registerProjectPanel, type PanelContext } from "./panels";

const CATS: [string, string][] = [["skill", "Skill"], ["plugin", "Plugin"], ["mcp", "MCP server"], ["mod", "Mod"], ["agent", "Agent"], ["prompt", "Prompt"], ["tip", "Tip"], ["tool", "Tool"], ["page", "Page to follow"], ["person", "Person to follow"]];
const CAT = Object.fromEntries(CATS);
const VERDICT: Record<ScoutVerdictView, string> = { use: "Use", adapt: "Adapt", build: "Build our own", skip: "Skip" };
const SCORES: [string, string][] = [["tokens", "Tokens"], ["practice", "Practice"], ["productivity", "Productivity"], ["security", "Security"], ["upkeep", "Upkeep"]];
const TRIAL: Record<string, string> = { none: "", queued: "Queued for the sandbox", "needs-approval": "Waits for your click", running: "In the sandbox now", passed: "Tried: worked", failed: "Tried: did not work", declined: "Not tried (declined)" };
const KIND_WORD: Record<ScoutSourceView["kind"], string> = { github: "GitHub search", hn: "Hacker News", reddit: "Reddit", feed: "Feed", awesome: "Awesome list" };
const when = (iso?: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "–");
const usd = (n: number) => `$${n.toFixed(2)}`;

type Tab = "catalog" | "week" | "follow" | "settings" | "rules";

/**
 * Scout (core: scout/): a daily look for AI engineering worth knowing. Gathering is free; the Analyst and the
 * sandbox trials are paid and held by this project's monthly budget. High-risk trials wait for your click here.
 */
function ScoutPanel({ project }: PanelContext) {
  const [st, setSt] = useState<Awaited<ReturnType<typeof scoutApi.state>> | null>(null);
  const [tab, setTab] = useState<Tab>("catalog");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [look, setLook] = useState<ScoutLookView | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => { scoutApi.state(project.id).then(setSt).catch((e) => setErr(String(e.message ?? e))); }, [project.id, tick]);
  const refresh = () => setTick((t) => t + 1);
  const act = async (k: string, fn: () => Promise<unknown>) => { setBusy(k); setErr(null); try { await fn(); refresh(); } catch (e) { setErr((e as Error).message); } finally { setBusy(null); } };

  if (!st) return err ? <div className="err">{err}</div> : <div className="muted pad">Reading Scout…</div>;
  if (!st.settings) {
    return (
      <div className="scout pad">
        <h3>Scout</h3>
        <p>Every day Scout looks for AI engineering worth knowing: skills, plugins, MCP servers, mods, agents, prompts, tips, and the pages and people worth following. It rates each find, tries the best in a throwaway sandbox, and says use, adapt, build our own or skip.</p>
        <p className="muted small">Gathering is free. Reading and rating finds, and the sandbox trials, are paid and charged to this project, so set this project's monthly budget on its Money tab. Nothing is ever installed on this computer's own setup.</p>
        {err && <div className="err" role="alert">{err}</div>}
        <button type="button" disabled={!!busy} onClick={() => act("on", () => scoutApi.configure(project.id, { on: true }))}>Turn Scout on for this project</button>
      </div>
    );
  }
  const c = st.counts!;
  const last = look ?? st.last;
  return (
    <div className="scout">
      <header className="scout-head">
        <div>
          <b>{st.on ? "Scout looks every " + (st.settings.everyHours === 24 ? "day" : `${st.settings.everyHours} hours`) : "Scout is off"}</b>
          <span className="muted small"> · {c.total} finds, {c.rated} rated{c.waiting ? `, ${c.waiting} not read yet` : ""}{c.needsClick ? "" : ""}</span>
          {last && <p className="small">Last look {when(last.ts)}: {last.error ? `stopped: ${last.error}` : `${last.fresh} new, ${last.analyzed} rated, ${last.filed.length} filed, ${usd(last.costUsd)}`}{last.notes.length ? <span className="muted"> · {last.notes.slice(0, 3).join(" · ")}</span> : null}</p>}
          {!st.sandbox.ok && <p className="small warn">Sandbox: {st.sandbox.why}</p>}
        </div>
        <div className="scout-head-actions">
          {c.needsClick > 0 && <button type="button" className="tiny" onClick={() => { setTab("catalog"); }}>{c.needsClick} wait for your click</button>}
          <button type="button" disabled={!!busy} onClick={() => act("look", async () => { const r = await scoutApi.look(project.id); setLook(r.look); })}>{busy === "look" ? "Looking…" : "Look now"}</button>
        </div>
      </header>
      {err && <div className="err" role="alert">{err}</div>}
      <Inbox projectId={project.id} onAdded={refresh} />
      <nav className="scout-tabs" role="tablist">
        {(["catalog", "week", "follow", "settings", "rules"] as Tab[]).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className={`tiny ${tab === t ? "" : "ghost"}`} onClick={() => setTab(t)}>
            {{ catalog: "Catalog", week: "This week", follow: `Follow (${st.settings!.follow.length})`, settings: "Settings", rules: "Auto-file rules" }[t]}
          </button>
        ))}
      </nav>
      {tab === "catalog" && <Catalog projectId={project.id} counts={c} tick={tick} onChange={refresh} />}
      {tab === "week" && <Week projectId={project.id} />}
      {tab === "follow" && <FollowList projectId={project.id} settings={st.settings} onChange={refresh} />}
      {tab === "settings" && <Settings projectId={project.id} settings={st.settings} onChange={refresh} />}
      {tab === "rules" && <Rules />}
    </div>
  );
}

function Inbox({ projectId, onAdded }: { projectId: number; onAdded: () => void }) {
  const [url, setUrl] = useState("");
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const add = async (e: FormEvent) => {
    e.preventDefault(); setMsg(null);
    try { const r = await scoutApi.inbox(projectId, url.trim(), note.trim()); setMsg(r.find.status === "rated" ? "Already in the catalog." : "Added: it is read first on the next look."); setUrl(""); setNote(""); onAdded(); } catch (x) { setMsg((x as Error).message); }
  };
  return (
    <form className="scout-inbox" onSubmit={add} aria-label="Link inbox">
      <input type="url" required placeholder="Drop any link: Instagram, Facebook, X, YouTube, a repo, a post…" value={url} onChange={(e) => setUrl(e.target.value)} aria-label="Link" />
      <input placeholder="What caught your eye (optional)" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Note" />
      <button type="submit" className="tiny">Add to the inbox</button>
      {msg && <span className="small" role="status">{msg}</span>}
    </form>
  );
}

function Catalog({ projectId, counts, tick, onChange }: { projectId: number; counts: ScoutCountsView; tick: number; onChange: () => void }) {
  const [f, setF] = useState<Record<string, string>>({});
  const [finds, setFinds] = useState<ScoutFindView[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  useEffect(() => { scoutApi.finds(projectId, Object.fromEntries(Object.entries(f).filter(([, v]) => v))).then((j) => setFinds(j.finds)).catch((e) => setErr(String(e.message ?? e))); }, [projectId, f, tick]);
  const set = (k: string, v: string) => setF((x) => ({ ...x, [k]: v }));
  const act = async (fn: () => Promise<unknown>) => { setErr(null); try { await fn(); onChange(); } catch (e) { setErr((e as Error).message); } };
  return (
    <div className="scout-catalog">
      <div className="scout-filters">
        <select aria-label="Category" value={f.category ?? ""} onChange={(e) => set("category", e.target.value)}>
          <option value="">Every category</option>
          {CATS.map(([k, w]) => <option key={k} value={k}>{w}{counts.byCategory[k] ? ` (${counts.byCategory[k]})` : ""}</option>)}
        </select>
        <select aria-label="Verdict" value={f.verdict ?? ""} onChange={(e) => set("verdict", e.target.value)}>
          <option value="">Every verdict</option>
          {(Object.keys(VERDICT) as ScoutVerdictView[]).map((v) => <option key={v} value={v}>{VERDICT[v]}{counts.byVerdict[v] ? ` (${counts.byVerdict[v]})` : ""}</option>)}
        </select>
        <select aria-label="Trial" value={f.trial ?? ""} onChange={(e) => set("trial", e.target.value)}>
          <option value="">Any trial</option>
          {Object.entries(TRIAL).filter(([k]) => k !== "none").map(([k, w]) => <option key={k} value={k}>{w}</option>)}
        </select>
        <select aria-label="Read" value={f.status ?? ""} onChange={(e) => set("status", e.target.value)}>
          <option value="">Rated and not read</option><option value="rated">Rated</option><option value="new">Not read yet</option>
        </select>
        <input type="search" placeholder="Search" value={f.q ?? ""} onChange={(e) => set("q", e.target.value)} aria-label="Search the catalog" />
      </div>
      {err && <div className="err" role="alert">{err}</div>}
      {!finds ? <p className="muted">Reading the catalog…</p> : !finds.length ? <p className="muted">Nothing here yet. Press Look now, or drop a link in the inbox.</p> : (
        <ul className="scout-list">
          {finds.map((x) => (
            <li key={x.id} className={`scout-find verdict-${x.verdict ?? "none"}${x.trial === "needs-approval" ? " needs" : ""}`}>
              <div className="sf-top">
                <a href={x.url} target="_blank" rel="noreferrer" className="sf-title">{x.title}</a>
                <span className="sf-chips">
                  {x.category && <span className="chip">{CAT[x.category] ?? x.category}</span>}
                  {x.verdict && <span className={`chip v-${x.verdict}`} title={x.verdictBy && x.verdictBy !== "scout" ? `Set by ${x.verdictBy}` : "Scout's verdict"}>{VERDICT[x.verdict]}{x.verdictBy && x.verdictBy !== "scout" ? ` (${x.verdictBy})` : ""}</span>}
                  {x.score != null && <span className="chip">{x.score.toFixed(1)}/5</span>}
                  {x.risk && <span className={`chip risk-${x.risk}`}>{x.risk === "read-only" ? "read only" : `${x.risk} risk`}</span>}
                </span>
              </div>
              <p className="small muted">{x.sourceWord}{x.meta.from ? ` · ${x.meta.from}` : ""}{x.meta.stars != null ? ` · ${x.meta.stars}★` : ""}{x.meta.points != null ? ` · ${x.meta.points} points` : ""} · found {when(x.ts)}</p>
              {x.summary ? <p>{x.summary}</p> : x.status === "new" && <p className="muted small">Not read yet: the next look reads it{x.source === "inbox" ? " first" : ""}.</p>}
              {x.status === "rated" && (
                <div className="sf-scores" aria-label="Scores">
                  {SCORES.map(([k, w]) => x.scores[k] ? <span key={k} className="sf-score" title={x.scores[k].why}><span className="muted">{w}</span> <i style={{ width: `${x.scores[k].n * 20}%` }} /> {x.scores[k].n}</span> : null)}
                </div>
              )}
              {open === x.id && (
                <div className="sf-more small">
                  {x.where && <p><b>Where it helps:</b> {x.where}</p>}
                  {x.how && <p><b>How:</b> {x.how}</p>}
                  {SCORES.map(([k, w]) => x.scores[k] ? <p key={k}><b>{w} {x.scores[k].n}/5:</b> {x.scores[k].why}</p> : null)}
                  {(x.minutes != null || x.usd != null) && <p><b>To adopt:</b> about {x.minutes != null ? `${Math.round(x.minutes)} minutes` : "?"}{x.usd != null ? `, ${usd(x.usd)}` : ""}</p>}
                  {x.verdictNote && <p><b>Note:</b> {x.verdictNote}</p>}
                  {x.costUsd > 0 && <p className="muted">Scout spent {usd(x.costUsd)} on this find.</p>}
                </div>
              )}
              {x.trial !== "none" && <p className={`small ${x.trial === "needs-approval" ? "warn" : ""}`}><b>{TRIAL[x.trial] ?? x.trial}</b>{x.trialNote ? `: ${x.trialNote}` : ""}</p>}
              <div className="sf-actions">
                {x.status === "rated" && <button type="button" className="tiny ghost" onClick={() => setOpen(open === x.id ? null : x.id)}>{open === x.id ? "Less" : "Why"}</button>}
                {x.ticketId ? <button type="button" className="tiny ghost" onClick={() => showTicket(x.ticketId!, null)}>Ticket #{x.ticketId}</button>
                  : x.status === "rated" && x.verdict !== "skip" && <button type="button" className="tiny" onClick={() => act(() => scoutApi.act(x.id, "file"))}>File as ticket</button>}
                {x.trial === "needs-approval" && <>
                  <button type="button" className="tiny" onClick={() => act(() => scoutApi.act(x.id, "approve"))}>Approve the sandbox trial</button>
                  <button type="button" className="tiny ghost" onClick={() => act(() => scoutApi.act(x.id, "decline"))}>Decline</button>
                </>}
                {x.trial === "queued" && <button type="button" className="tiny ghost" onClick={() => act(() => scoutApi.act(x.id, "run"))}>Try it now</button>}
                {x.status === "rated" && ["none", "declined", "failed"].includes(x.trial) && x.risk !== "read-only" && <button type="button" className="tiny ghost" onClick={() => act(() => scoutApi.act(x.id, "try"))}>Try in the sandbox</button>}
                {(x.follow || x.category === "page" || x.category === "person") && <button type="button" className="tiny ghost" onClick={() => act(() => scoutApi.follow(projectId, x.url, x.title.split(":")[0]))}>Follow</button>}
                {x.status === "rated" && (
                  <select aria-label="Your verdict" className="tiny" value="" onChange={(e) => e.target.value && act(() => scoutApi.judge(x.id, e.target.value as ScoutVerdictView))}>
                    <option value="">Your verdict…</option>
                    {(Object.keys(VERDICT) as ScoutVerdictView[]).map((v) => <option key={v} value={v}>{VERDICT[v]}</option>)}
                  </select>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Week({ projectId }: { projectId: number }) {
  const [w, setW] = useState<ScoutWeekView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { scoutApi.week(projectId).then(setW).catch((e) => setErr(String(e.message ?? e))); }, [projectId]);
  if (!w) return err ? <div className="err">{err}</div> : <p className="muted">Reading the week…</p>;
  return (
    <div className="scout-week">
      <p>Since {when(w.since)}: {w.looks} looks, {w.found} new finds, {w.analyzed} rated, {w.trials.length} tried in the sandbox, {w.filed.length} filed as tickets, {usd(w.costUsd)} on rating. Following {w.followed} pages and people.</p>
      <h4>Best of the week</h4>
      {!w.best.length ? <p className="muted">Nothing rated above skip this week yet.</p> : (
        <ol className="scout-best">{w.best.map((f) => <li key={f.id}><a href={f.url} target="_blank" rel="noreferrer">{f.title.split(":")[0]}</a> <span className="muted small">{f.verdict ? VERDICT[f.verdict] : ""} · {f.score?.toFixed(1)}/5 · {f.category ? CAT[f.category] : ""}</span>{f.where ? <div className="small">{f.where}</div> : null}</li>)}</ol>
      )}
      {w.trials.length > 0 && <><h4>Sandbox trials</h4><ul>{w.trials.map((f) => <li key={f.id}><b>{f.title.split(":")[0]}</b>: {TRIAL[f.trial]}. <span className="small">{f.trialNote}</span></li>)}</ul></>}
    </div>
  );
}

function FollowList({ projectId, settings, onChange }: { projectId: number; settings: ScoutSettingsView; onChange: () => void }) {
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const save = async (follow: ScoutSettingsView["follow"]) => { setErr(null); try { await scoutApi.configure(projectId, { follow }); onChange(); } catch (e) { setErr((e as Error).message); } };
  const readable = (u: string) => /youtube\.com\/(channel\/UC|feeds)|github\.com\/[^/]+\/?$|(feed|rss|atom)(\.xml)?\/?$|\.(rss|atom|xml)$/i.test(u);
  return (
    <div className="scout-follow">
      <p className="muted small">Pages and people worth following. A blog or newsletter feed, a YouTube channel (its /channel/UC… address) and a GitHub user are read on every look; the rest are kept here for you, and their posts come in through the link inbox.</p>
      {err && <div className="err" role="alert">{err}</div>}
      <ul>{settings.follow.map((f) => <li key={f.id}><a href={f.url} target="_blank" rel="noreferrer">{f.name}</a> <span className="muted small">{readable(f.url) ? "read on every look" : "kept for you"}</span> <button type="button" className="tiny ghost" onClick={() => save(settings.follow.filter((x) => x.id !== f.id))}>Remove</button></li>)}</ul>
      <form className="scout-inbox" onSubmit={(e) => { e.preventDefault(); void save([...settings.follow, { id: "", name, url }]).then(() => { setUrl(""); setName(""); }); }}>
        <input type="url" required placeholder="Address of a page, channel or person" value={url} onChange={(e) => setUrl(e.target.value)} aria-label="Address" />
        <input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} aria-label="Name" />
        <button type="submit" className="tiny">Follow</button>
      </form>
    </div>
  );
}

function Settings({ projectId, settings, onChange }: { projectId: number; settings: ScoutSettingsView; onChange: () => void }) {
  const [s, setS] = useState(settings);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [nk, setNk] = useState<ScoutSourceView["kind"]>("github");
  const [nv, setNv] = useState("");
  const save = async () => { setErr(null); setSaved(false); try { await scoutApi.configure(projectId, s); setSaved(true); onChange(); } catch (e) { setErr((e as Error).message); } };
  const num = (k: keyof ScoutSettingsView, v: string) => setS({ ...s, [k]: Number(v) });
  return (
    <div className="scout-settings">
      <label className="switch"><input type="checkbox" checked={s.on} onChange={(e) => setS({ ...s, on: e.target.checked })} /> Scout looks on its own</label>
      <div className="scout-grid">
        <label>Look every <select value={s.everyHours} onChange={(e) => num("everyHours", e.target.value)}><option value={12}>12 hours</option><option value={24}>day</option><option value={48}>2 days</option><option value={168}>week</option></select></label>
        <label>Most one look spends on rating, $ <input type="number" step="0.05" min="0" max="2" value={s.runUsd} onChange={(e) => num("runUsd", e.target.value)} /></label>
        <label>Finds rated per look <input type="number" min="0" max="40" value={s.perLook} onChange={(e) => num("perLook", e.target.value)} /></label>
        <label>Sandbox trials per week <input type="number" min="0" max="14" value={s.trialsPerWeek} onChange={(e) => num("trialsPerWeek", e.target.value)} /></label>
        <label>Tickets go to project # <input type="number" min="1" placeholder="this project" value={s.ticketsTo ?? ""} onChange={(e) => setS({ ...s, ticketsTo: e.target.value ? Number(e.target.value) : null })} /></label>
      </div>
      <label className="block">What finds are judged against<textarea rows={3} value={s.focus} onChange={(e) => setS({ ...s, focus: e.target.value })} /></label>
      <h4>Sources</h4>
      <ul className="scout-sources">
        {s.sources.map((x, i) => (
          <li key={x.id}>
            <label className="switch"><input type="checkbox" checked={x.on} onChange={(e) => setS({ ...s, sources: s.sources.map((y, j) => (j === i ? { ...y, on: e.target.checked } : y)) })} /> <span className="muted small">{KIND_WORD[x.kind]}</span> {x.label ?? x.value}</label>
            <button type="button" className="tiny ghost" onClick={() => setS({ ...s, sources: s.sources.filter((_, j) => j !== i) })}>Remove</button>
          </li>
        ))}
      </ul>
      <div className="scout-inbox">
        <select value={nk} onChange={(e) => setNk(e.target.value as ScoutSourceView["kind"])} aria-label="Kind of source">{Object.entries(KIND_WORD).map(([k, w]) => <option key={k} value={k}>{w}</option>)}</select>
        <input placeholder={{ github: "search words, e.g. topic:claude-code", hn: "search words", reddit: "subreddit, e.g. ClaudeAI", feed: "feed address (https://…)", awesome: "owner/repo" }[nk]} value={nv} onChange={(e) => setNv(e.target.value)} aria-label="Source" />
        <button type="button" className="tiny" disabled={!nv.trim()} onClick={() => { setS({ ...s, sources: [...s.sources, { id: "", kind: nk, value: nv.trim(), on: true }] }); setNv(""); }}>Add source</button>
      </div>
      {err && <div className="err" role="alert">{err}</div>}
      <button type="button" onClick={save}>Save settings</button> {saved && <span className="small" role="status">Saved.</span>}
    </div>
  );
}

const BLANK: AutoFileRuleView = { id: "", name: "", on: true, sources: ["scout"], projectId: null };

function Rules() {
  const [rules, setRules] = useState<AutoFileRuleView[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => { scoutApi.rules().then((j) => setRules(j.rules)).catch((e) => setErr(String(e.message ?? e))); }, []);
  if (!rules) return err ? <div className="err">{err}</div> : <p className="muted">Reading the rules…</p>;
  const up = (i: number, patch: Partial<AutoFileRuleView>) => { setSaved(false); setRules(rules.map((r, j) => (j === i ? { ...r, ...patch } : r))); };
  const n = (v: string) => (v === "" ? undefined : Number(v));
  const save = async () => { setErr(null); try { setRules((await scoutApi.saveRules(rules)).rules); setSaved(true); } catch (e) { setErr((e as Error).message); } };
  return (
    <div className="scout-rules">
      <p className="muted small">A suggestion that meets every condition of a rule that is on becomes a ticket by itself; everything else waits for your press. Leave a condition empty to ignore it. A condition the suggestion has no value for does not match (no estimate, no match). Rules are for every project.</p>
      {rules.map((r, i) => (
        <fieldset key={r.id || i} className="scout-rule">
          <legend><label className="switch"><input type="checkbox" checked={r.on} onChange={(e) => up(i, { on: e.target.checked })} /> <input value={r.name} placeholder="Name of the rule" onChange={(e) => up(i, { name: e.target.value })} aria-label="Rule name" /></label></legend>
          <div className="scout-grid">
            <label>Looks at <span><label><input type="checkbox" checked={r.sources.includes("scout")} onChange={(e) => up(i, { sources: e.target.checked ? [...new Set([...r.sources, "scout" as const])] : r.sources.filter((x) => x !== "scout") })} /> Scout finds</label> <label><input type="checkbox" checked={r.sources.includes("watcher")} onChange={(e) => up(i, { sources: e.target.checked ? [...new Set([...r.sources, "watcher" as const])] : r.sources.filter((x) => x !== "watcher") })} /> Watcher tickets</label></span></label>
            <label>Takes at most, minutes <input type="number" min="1" value={r.maxMinutes ?? ""} onChange={(e) => up(i, { maxMinutes: n(e.target.value) })} /></label>
            <label>Costs at most, $ <input type="number" min="0" step="0.5" value={r.maxUsd ?? ""} onChange={(e) => up(i, { maxUsd: n(e.target.value) })} /></label>
            <label>Severity at least <select value={r.minSeverity ?? ""} onChange={(e) => up(i, { minSeverity: (e.target.value || undefined) as AutoFileRuleView["minSeverity"] })}><option value="">any</option><option value="cosmetic">cosmetic</option><option value="annoying">annoying</option><option value="blocking">blocking</option></select></label>
            <label>Score at least <input type="number" min="1" max="5" step="0.1" value={r.minScore ?? ""} onChange={(e) => up(i, { minScore: n(e.target.value) })} /></label>
            <label>Risk at most <select value={r.maxRisk ?? ""} onChange={(e) => up(i, { maxRisk: (e.target.value || undefined) as AutoFileRuleView["maxRisk"] })}><option value="">any</option><option value="read-only">read only</option><option value="low">low</option><option value="medium">medium</option><option value="high">high</option></select></label>
            <label>Verdicts <span>{(Object.keys(VERDICT) as ScoutVerdictView[]).filter((v) => v !== "skip").map((v) => <label key={v}><input type="checkbox" checked={!!r.verdicts?.includes(v)} onChange={(e) => up(i, { verdicts: e.target.checked ? [...(r.verdicts ?? []), v] : (r.verdicts ?? []).filter((x) => x !== v) })} /> {VERDICT[v]}</label>)}</span></label>
            <label><input type="checkbox" checked={!!r.makeReady} onChange={(e) => up(i, { makeReady: e.target.checked })} /> Also make it ready for the crew</label>
          </div>
          <button type="button" className="tiny ghost" onClick={() => setRules(rules.filter((_, j) => j !== i))}>Remove rule</button>
        </fieldset>
      ))}
      {err && <div className="err" role="alert">{err}</div>}
      <button type="button" className="tiny ghost" onClick={() => setRules([...rules, { ...BLANK }])}>Add a rule</button> <button type="button" onClick={save}>Save rules</button> {saved && <span className="small" role="status">Saved.</span>}
    </div>
  );
}

/** The Scout card on Home: today's finds and what waits for your click, for every project with Scout on. */
export function ScoutCard() {
  const [all, setAll] = useState<Awaited<ReturnType<typeof scoutApi.all>>["projects"] | null>(null);
  useEffect(() => { scoutApi.all().then((j) => setAll(j.projects)).catch(() => setAll([])); }, []);
  if (!all?.length) return null;
  return (
    <section className="scout-card" aria-label="Scout today">
      {all.map((p) => (
        <a key={p.projectId} href={`#/p/${p.projectId}/scout`} className="scout-card-row">
          <b>{p.name}</b>{" "}
          <span>Scout found {p.foundToday}{p.worthToday ? `, ${p.worthToday} worth a look` : ""}{p.needsClick ? <span className="warn">, {p.needsClick} wait{p.needsClick === 1 ? "s" : ""} for your click</span> : ""}</span>
          <span className="muted small"> · {p.on ? (p.last?.ts ? `last look ${when(p.last.ts)}` : "first look soon") : "off"}</span>
        </a>
      ))}
    </section>
  );
}

registerProjectPanel({ id: "scout", section: "improve", title: "Scout", order: 45, render: (c) => <ScoutPanel key={c.project.id} {...c} /> });

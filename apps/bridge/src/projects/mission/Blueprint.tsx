import { useState } from "react";
import type { FactoryRunView, FeatureView, PlanView, ProductDocsView } from "../../api";
import { designRounds } from "./model";
import "./blueprint.css";

/**
 * The plan as a blueprint: what the app will be, the route the Builder takes through it, how people
 * will use it and what "done" means, all at reading size. The route is the build's real order (the
 * core works it out from the plan: model and shell, then the logic, then one screen at a time), so
 * the page shows what will actually happen, and each step lights up as the Builder reaches it.
 */
export type StepKind = "shell" | "logic" | "screen";
export interface RouteStep {
  id: string;
  kind: StepKind;
  title: string;
  /** One plain sentence: what the person gets from this step. */
  gets: string;
  shows: string[];
  can: string[];
  chips: string[];
  feature?: FeatureView;
}

/** The build order, as the core's featuresOf derives it (packages/core/src/factory/features.ts). */
export function routeOf(plan: PlanView, docs: ProductDocsView | undefined, features: FeatureView[]): RouteStep[] {
  const views = plan.views ?? [];
  const out: RouteStep[] = [];
  const modules = plan.tasks.filter((t) => !/^views?\b|index\.html|web\/app/i.test(t.title));
  out.push({
    id: "F1", kind: "shell", title: "The app's model and shell",
    gets: views.length ? `An app that starts and opens, with ${views.length} empty screens and sample data in place.` : "An app that starts, with its data model and sample data.",
    shows: [], can: [],
    chips: (plan.entities ?? []).map((e) => e.label || e.name),
  });
  out.push({
    id: "F2", kind: "logic", title: "The rules that make it work",
    gets: `The logic the screens will call, written against the locked tests${modules.length ? `, in ${modules.length} parts` : ""}.`,
    shows: modules.map((t) => t.title), can: [], chips: [],
  });
  for (const v of views) {
    const s = docs?.screens.find((x) => x.id === v.id) ?? (v.id === "dashboard" ? docs?.screens[0] : undefined);
    const [what, controls] = v.shows.split(/\s*Controls:\s*/i);
    out.push({
      id: `F${out.length + 1}`, kind: "screen", title: v.label,
      gets: s?.purpose || sentences(what)[0] || v.shows,
      shows: s?.shows.length ? s.shows : sentences(what),
      can: s?.actions.length ? s.actions : controls ? controls.split(/,\s*(?![^()]*\))/).map((x) => x.replace(/\.$/, "").trim()).filter(Boolean) : [],
      chips: [],
    });
  }
  // Steps the build added on top (a feature run) or a build that ran before views were planned.
  for (const f of features) if (!out.some((o) => o.id === f.id)) out.push({ id: f.id, kind: "screen", title: f.title.replace(/^Screen:\s*/, ""), gets: "", shows: [], can: [], chips: [] });
  for (const o of out) o.feature = features.find((f) => f.id === o.id);
  return out;
}

/** The screens a journey passes through, in order, from the screen names its steps mention. */
function screenPath(steps: string[], views: { id: string; label: string }[]): string[] {
  const out: string[] = [];
  steps.forEach((st, i) => {
    // Screen names are written as names ("Today", "the Session screen"): match them as whole, capitalised words.
    const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const hits = views.map((v) => ({ v, at: st.search(new RegExp(`\\b${esc(v.label)}\\b`)) })).filter((h) => h.at >= 0).sort((a, b) => a.at - b.at).map((h) => h.v.label);
    if (!hits.length && i === 0 && /open the app|home/i.test(st) && views[0]) hits.push(views[0].label);
    for (const h of hits) if (out.at(-1) !== h) out.push(h);
  });
  return out;
}

function sentences(t: string) { return t.split(/(?<=\.)\s+(?=[A-Z])/).map((x) => x.replace(/\.$/, "").trim()).filter(Boolean); }
/** "Ranking: sortItems puts..." → ["Ranking", "sortItems puts..."]. */
function headed(t: string): [string | null, string] {
  const m = /^([^:]{2,40}):\s+(.*)$/s.exec(t);
  return m ? [m[1], m[2]] : [null, t];
}

const STATE: Record<string, [string, string]> = {
  built: ["built", "done"], building: ["building now", "live"], regressed: ["broke a test, back for a fix", "fail"],
  broken: ["did not draw, back for a fix", "fail"], empty: ["nothing changed, back again", "fail"],
};

export function Blueprint({ run, compact }: { run: FactoryRunView; compact?: boolean }) {
  const plan = run.plan!;
  const docs = designRounds(run).at(-1)?.docs;
  const route = routeOf(plan, docs, run.features);
  const [open, setOpen] = useState<string | null>(null);
  const built = route.filter((s) => s.feature?.state === "built").length;
  const now = route.find((s) => s.feature?.state === "building");
  const started = run.features.length > 0;
  const screens = route.filter((s) => s.kind === "screen");
  // The plan check's finds: the Planner adds them before your OK, so only the ones it could not add stay open.
  const found = (run.planGaps ?? []).flatMap((g) => g.missing.map((m) => ({ text: String(m), added: g.added })));
  const gaps = found.filter((g, i) => found.findIndex((x) => x.text === g.text) === i);
  const openGaps = gaps.filter((g) => !g.added);
  return (
    <div className={`bp${compact ? " compact" : ""}`}>
      <header className="bp-hero">
        <div className="bp-title">
          <span className="bp-kicker">The plan</span>
          <h2>{plan.name}</h2>
          <p>{plan.summary}</p>
        </div>
        <div className="bp-stats">
          <Stat n={screens.length} l="screens" />
          <Stat n={plan.entities?.length ?? 0} l="kinds of data" />
          <Stat n={plan.flows?.length ?? 0} l="ways it's used" />
          <Stat n={plan.acceptance.length} l="checks for done" />
          {openGaps.length > 0 ? <Stat n={openGaps.length} l="gaps still open" warn /> : gaps.length > 0 ? <Stat n={gaps.length} l="gaps caught and added" /> : null}
        </div>
      </header>

      <section className="bp-sec">
        <div className="bp-sec-h">
          <h3>The build route</h3>
          <p>{started ? `${built} of ${route.length} steps built${now ? `. Now: ${now.title}.` : "."}` : `The Builder takes these ${route.length} steps in order, one fresh session each. The locked tests run after every step.`}</p>
        </div>
        <ol className="bp-strip" aria-label="Build route at a glance">
          {route.map((s, i) => {
            const st = s.feature ? STATE[s.feature.state]?.[1] ?? "" : "";
            return (
              <li key={s.id} className={`bp-pin k-${s.kind} ${st}`}>
                <a href={`#bp-${run.run}-${s.id}`} onClick={(e) => { e.preventDefault(); document.getElementById(`bp-${run.run}-${s.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" }); setOpen(s.id); }}>
                  <span className="bp-num">{i + 1}</span><span className="bp-pin-t">{s.title}</span>
                </a>
              </li>
            );
          })}
        </ol>
        <ol className="bp-route">
          {route.map((s, i) => {
            const [label, tone] = s.feature ? STATE[s.feature.state] ?? ["", ""] : ["planned", ""];
            const t = s.feature ? (s.feature.passed ?? 0) + (s.feature.failed ?? 0) : 0;
            const isOpen = open === s.id;
            const more = s.shows.length > 4 || s.can.length > 5;
            return (
              <li key={s.id} id={`bp-${run.run}-${s.id}`} className={`bp-step k-${s.kind} ${tone}${isOpen ? " open" : ""}`}>
                <div className="bp-rail"><span className="bp-dot">{tone === "done" ? "✓" : i + 1}</span></div>
                <div className="bp-card">
                  <div className="bp-card-h">
                    {s.kind === "screen" ? <Thumb n={Math.min(s.shows.length, 6)} /> : <span className={`bp-glyph g-${s.kind}`} aria-hidden />}
                    <div className="bp-card-t">
                      <span className="bp-kind">{s.kind === "screen" ? "Screen" : s.kind === "shell" ? "Foundation" : "Logic"}</span>
                      <h4>{s.title}</h4>
                    </div>
                    <span className={`bp-state ${tone}`}>{label}{s.feature && s.feature.attempt > 1 ? ` · try ${s.feature.attempt}` : ""}</span>
                  </div>
                  {s.gets && <p className="bp-gets">{s.gets}</p>}
                  {s.kind === "shell" && s.chips.length > 0 && <div className="bp-chips">{s.chips.map((c) => <span key={c} className="bp-chip">{c}</span>)}</div>}
                  {s.kind === "logic" && s.shows.length > 0 && (
                    <ul className="bp-mods">{(isOpen ? s.shows : s.shows.slice(0, 4)).map((m) => { const [h, b] = headed(m); return <li key={m}>{h ? <><code>{h}</code><span>{b}</span></> : <span>{m}</span>}</li>; })}</ul>
                  )}
                  {s.kind === "screen" && (s.shows.length > 0 || s.can.length > 0) && (
                    <div className="bp-cols">
                      {s.shows.length > 0 && <div><h5>You see</h5><ul>{(isOpen ? s.shows : s.shows.slice(0, 4)).map((x) => <li key={x}>{x}</li>)}</ul></div>}
                      {s.can.length > 0 && <div><h5>You can</h5><div className="bp-acts">{(isOpen ? s.can : s.can.slice(0, 5)).map((x) => <span key={x} className="bp-act">{x}</span>)}</div></div>}
                    </div>
                  )}
                  {(more || (s.kind === "logic" && s.shows.length > 4)) && <button className="bp-more" onClick={() => setOpen(isOpen ? null : s.id)}>{isOpen ? "Show less" : "Show all"}</button>}
                  {t > 0 && <div className="bp-tests"><span className="bp-bar"><i style={{ width: `${((s.feature!.passed ?? 0) / t) * 100}%` }} /></span><span>{s.feature!.passed}/{t} locked tests pass after this step</span></div>}
                </div>
              </li>
            );
          })}
        </ol>
      </section>

      {(plan.flows?.length ?? 0) > 0 && (
        <section className="bp-sec">
          <div className="bp-sec-h"><h3>How people will use it</h3><p>The journeys the app is built around. The Judge walks these in the running app.</p></div>
          <div className="bp-flows">
            {plan.flows!.map((f) => (
              <div key={f.name} className="bp-flow">
                <h4>{cap(f.name)}</h4>
                {screenPath(f.steps, plan.views ?? []).length > 1 && <div className="bp-path" aria-label="Screens this journey passes">{screenPath(f.steps, plan.views ?? []).flatMap((v, k) => [k > 0 && <i key={`a${k}`} aria-hidden>→</i>, <span key={k}>{v}</span>])}</div>}
                <ol>{f.steps.map((st, k) => <li key={k}><span className="bp-fn">{k + 1}</span><span>{st}</span></li>)}</ol>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="bp-sec">
        <div className="bp-sec-h"><h3>Done means</h3><p>Each line is a check the locked tests or the Reviewer hold the build to.</p></div>
        <ol className="bp-checks">
          {plan.acceptance.map((a, i) => { const [h, b] = headed(a); const k = `c${i}`; return <li key={i} className={open === k ? "open" : ""} onClick={() => setOpen(open === k ? null : k)} title={open === k ? "" : "Click to read it all"}><span className="bp-cn">{i + 1}</span><div>{h && <b>{h}</b>}<p>{b}</p></div></li>; })}
        </ol>
      </section>

      {gaps.length > 0 && (
        <section className="bp-sec">
          <div className="bp-sec-h"><h3>What the plan check caught</h3><p>{openGaps.length ? "Asked for in the design but still missing from the plan. Worth a look before you approve." : "The first plan left these out; the Planner added them before it reached you."}</p></div>
          <ul className="bp-gaps">{gaps.map((g) => { const [h, b] = headed(g.text); return <li key={g.text} className={g.added ? "added" : ""}><span className="bp-gap-tag">{g.added ? "added to the plan" : "still missing"}</span>{h && <b>{h}</b>}<span>{b}</span></li>; })}</ul>
        </section>
      )}

      {(plan.entities?.length ?? 0) > 0 && (
        <section className="bp-sec">
          <div className="bp-sec-h"><h3>What it keeps</h3><p>The kinds of data the app stores. Each gets full add, edit and delete.</p></div>
          <div className="bp-ents">
            {plan.entities!.map((e) => (
              <div key={e.name} className="bp-ent">
                <h4>{e.label || cap(e.name)}</h4>
                <div className="bp-fields">{e.fields.map((f) => <span key={f.name} className={f.to ? "link" : ""} title={f.type ?? ""}>{f.name.replace(/_/g, " ")}{f.to ? ` → ${f.to}` : ""}</span>)}</div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function Stat({ n, l, warn }: { n: number; l: string; warn?: boolean }) {
  return <div className={`bp-stat${warn ? " warn" : ""}`}><b>{n}</b><span>{l}</span></div>;
}
function cap(s: string) { return s.charAt(0).toUpperCase() + s.slice(1); }

/** A tiny sketch of a screen: a title bar and one block per thing it shows. */
function Thumb({ n }: { n: number }) {
  const blocks = Array.from({ length: Math.max(2, n) }, (_, k) => k);
  return (
    <svg className="bp-thumb" viewBox="0 0 56 40" aria-hidden>
      <rect x="1" y="1" width="54" height="38" rx="4" className="f" />
      <rect x="1" y="1" width="54" height="7" rx="3" className="h" />
      {blocks.map((k) => <rect key={k} x={5 + (k % 2) * 24} y={11 + Math.floor(k / 2) * 9} width={k % 2 ? 22 : 21} height={6} rx={1.5} className="b" />)}
    </svg>
  );
}

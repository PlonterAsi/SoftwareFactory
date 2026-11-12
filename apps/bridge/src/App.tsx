import { BrainPage } from "./Brain";
import { KitPage } from "./Kit";
import { useEffect, useMemo, useRef, useState } from "react";
import { API, setupApi, useBay, useChatRoutes, useFactory, useOrder, useProjects, type SinceView } from "./api";
import { Setup } from "./Setup";
import { CoreDown } from "./CoreDown";
import { AgentBay } from "./AgentBay";
import { RunDeck } from "./RunDeck";
import { StarMap } from "./StarMap";
import { FactoryFloor } from "./FactoryFloor";
import { Timeline } from "./Timeline";
import { Overseer } from "./Overseer";
import { OrderDeck } from "./OrderDeck";
import { DataDeck, useStore } from "./DataDeck";
import { UpdateBanner, VersionChip, useUpdates } from "./Updates";
import { Home } from "./projects/Home";
import { Workspace } from "./projects/Workspace";
import { href, useRoute, type FactoryView } from "./projects/router";
import "./projects/builtin";
import { ImproveDeck, useImprove } from "./ImproveDeck";
import "./projects/improvePanel";
import "./projects/runPanel";
import "./CodeMap";
import { FeaturesPage, useIntegrations } from "./Features";
import { PluginsPage, syncPluginPanels, usePlugins } from "./Plugins";
import { DEFAULT_LAYOUT, LAYOUT_KEY, usePref, type Layout } from "./shell/prefs";
import { Sidebar } from "./shell/Sidebar";
import { Helm, HelmButton } from "./shell/Helm";
import { NeedsYou } from "./shell/NeedsYou";
import { ShortcutSheet, useShortcuts } from "./shell/Shortcuts";
import { BasesPage, useBases } from "./Bases";

export function App() {
  const f = useFactory();
  const order = useOrder(f.events);
  const bay = useBay(f.events);
  const improve = useImprove(f.events);
  const waiting = improve.proposals.filter((p) => p.status === "inbox").length;
  const [route, go] = useRoute();
  const features = useIntegrations(f.events);
  const featuresWaiting = features.data?.integrations.filter((i) => i.status === "awaiting").length ?? 0;
  const projects = useProjects(f.events, f.online);
  const plugins = usePlugins(f.events, f.online);
  // Enabled plugins' tabs join every project before the workspace renders.
  syncPluginPanels(plugins.data?.plugins, f.events);
  const pluginsOn = plugins.data?.plugins.filter((p) => p.status === "enabled").length ?? 0;
  const chatRoutes = useChatRoutes(f.events, f.online);
  const bases = useBases(f.online);
  const [picked, setPicked] = useState<number | null>(null);
  const [node, setNode] = useState<number | null>(null);
  const view: FactoryView = route.page === "factory" ? route.view : "factory";
  const setView = (v: FactoryView) => go({ page: "factory", view: v });
  const store = useStore(f.events, route.page === "factory" && view === "data");
  // Follow the newest run unless one was picked.
  const selected = f.factoryRuns.find((r) => r.run === picked) ?? f.factoryRuns.at(-1);
  const crew = useMemo(() => Object.fromEntries(bay.agents.map((a) => [a.def.id, { name: a.def.name, avatar: a.def.avatar }])), [bay.agents]);
  const open = order.conflicts.filter((c) => c.status === "open").length;
  // On the whole-factory screen, a new conflict card pulls the Order deck forward once; it never blocks anything.
  const seenOpen = useRef(0);
  useEffect(() => { if (open > seenOpen.current && route.page === "factory") setView("order"); seenOpen.current = open; }, [open]);
  const pickNode = (id: number | null) => { setNode(id); if (id != null) setView("order"); };
  const projectId = route.page === "project" ? route.id : undefined;
  const projectName = projectId != null ? projects.list?.find((p) => p.id === projectId)?.name : undefined;
  // A run belongs to a project: show it there (a build started outside a project is a project of its own).
  const showRun = async (run: number) => {
    try {
      const r = await fetch(`${API}/api/projects/of?kind=factory_run&ref=${run}`).then((x) => x.json());
      if (r.projectId != null) return go({ page: "project", id: r.projectId, panel: "runs", run });
    } catch { /* fall back to the factory floor */ }
    setPicked(run);
    go({ page: "factory", view: "factory" });
  };
  const [setupOpen, setSetupOpen] = useState(false);
  const updates = useUpdates(f.online);
  const lastEvent = f.events.at(-1)?.id ?? 0;

  // "Since you left": read once when the core first answers, before saying where we are now.
  const [since, setSince] = useState<SinceView | null>(null);
  const sinceAsked = useRef(false);
  useEffect(() => {
    if (!f.online || sinceAsked.current) return;
    sinceAsked.current = true;
    setupApi.since().then((s) => { if (s.awayMinutes >= 10 && s.lines.length) setSince(s); }).catch(() => {});
  }, [f.online]);
  // Mark how far you have seen when you leave the window (and every few minutes while it is open).
  const seenRef = useRef(0);
  seenRef.current = lastEvent;
  useEffect(() => {
    if (!f.online) return;
    const mark = () => { if (seenRef.current && sinceAsked.current) setupApi.seen(seenRef.current); };
    const onHide = () => { if (document.visibilityState === "hidden") mark(); };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", mark);
    const t = setInterval(mark, 5 * 60_000);
    return () => { document.removeEventListener("visibilitychange", onHide); window.removeEventListener("pagehide", mark); clearInterval(t); };
  }, [f.online]);
  const overseer = (
    <Overseer signals={f.signals} runs={f.runs} factoryRuns={f.factoryRuns} briefings={order.briefings} ingests={order.ingests}
      onRunStarted={(r, pid) => (pid != null ? go({ page: "project", id: pid, panel: "runs", run: r }) : showRun(r))}
      mode={f.mode} since={since} onDismissSince={() => setSince(null)} onSetup={() => setSetupOpen(true)} onShowRun={showRun}
      projectId={projectId} projectName={projectName} projects={projects.list} routes={chatRoutes} />
  );
  const [layout, setLayout] = usePref<Layout>(LAYOUT_KEY, DEFAULT_LAYOUT);
  const [assist, setAssist] = usePref<"open" | "closed">("sf.assistant", "open");
  const [helmOpen, setHelmOpen] = useState(false);
  const foundry = layout === "foundry";
  // Ctrl K opens the helm, Ctrl J shows or hides the Assistant (new shell only).
  useEffect(() => {
    if (!foundry) return;
    const k = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
      const key = e.key.toLowerCase();
      if (key === "k") { e.preventDefault(); setHelmOpen((o) => !o); }
      else if (key === "j") { e.preventDefault(); setAssist(assist === "open" ? "closed" : "open"); }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [foundry, assist]); // eslint-disable-line react-hooks/exhaustive-deps
  const [keysOpen, setKeysOpen] = useShortcuts(foundry, go);
  const needsCount = f.factoryRuns.filter((r) => r.waiting && !r.finished).length + (featuresWaiting ? 1 : 0) + (open ? 1 : 0);

  const factoryGrid = (withOverseer: boolean) => (
    <main className={`grid${withOverseer ? "" : " no-assist"}`}>
      <StarMap signals={f.signals} order={order} selected={node} onSelect={pickNode} factoryRuns={f.factoryRuns} onShowRun={showRun} />
      <div className={`center view-${view}`}>
        <nav className="viewbar" role="tablist" aria-label="Center view">
          <button role="tab" aria-selected={view === "factory"} className={view === "factory" ? "tab on" : "tab"} onClick={() => setView("factory")}>Factory floor</button>
          <button role="tab" aria-selected={view === "bay"} className={view === "bay" ? "tab on" : "tab"} onClick={() => setView("bay")}>Agents{Object.values(bay.stats).some((s) => s.state === "thinking") ? " · working" : ""}</button>
          <button role="tab" aria-selected={view === "order"} className={(view === "order" ? "tab on" : "tab") + (open ? " alert" : "")} onClick={() => setView("order")}>Order deck{open ? ` · ${open}` : ""}</button>
          <button role="tab" aria-selected={view === "improve"} className={view === "improve" ? "tab on" : "tab"} onClick={() => setView("improve")}>Improve{improve.busy ? " · looking" : waiting ? ` · ${waiting}` : ""}</button>
          <button role="tab" aria-selected={view === "data"} className={view === "data" ? "tab on" : "tab"} onClick={() => setView("data")}>Data vault</button>
        </nav>
        {view === "factory" ? <>
          <FactoryFloor runs={f.runs} factoryRuns={f.factoryRuns} selected={selected} onSelect={setPicked} crew={crew} mode={f.mode} />
          <RunDeck run={selected} />
        </> : view === "bay" ? <AgentBay bay={bay} /> : view === "improve" ? <ImproveDeck improve={improve} crew={bay.agents} onRunStarted={showRun} /> : view === "order" ? <OrderDeck order={order} selected={node} onSelect={pickNode} /> : <DataDeck store={store} />}
        <Timeline runs={f.runs} totalUsd={f.totalUsd} />
      </div>
      {withOverseer && overseer}
    </main>
  );
  const page = route.page === "needs"
    ? <NeedsYou factoryRuns={f.factoryRuns} featuresWaiting={featuresWaiting} conflicts={open} onShowRun={showRun} />
    : route.page === "bases"
    ? <BasesPage bases={bases.data} refresh={bases.refresh} />
    : route.page === "kit"
    ? <KitPage />
    : route.page === "brain"
    ? <BrainPage events={f.events} />
    : route.page === "plugins"
    ? <PluginsPage events={f.events} list={plugins.data} err={plugins.err} refresh={plugins.refresh} id={route.id} panel={route.panel} />
    : route.page === "features"
    ? <FeaturesPage events={f.events} id={route.id} onOpenProject={(id) => go({ page: "project", id, panel: "integrate" })} />
    : route.page === "project"
    ? <Workspace id={route.id} panel={route.panel} run={route.run} factory={f} order={order} bay={bay} go={go} />
    : <Home list={projects.list} err={projects.err} onOpen={(id) => go({ page: "project", id })} />;
  const crewChip = <button className={`crew-chip ${f.mode ?? ""}`} onClick={() => setSetupOpen(true)} title={`Runtime: ${f.runtime}. Click for crew, checks and folders.`}>{f.mode === "real" ? "Real crew" : f.mode === "practice" ? "Practice crew · free" : "Crew …"}</button>;
  const setup = <Setup open={setupOpen} onClose={() => setSetupOpen(false)} updates={updates} layout={layout} onLayout={setLayout}
    dropsAt={f.events.filter((e) => e.type.startsWith("drop.") || e.type === "settings.changed").at(-1)?.id ?? 0} />;

  if (foundry) {
    const assistOpen = assist === "open";
    return (
      <div className="shell2">
        <Sidebar route={route} needs={needsCount} projects={projects.list} factoryRuns={f.factoryRuns} crewBusy={Object.values(bay.stats).some((s) => s.state === "thinking")} base={bases.current?.name}>
          <button className="sb-item sb-btn" onClick={() => setSetupOpen(true)}><span className="sb-icon"><svg width="14" height="14" viewBox="0 0 16 16" aria-hidden className="sb-ico"><path d="M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" /></svg></span><span className="sb-text">Systems</span></button>
          <div className="sb-status">
            <span className={f.online ? "dot on" : "dot"} /> {f.online ? "Online" : "Offline"}
            <span className="num" title="Spent on agents so far">${f.totalUsd.toFixed(2)}</span>
          </div>
          {crewChip}
          <VersionChip u={updates} onOpen={() => setSetupOpen(true)} />
          <button className="link sb-keys" onClick={() => setKeysOpen(true)}>Keyboard shortcuts <kbd>?</kbd></button>
        </Sidebar>
        <div className="s2-main">
          <header className="s2-top">
            <HelmButton onOpen={() => setHelmOpen(true)} projectName={projectName} />
            <div className="s2-top-right">
              {open > 0 && <a className="alert-text" href={href({ page: "factory", view: "order" })}>{open} conflict{open > 1 ? "s" : ""}</a>}
              <button className={`ghost sm s2-assist-toggle${assistOpen ? " on" : ""}`} onClick={() => setAssist(assistOpen ? "closed" : "open")} aria-pressed={assistOpen} aria-keyshortcuts="Control+J" title="Show or hide the Assistant (Ctrl J)">Assistant <kbd>Ctrl J</kbd></button>
            </div>
          </header>
          <UpdateBanner u={updates} />
          {route.page === "factory" ? (
            // The whole factory keeps its own three columns; the Assistant is its last one.
            <div className="s2-body"><div className="s2-page">{factoryGrid(assistOpen)}</div></div>
          ) : (
            <div className={`s2-body${assistOpen ? " with-assist" : ""}`}>
              <div className="s2-page" key={route.page === "project" ? `p${route.id}` : route.page}>{page}</div>
              {assistOpen && <div className="s2-assist">{overseer}</div>}
            </div>
          )}
        </div>
        <Helm open={helmOpen} onClose={() => setHelmOpen(false)} projects={projects.list} projectId={projectId} projectName={projectName} go={go}
          onSystems={() => setSetupOpen(true)} onRunStarted={(r, pid) => (pid != null ? go({ page: "project", id: pid, panel: "runs", run: r }) : showRun(r))} />
        <ShortcutSheet open={keysOpen} onClose={() => setKeysOpen(false)} />
        {setup}
        <CoreDown online={f.online} />
      </div>
    );
  }

  return (
    <div className="bridge">
      <header className="topbar">
        <div className="brand-nav">
          <a className="brand" href={href({ page: "home" })}><span className="logo" aria-hidden>◈</span> SoftwareFactory</a>
          {bases.current && <a className="base-chip" href={href({ page: "bases" })} aria-current={route.page === "bases" ? "page" : undefined} title={`Base: ${bases.current.name} (${bases.current.folder}). Click to open another base or start a new one.`}>
            <span className="base-chip-label">Base</span> {bases.current.name} <span aria-hidden>▾</span>
          </a>}
          <nav className="topnav" aria-label="Main">
            <a href={href({ page: "home" })} aria-current={route.page === "home" || route.page === "project" ? "page" : undefined}>Projects</a>
            <a href={href({ page: "features" })} aria-current={route.page === "features" ? "page" : undefined} className={featuresWaiting ? "alert-text" : undefined}>
              Features{features.data?.installed.length ? ` · ${features.data.installed.length}` : ""}{featuresWaiting ? ` · ${featuresWaiting} to approve` : ""}
            </a>
            <a href={href({ page: "plugins" })} aria-current={route.page === "plugins" ? "page" : undefined}>
              Plugins{pluginsOn ? ` · ${pluginsOn}` : ""}
            </a>
            <a href={href({ page: "brain" })} aria-current={route.page === "brain" ? "page" : undefined}>Brain</a>
            <a href={href({ page: "factory", view })} aria-current={route.page === "factory" ? "page" : undefined}>Whole factory</a>
          </nav>
        </div>
        <div className="stats" title={`${projects.list?.filter((p) => p.status !== "archived").length ?? "…"} projects · ${f.signals.length} notes · ${bay.agents.filter((a) => !a.retired).length} agents · ${f.factoryRuns.length} factory runs · ${f.runs.length} agent calls`}>
          <span className={f.online ? "dot on" : "dot"} /> {f.online ? "Online" : "Offline"}
          {crewChip}
          {open > 0 && <a className="alert-text" href={href({ page: "factory", view: "order" })}>{open} conflict{open > 1 ? "s" : ""}</a>}
          <span className="num">${f.totalUsd.toFixed(4)}</span>
          <VersionChip u={updates} onOpen={() => setSetupOpen(true)} />
          <button className="ghost sm systems" onClick={() => setSetupOpen(true)} aria-label="Systems: crew, checks and folders">Systems</button>
        </div>
      </header>
      <UpdateBanner u={updates} />
      {route.page === "factory" ? factoryGrid(true) : (
        <main className="grid projects-grid">
          {page}
          {overseer}
        </main>
      )}
      {setup}
      <CoreDown online={f.online} />
    </div>
  );
}

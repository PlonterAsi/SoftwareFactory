import { BrainPage } from "./Brain";
import { KitPage } from "./Kit";
import { useEffect, useMemo, useRef, useState } from "react";
import { API, setupApi, useBay, useChatRoutes, useFactory, useOrder, useProjects, type SinceView } from "./api";
import { Setup } from "./Setup";
import { BugReport, ErrorBoundary } from "./BugReport";
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
import "./projects/mission/Mission";
import { Tickets, useTicketCounts } from "./Tickets";
import "./TicketsPanel";
import { ImproveDeck, useImprove } from "./ImproveDeck";
import "./projects/improvePanel";
import "./projects/runPanel";
import "./CodeMap";
import { FeaturesPage, useIntegrations } from "./Features";
import { PluginsPage, syncPluginPanels, usePlugins } from "./Plugins";
import { usePref } from "./shell/prefs";
import { Sidebar } from "./shell/Sidebar";
import { Helm, HelmButton } from "./shell/Helm";
import { NeedsYou } from "./shell/NeedsYou";
import { ShortcutSheet, useShortcuts } from "./shell/Shortcuts";
import { BasesPage, useBases } from "./Bases";
import { FactoryBridge } from "./bridge/FactoryBridge";

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
  const chatRoutes = useChatRoutes(f.events, f.online);
  const bases = useBases(f.online);
  const [picked, setPicked] = useState<number | null>(null);
  const [node, setNode] = useState<number | null>(null);
  const view: FactoryView = route.page === "factory" ? route.view : "factory";
  const setView = (v: FactoryView) => go({ page: "factory", view: v });
  const store = useStore(f.events, route.page === "factory" && view === "data");
  const ticketCounts = useTicketCounts(f.events);
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
      if (r.projectId != null) return go({ page: "project", id: r.projectId, panel: "overview", run });
    } catch { /* fall back to the factory floor */ }
    setPicked(run);
    go({ page: "factory", view: "factory" });
  };
  const [setupOpen, setSetupOpen] = useState(false);
  const [bugOpen, setBugOpen] = useState(false);
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
      onRunStarted={(r, pid) => (pid != null ? go({ page: "project", id: pid, panel: "overview", run: r }) : showRun(r))}
      mode={f.mode} since={since} onDismissSince={() => setSince(null)} onSetup={() => setSetupOpen(true)} onShowRun={showRun}
      projectId={projectId} projectName={projectName} projects={projects.list} routes={chatRoutes} />
  );
  const [assist, setAssist] = usePref<"open" | "closed">("sf.assistant", "open");
  const [helmOpen, setHelmOpen] = useState(false);
  // Ctrl K opens the helm, Ctrl J shows or hides the Assistant.
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
      const key = e.key.toLowerCase();
      if (key === "k") { e.preventDefault(); setHelmOpen((o) => !o); }
      else if (key === "j") { e.preventDefault(); setAssist(assist === "open" ? "closed" : "open"); }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [assist]); // eslint-disable-line react-hooks/exhaustive-deps
  const [keysOpen, setKeysOpen] = useShortcuts(true, go);
  const needsCount = f.factoryRuns.filter((r) => r.waiting && !r.finished).length + (featuresWaiting ? 1 : 0) + (open ? 1 : 0) + (ticketCounts?.you ? 1 : 0);

  // The old "Whole factory" screen, one page per part: each has its own place in the sidebar.
  const factoryPage = (
    <ErrorBoundary key={view} where={`bridge #/factory/${view}`}>
      {view === "factory" ? (
        <section className="pane fpage fpage-builds" aria-label="All builds">
          <header className="page-head"><h1>All builds</h1><p>Every build in this base, station by station. Each also lives in its project.</p></header>
          <FactoryFloor runs={f.runs} factoryRuns={f.factoryRuns} selected={selected} onSelect={setPicked} crew={crew} mode={f.mode} />
          <RunDeck run={selected} />
          <Timeline runs={f.runs} totalUsd={f.totalUsd} />
        </section>
      ) : view === "bay" ? <div className="fpage"><AgentBay bay={bay} /></div>
        : view === "tickets" ? <div className="fpage"><Tickets events={f.events} onShowRun={showRun}
            crew={bay.agents.filter((a) => !a.retired).map((a) => ({ id: a.def.id, name: a.def.name, avatar: a.def.avatar }))} /></div>
        : view === "improve" ? <div className="fpage"><ImproveDeck improve={improve} crew={bay.agents} onRunStarted={showRun} /></div>
        : view === "order" ? (
          <div className="fpage fpage-rules">
            <StarMap signals={f.signals} order={order} selected={node} onSelect={pickNode} factoryRuns={f.factoryRuns} onShowRun={showRun} />
            <OrderDeck order={order} selected={node} onSelect={pickNode} />
          </div>
        ) : <div className="fpage"><DataDeck store={store} /></div>}
    </ErrorBoundary>
  );
  const pageInner = route.page === "bridge"
    ? <FactoryBridge mode={route.mode} factoryRuns={f.factoryRuns} runs={f.runs} crew={crew} agents={bay.agents} stats={bay.stats} projects={projects.list} projectOfRun={chatRoutes.factoryRuns} events={f.events} onShowRun={showRun} />
    : route.page === "needs"
    ? <NeedsYou factoryRuns={f.factoryRuns} featuresWaiting={featuresWaiting} conflicts={open} ticketsForYou={ticketCounts?.you ?? 0} onShowRun={showRun} />
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
    : <Home list={projects.list} err={projects.err} events={f.events} cards onOpen={(id) => go({ page: "project", id })} />;
  const page = <ErrorBoundary key={route.page === "project" ? `p${route.id}` : route.page} where={`bridge ${href(route)}`}>{pageInner}</ErrorBoundary>;
  const bugButton = <button className="ghost sm bug-btn" onClick={() => setBugOpen(true)} aria-label="Report a bug" title="Report a bug: what went wrong, with the screen attached">Bug</button>;
  const crewChip = <button className={`crew-chip ${f.mode ?? ""}`} onClick={() => setSetupOpen(true)} title={`Runtime: ${f.runtime}. Click for crew, checks and folders.`}>{f.mode === "real" ? "Real crew" : f.mode === "practice" ? "Practice crew · free" : "Crew …"}</button>;
  const setup = <>
    <Setup open={setupOpen} onClose={() => setSetupOpen(false)} updates={updates}
    dropsAt={f.events.filter((e) => e.type.startsWith("drop.") || e.type === "settings.changed").at(-1)?.id ?? 0} />
    <BugReport open={bugOpen} onClose={() => setBugOpen(false)} />
  </>;

  const assistOpen = assist === "open";
  return (
    <div className="shell2">
      <Sidebar route={route} needs={needsCount} projects={projects.list} factoryRuns={f.factoryRuns} crewBusy={Object.values(bay.stats).some((s) => s.state === "thinking")} base={bases.current?.name}
        conflicts={open} proposals={waiting} tickets={ticketCounts?.open ?? 0}>
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
            {bugButton}
            <button className={`ghost sm s2-assist-toggle${assistOpen ? " on" : ""}`} onClick={() => setAssist(assistOpen ? "closed" : "open")} aria-pressed={assistOpen} aria-keyshortcuts="Control+J" title="Show or hide the Assistant (Ctrl J)">Assistant <kbd>Ctrl J</kbd></button>
          </div>
        </header>
        <UpdateBanner u={updates} />
        <div className={`s2-body${assistOpen ? " with-assist" : ""}`}>
          <div className="s2-page" key={route.page === "project" ? `p${route.id}` : route.page === "factory" ? `f-${view}` : route.page}>{route.page === "factory" ? factoryPage : page}</div>
          {assistOpen && <div className="s2-assist">{overseer}</div>}
        </div>
      </div>
      <Helm open={helmOpen} onClose={() => setHelmOpen(false)} projects={projects.list} projectId={projectId} projectName={projectName} go={go}
        onSystems={() => setSetupOpen(true)} onRunStarted={(r, pid) => (pid != null ? go({ page: "project", id: pid, panel: "overview", run: r }) : showRun(r))} />
      <ShortcutSheet open={keysOpen} onClose={() => setKeysOpen(false)} />
      {setup}
      <CoreDown online={f.online} />
    </div>
  );
}

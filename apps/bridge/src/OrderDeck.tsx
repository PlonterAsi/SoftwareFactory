import { useState, type FormEvent } from "react";
import { orderApi, type Conflict, type Fragment, type OrderState } from "./api";

type Tab = "canon" | "tray" | "conflicts" | "briefing" | "checks";

const RULE_NAMES: Record<string, string> = {
  "explicit-over-inferred": "your words beat an inferred rule",
  "specific-over-general": "specific node wins there",
  "newer-over-older": "newer replaces older",
  "important-over-unmarked": "important wins",
  "your-call": "your call",
};

function when(ts?: string) {
  if (!ts) return "";
  const d = new Date(ts);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/**
 * The Order deck: what the Order Engine knows, drawn. The Canon of the selected
 * node as a constellation (conflicts are red links), the Unsorted tray, the
 * conflict cards, the daily briefing with undoable sweep actions, and every
 * visualizeEverything check.
 */
export function OrderDeck({ order, selected, onSelect }: { order: OrderState; selected: number | null; onSelect: (id: number | null) => void }) {
  const [tab, setTab] = useState<Tab>("canon");
  const [err, setErr] = useState<string | null>(null);
  const act = (p: Promise<unknown>) => p.then(() => setErr(null)).catch((x) => setErr((x as Error).message));
  const live = order.nodes.filter((n) => n.mergedInto == null);
  const nodeId = selected ?? live.find((n) => n.parentId == null)?.id ?? null;
  const tray = order.fragments.filter((f) => f.nodeId == null && f.kind !== "noise" && f.state === "live");
  // Filed, but on a guess: shown with one-tap refiles until you confirm or move them.
  const unsure = order.fragments.filter((f) => f.nodeId != null && f.kind !== "noise" && f.state === "live" && f.confidence < UNSURE_BELOW).slice(-40).reverse();
  const open = order.conflicts.filter((c) => c.status === "open");
  const vFail = order.visuals.filter((v) => !v.pass).length;
  const tabs: [Tab, string][] = [
    ["canon", `Project rules${nodeId != null ? ` · ${order.canon[nodeId]?.length ?? 0}` : ""}`],
    ["tray", `Loose ideas · ${tray.length}${unsure.length ? ` · ${unsure.length} unsure` : ""}`],
    ["conflicts", `Conflicts${open.length ? ` · ${open.length} open` : ` · ${order.conflicts.length}`}`],
    ["briefing", "Briefing"],
    ["checks", `Visuals${order.visuals.length ? (vFail ? ` · ${vFail} missing` : " · all") : ""}`],
  ];
  return (
    <section className="pane deck order-deck" aria-label="Order deck">
      <header className="pane-head deck-head">
        <div className="tabs" role="tablist">
          {tabs.map(([id, label]) => <button key={id} role="tab" aria-selected={tab === id} className={(tab === id ? "tab on" : "tab") + (id === "conflicts" && open.length ? " alert" : "")} onClick={() => setTab(id)}>{label}</button>)}
        </div>
        <span className="muted mono deck-dir" title="Archivist spend today / daily cap">archivist {order.mode} · ${order.spentUsd.toFixed(4)} / ${order.maxUsd.toFixed(2)}</span>
      </header>
      <div className="deck-body order-body">
        {err && <div className="err">{err}</div>}
        {tab === "canon" && <CanonView order={order} nodeId={nodeId} onSelect={onSelect} act={act} />}
        {tab === "tray" && <><Unsure order={order} unsure={unsure} act={act} /><Tray order={order} tray={tray} act={act} /></>}
        {tab === "conflicts" && <Conflicts order={order} act={act} />}
        {tab === "briefing" && <BriefingView order={order} act={act} />}
        {tab === "checks" && <Checks order={order} />}
      </div>
    </section>
  );
}

type Act = (p: Promise<unknown>) => void;

function Said({ order, f }: { order: OrderState; f: Fragment }) {
  const s = order.signals[f.signalId];
  return <span className="mono muted said" title={s ? `Signal #${f.signalId} (${s.source}):\n${s.text}` : ""}>said {when(s?.ts ?? f.ts)} · signal #{f.signalId}</span>;
}

function CanonView({ order, nodeId, onSelect, act }: { order: OrderState; nodeId: number | null; onSelect: (id: number | null) => void; act: Act }) {
  const [title, setTitle] = useState("");
  if (nodeId == null) return <div className="empty">No projects yet. Type "Project: name" to the Assistant, or anything at all: the Archivist opens one when it needs to.</div>;
  const byId = new Map(order.nodes.map((n) => [n.id, n]));
  const line: number[] = [];
  for (let n = byId.get(nodeId); n; n = n.parentId != null ? byId.get(n.parentId) : undefined) line.unshift(n.id);
  const node = byId.get(nodeId)!;
  const entries = (order.canon[nodeId] ?? []).map((c) => ({ ...c, f: order.fragments.find((f) => f.id === c.id)! })).filter((e) => e.f);
  const ghosts = order.fragments.filter((f) => f.state === "superseded" && f.nodeId != null && line.includes(f.nodeId) && (f.kind === "rule" || f.kind === "decision"));
  const pts = [...entries.map((e) => ({ f: e.f, own: e.inheritedFrom == null, ghost: false })), ...ghosts.map((f) => ({ f, own: false, ghost: true }))];
  const pos = new Map(pts.map((p, i) => {
    const a = (i / Math.max(1, pts.length)) * Math.PI * 2 - Math.PI / 2;
    return [p.f.id, { x: 160 + Math.cos(a) * 130 * (0.75 + (p.f.id % 5) * 0.06), y: 70 + Math.sin(a) * 52 * (0.8 + (p.f.id % 3) * 0.1) }];
  }));
  const links = order.conflicts.filter((c) => pos.has(c.a) && pos.has(c.b));
  const kids = order.nodes.filter((n) => n.parentId === nodeId && n.mergedInto == null);
  const counts = order.fragments.filter((f) => f.nodeId === nodeId && f.state === "live").reduce<Record<string, number>>((m, f) => ((m[f.kind] = (m[f.kind] ?? 0) + 1), m), {});
  const add = (e: FormEvent) => { e.preventDefault(); if (title.trim()) act(orderApi.createNode("idea", title.trim(), nodeId).then(() => setTitle(""))); };
  return (
    <div className="canon">
      <div className="crumbs">
        {line.map((id, i) => <span key={id}>{i > 0 && <span className="muted"> ▸ </span>}<button className="link" onClick={() => onSelect(id)}>{byId.get(id)?.title}</button></span>)}
        <span className="muted mono"> · {node.kind} · {Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(", ") || "empty"}</span>
      </div>
      <svg viewBox="0 0 320 140" className="constellation" role="img" aria-label={`Project rules constellation of ${node.title}`}>
        {pts.length > 1 && pts.map((p, i) => {
          const a = pos.get(p.f.id)!, b = pos.get(pts[(i + 1) % pts.length].f.id)!;
          return p.ghost ? null : <line key={"l" + p.f.id} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="c-line" />;
        })}
        {links.map((c) => { const a = pos.get(c.a)!, b = pos.get(c.b)!; return <line key={"x" + c.id} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className={c.status === "open" ? "c-conflict" : "c-resolved"}><title>{c.reason}</title></line>; })}
        {pts.map((p) => { const q = pos.get(p.f.id)!; return (
          <g key={p.f.id} className={`c-star${p.own ? " own" : ""}${p.ghost ? " ghost" : ""}${p.f.important || p.f.pinned ? " marked" : ""}`}>
            <circle cx={q.x} cy={q.y} r={p.own ? 4 : 2.6} /><title>{p.f.text}</title>
          </g>); })}
        {!pts.length && <text x="160" y="74" className="c-empty">No rules or decisions here yet</text>}
      </svg>
      <ul className="rules">
        {entries.map((e) => (
          <li key={e.f.id} className={e.inheritedFrom == null ? "own" : "inherited"}>
            <span className={`kind k-${e.f.kind}`}>{e.f.kind}</span>
            <span className="rule-text">{e.f.text}</span>
            <span className="rule-meta">
              {e.inheritedFrom != null && <span className="muted">from {byId.get(e.inheritedFrom)?.title} · </span>}
              <Said order={order} f={e.f} />
              {e.f.origin === "inferred" && <span className="muted"> · inferred</span>}
              <button className="ghost tiny" onClick={() => act(orderApi.pin(e.f.id, !e.f.pinned))}>{e.f.pinned ? "unpin" : "pin"}</button>
            </span>
          </li>
        ))}
        {ghosts.map((f) => (
          <li key={f.id} className="ghost-rule">
            <span className="kind">replaced</span><span className="rule-text">{f.text}</span>
            <span className="rule-meta muted">by “{order.fragments.find((x) => x.id === f.supersededBy)?.text.slice(0, 60)}” · <Said order={order} f={f} /></span>
          </li>
        ))}
      </ul>
      <div className="kids">
        {kids.map((k) => <button key={k.id} className="ghost tiny" onClick={() => onSelect(k.id)}>{k.kind}: {k.title}</button>)}
        <form onSubmit={add} className="add-idea"><input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="new idea under this node" aria-label="New idea title" /><button className="ghost tiny" disabled={!title.trim()}>add</button></form>
      </div>
    </div>
  );
}

/** Below this the filer was guessing: the placement shows as unsure. Moving or confirming makes it 100%. */
const UNSURE_BELOW = 0.7;

function Unsure({ order, unsure, act }: { order: OrderState; unsure: Fragment[]; act: Act }) {
  if (!unsure.length) return null;
  const title = (id: number | null) => { const n = order.nodes.find((x) => x.id === id); return n ? n.title : "?"; };
  const live = order.nodes.filter((n) => n.mergedInto == null);
  return (
    <div className="unsure">
      <div className="muted b-sub">Filed on a guess. One tap confirms the place or moves it.</div>
      <ul className="tray">
        {unsure.map((f) => (
          <li key={f.id} className="unsure-row">
            <span className={`kind k-${f.kind}`}>{f.kind}</span>
            <span className="rule-text">{f.text}</span>
            <span className="rule-meta">
              <span className="muted">under <b>{title(f.nodeId)}</b> · {Math.round(f.confidence * 100)}% sure · </span><Said order={order} f={f} />
              <button className="ghost tiny" title="This is the right place" onClick={() => act(orderApi.move(f.id, f.nodeId))}>✓ right</button>
              {(f.alternatives ?? []).map((a) => <button key={a} className="tiny" onClick={() => act(orderApi.move(f.id, a))}>→ {title(a)}</button>)}
              <select value="" onChange={(e) => e.target.value && act(orderApi.move(f.id, e.target.value === "none" ? null : Number(e.target.value)))} aria-label="Move to">
                <option value="">elsewhere…</option>
                <option value="none">Loose ideas</option>
                {live.filter((n) => n.id !== f.nodeId).map((n) => <option key={n.id} value={n.id}>{n.kind}: {n.title}</option>)}
              </select>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Tray({ order, tray, act }: { order: OrderState; tray: Fragment[]; act: Act }) {
  const live = order.nodes.filter((n) => n.mergedInto == null);
  if (!tray.length) return <div className="empty">No loose ideas. When the Archivist is not sure where something goes, it lands here instead of blocking you.</div>;
  return (
    <ul className="tray">
      {tray.map((f) => (
        <li key={f.id}>
          <span className={`kind k-${f.kind}`}>{f.kind}</span>
          <span className="rule-text">{f.text}</span>
          <span className="rule-meta">
            <span className="muted">{Math.round(f.confidence * 100)}% sure · </span><Said order={order} f={f} />
            <select value="" onChange={(e) => e.target.value && act(orderApi.move(f.id, Number(e.target.value)))} aria-label="File under">
              <option value="">file under…</option>
              {f.suggestedNodeId != null && <option value={f.suggestedNodeId}>★ {order.nodes.find((n) => n.id === f.suggestedNodeId)?.title}</option>}
              {live.map((n) => <option key={n.id} value={n.id}>{n.kind}: {n.title}</option>)}
            </select>
          </span>
        </li>
      ))}
    </ul>
  );
}

function Conflicts({ order, act }: { order: OrderState; act: Act }) {
  const frag = (id: number) => order.fragments.find((f) => f.id === id);
  const card = (c: Conflict) => {
    const a = frag(c.a), b = frag(c.b);
    if (!a || !b) return null;
    const side = (f: Fragment) => (
      <div className={`c-side${c.winner === f.id ? " won" : c.loser === f.id ? " lost" : ""}${c.proposal?.winner === f.id ? " proposed" : ""}`}>
        <div className="rule-text">{f.text}</div>
        <div className="rule-meta"><Said order={order} f={f} />{f.important || f.pinned ? <span className="muted"> · marked</span> : null}</div>
        <button className={c.status === "open" ? "" : "ghost tiny"} onClick={() => act(orderApi.resolve(c.id, f.id))}>{c.status === "open" ? "Keep this" : c.winner === f.id ? "kept" : "keep this instead"}</button>
      </div>
    );
    return (
      <li key={c.id} className={`conflict-card ${c.status}`}>
        <div className="c-head"><span className="mono">#{c.id}</span> {c.reason} <span className="muted">· found by {c.detectedBy}</span>
          {c.status === "resolved" && <span className="c-rule">{RULE_NAMES[c.rule ?? ""] ?? c.rule}{c.by === "engine" ? " (automatic)" : ""}</span>}
        </div>
        <div className="c-pair">{side(a)}<span className="c-vs">vs</span>{side(b)}</div>
        {c.status === "open" && c.proposal && <div className="muted c-prop">{c.proposal.why}</div>}
      </li>
    );
  };
  if (!order.conflicts.length) return <div className="empty">No conflicts. Each new rule is checked against the project rules of its node, its parents and its children.</div>;
  return <ul className="conflicts">{[...order.conflicts].sort((x, y) => (x.status === y.status ? y.id - x.id : x.status === "open" ? -1 : 1)).map(card)}</ul>;
}

function BriefingView({ order, act }: { order: OrderState; act: Act }) {
  const last = order.briefings.at(-1);
  const actions = order.sweeps.filter((s) => !s.undone).slice(-30).reverse();
  const merged = new Set(order.sweeps.filter((s) => s.action === "merge" && !s.undone).map((s) => `${s.nodeId}:${s.intoNodeId}`));
  const title = (id?: number) => order.nodes.find((n) => n.id === id)?.title ?? "";
  const frag = (id?: number) => order.fragments.find((f) => f.id === id)?.text ?? "";
  return (
    <div className="briefing">
      <div className="b-head">
        <span>{last ? `Briefing of ${when(last.ts)}` : "No briefing yet."}</span>
        <button className="ghost tiny" onClick={() => act(orderApi.sweep())}>Run the sweep now</button>
      </div>
      {last && <ul className="b-lines">{last.lines.map((l, i) => <li key={i} className={`b-${l.kind}`}><span className="kind">{l.kind}</span>{l.text}</li>)}</ul>}
      {!!actions.length && <div className="muted b-sub">Sweep actions, newest first. Every one can be undone; nothing is ever deleted.</div>}
      <ul className="sweeps">
        {actions.map((s) => (
          <li key={s.id}>
            <span className={`kind s-${s.action}`}>{s.action}</span>
            <span className="rule-text">
              {s.action === "digest" ? <><b>{title(s.nodeId)}</b><pre className="digest">{s.summary}</pre></> :
                s.action === "merge-proposal" || s.action === "merge" ? <>{title(s.nodeId)} → {title(s.intoNodeId)} <span className="muted">· {s.reason}</span></> :
                  <>{frag(s.fragmentId).slice(0, 120)} <span className="muted">· {s.reason}</span></>}
            </span>
            <span className="rule-meta">
              {s.action === "merge-proposal" && !merged.has(`${s.nodeId}:${s.intoNodeId}`) && <button className="tiny" onClick={() => act(orderApi.acceptMerge(s.id))}>merge</button>}
              {s.action !== "merge-proposal" && <button className="ghost tiny" onClick={() => act(orderApi.undo(s.id))}>undo</button>}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Checks({ order }: { order: OrderState }) {
  if (!order.visuals.length) return <div className="empty">Every note the Order Engine files gets a visualizeEverything check here.</div>;
  const ingest = new Map(order.ingests.map((r) => [r.signalId, r]));
  return (
    <ul className="visuals">
      {[...order.visuals].reverse().slice(0, 60).map((v) => {
        const r = v.signalId != null ? ingest.get(v.signalId) : undefined;
        return (
          <li key={v.id} className={v.pass ? "pass" : "fail"}>
            <span className="mono">{v.pass ? "PASS" : "MISSING"} · {v.signalId != null ? `signal #${v.signalId}` : v.scope}</span>
            <span>
              {[...v.items.map((i) => "✓ " + i), ...v.missing.map((m) => "✗ " + m)].join("  ·  ")}
              {r && <span className="muted"> · filed by {r.mode}{r.costUsd ? ` for $${r.costUsd.toFixed(4)}` : ""}{r.note ? ` · ${r.note}` : ""}</span>}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

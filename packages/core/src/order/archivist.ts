import type { FragmentKind, NodeKind, OrderState } from "./model.js";
import { isCanonKind } from "./model.js";
import { coverage, emphasized, similarity, splitSentences, titleOf, tokens } from "./text.js";
import { parseJsonBlock } from "../factory/workspace.js";

/**
 * The Archivist proposes; the engine decides. A proposal says how to cut a
 * Signal into Fragments, what each one is, and where it goes. The engine then
 * checks the proposal, files it, runs the conflict check in plain code and
 * draws it. Two Archivists share this format: a free heuristic one (rules of
 * thumb, no model) and the agent one (Haiku, lean profile, capped).
 */
export interface ProposedNode { ref: string; kind: NodeKind; title: string; parent: number | string | null }
export interface ProposedFragment {
  text: string;
  kind: FragmentKind;
  important: boolean;
  /** An existing node id, a ref of a proposed node, or null for Unsorted. */
  node: number | string | null;
  confidence: number;
  /** Ids of Canon fragments this one contradicts or replaces. */
  contradicts: number[];
  /** Other homes that scored nearly as well, best first (in other projects): offered as one-tap refiles. */
  alternatives?: number[];
}
export interface ArchivistPlan { nodes: ProposedNode[]; fragments: ProposedFragment[] }

export const FILE_AT = 0.5;
const KINDS: FragmentKind[] = ["idea", "rule", "decision", "question", "task", "note", "noise"];

/** Rules of thumb for a Fragment's kind. */
export function classify(text: string): FragmentKind {
  const t = text.trim();
  const words = tokens(t);
  const chat = (t.toLowerCase().match(/[a-z']+/g) ?? []);
  if (!words.length || (chat.length <= 4 && chat.every((w) => NOISE.test(w)))) return "noise";
  if (/\?\s*$/.test(t)) return "question";
  if (/\b(decided|decision|we('ll| will) (go with|use)|let'?s go with|chose|chosen|picked|repo name|the stack is|is locked|final answer)\b/i.test(t)) return "decision";
  if (/\b(must|never|always|should|shall|has to|have to|needs? to (be|have)|need to have|only|may|allowed|not allowed|everything should|is required|forbidden|do not|don'?t)\b/i.test(t)) return "rule";
  if (/^(please |pls )?(create|pull|clone|add|fix|build|set up|setup|install|write|make sure|check|move|rename|delete|run|push|merge)\b/i.test(t) || /\b(todo|to-do|action item)\b/i.test(t)) return "task";
  if (/\b(idea|what if|maybe|how about|i was thinking|thinking about|could we|we could|imagine|wouldn'?t it be)\b/i.test(t)) return "idea";
  return "note";
}

const NOISE = /^(ok(ay)?|k|thanks?|thank|you|thx|lol|haha+|h+m+|u+m+|cool|nice|great|hi|hello|hey|yes|yeah|yep|no|nope|sure|got|it|good|awesome|wow|oh|ah)$/;

const PREFIX = /^(project|idea|thread|topic)\s*[:\-]\s*(.+)$/i;

/**
 * The free Archivist: plain heuristics over the node tree. Same input, same answer.
 * `home`: the root node of the project whose chat the message was said in; words with no
 * clearer home go there instead of to the Unsorted tray.
 */
export function heuristicArchivist(text: string, state: OrderState, home?: number | null): ArchivistPlan {
  const plan: ArchivistPlan = { nodes: [], fragments: [] };
  const live = state.nodes.filter((n) => n.mergedInto == null);
  if (home != null && !live.some((n) => n.id === home)) home = null;
  // Vocabulary of each node: its title (counted twice) and its live fragments.
  const vocab = new Map<number, Set<string>>();
  for (const n of live) vocab.set(n.id, new Set(tokens(n.title)));
  for (const f of state.fragments) if (f.nodeId != null && f.state === "live" && f.kind !== "noise") for (const t of tokens(f.text)) vocab.get(f.nodeId)?.add(t);
  // Rare words say more than common ones.
  const df = new Map<string, number>();
  for (const v of vocab.values()) for (const t of v) df.set(t, (df.get(t) ?? 0) + 1);
  const idf = (t: string) => Math.log(1 + live.length / (df.get(t) ?? live.length));
  const depthOf = (id: number) => { let d = 0, n = live.find((x) => x.id === id); while (n?.parentId != null) { d++; n = live.find((x) => x.id === n!.parentId); } return d; };

  const focus = (): number | string | null => {
    const ps = live.filter((n) => n.kind === "project").sort((a, b) => b.lastActive.localeCompare(a.lastActive));
    const proposed = plan.nodes.find((n) => n.kind === "project");
    return proposed?.ref ?? home ?? ps[0]?.id ?? null;
  };

  let current: number | string | null = null; // a node opened earlier in this same Signal
  let lastFiled: number | null = null; // where this Signal's previous fragment went
  for (const piece of splitSentences(text)) {
    const m = piece.match(PREFIX);
    if (m) {
      const kind = m[1].toLowerCase() === "project" ? "project" : m[1].toLowerCase() === "thread" ? "thread" : "idea";
      const title = titleOf(m[2], 6);
      const same = live.find((n) => similarity(n.title, title) >= 0.6 && n.kind === kind);
      if (same) { current = same.id; }
      else {
        const ref = `new${plan.nodes.length + 1}`;
        plan.nodes.push({ ref, kind, title, parent: kind === "project" ? null : (current ?? focus()) });
        current = ref;
      }
      const body = m[2].trim();
      if (tokens(body).length > 6) plan.fragments.push(fragmentFor(body, current));
      continue;
    }
    const f = fragmentFor(piece, null);
    if (typeof f.node === "number" && f.confidence >= FILE_AT) lastFiled = f.node;
    plan.fragments.push(f);
  }
  return plan;

  function fragmentFor(piece: string, forced: number | string | null): ProposedFragment {
    const kind = classify(piece);
    const important = emphasized(piece);
    const contradicts: number[] = [];
    if (kind === "noise") return { text: piece, kind, important: false, node: null, confidence: 0.9, contradicts };
    if (forced != null) return { text: piece, kind, important, node: forced, confidence: 0.9, contradicts };
    const ts = [...new Set(tokens(piece))];
    const scored: { id: number; score: number }[] = [];
    for (const n of live) {
      const v = vocab.get(n.id)!;
      const weight = ts.reduce((s, t) => s + idf(t), 0) || 1;
      const hit = ts.filter((t) => v.has(t)).reduce((s, t) => s + idf(t), 0) / weight;
      const titleHit = coverage(tokens(n.title), new Set(ts));
      scored.push({ id: n.id, score: hit * 0.7 + titleHit * 0.5 + depthOf(n.id) * 0.03 });
    }
    scored.sort((a, b) => b.score - a.score);
    const best = scored[0] ?? null;
    // The best home in each *other* project: a close runner-up there means the filer is guessing.
    const projectOf = (id: number) => { let n = live.find((x) => x.id === id); while (n?.parentId != null) n = live.find((x) => x.id === n!.parentId); return n?.id ?? id; };
    const rivals = (home: number | null) => {
      const seen = new Set<number>(home != null ? [projectOf(home)] : []);
      const out: { id: number; score: number }[] = [];
      for (const c of scored) { const p = projectOf(c.id); if (seen.has(p) || c.score < 0.15) continue; seen.add(p); out.push(c); }
      return out.slice(0, 2);
    };
    const projects = live.filter((n) => n.kind === "project");
    const alternativesFor = (home: number | null) => rivals(home).map((c) => c.id);
    if (current != null) return { text: piece, kind, important, node: current, confidence: 0.7, contradicts };
    if (best && best.score >= 0.35) {
      const rival = rivals(best.id)[0];
      // Nearly as good a match in another project: file it, but say it is a guess and offer the other one.
      const close = rival && best.score - rival.score < 0.12;
      return { text: piece, kind, important, node: best.id, confidence: close ? 0.55 : Math.min(0.95, 0.5 + best.score / 2), contradicts, alternatives: alternativesFor(best.id) };
    }
    // Said in the same breath as something already filed: it most likely belongs with it.
    if (lastFiled != null) return { text: piece, kind, important, node: lastFiled, confidence: 0.55, contradicts, alternatives: alternativesFor(lastFiled) };
    // Said in a project's own chat: that project is its home unless the words point elsewhere.
    if (home != null && kind !== "question") return { text: piece, kind, important, node: home, confidence: 0.6, contradicts, alternatives: alternativesFor(home) };
    const f = focus();
    // No words tie it anywhere. With one project that is still the obvious home; with several, the
    // most recently active one is only a guess, so it waits in Unsorted with that guess on top
    // instead of landing under the wrong project.
    const onlyHome = projects.length <= 1 || typeof f === "string";
    if (f != null && kind !== "question" && onlyHome) return { text: piece, kind, important, node: f, confidence: isCanonKind(kind) || kind === "idea" ? 0.55 : 0.45, contradicts };
    const guess = best && best.score > 0 ? best.id : f;
    return { text: piece, kind, important, node: guess ?? null, confidence: best ? Math.min(0.45, best.score) : 0.1, contradicts, alternatives: alternativesFor(typeof guess === "number" ? guess : null) };
  }
}

export const ARCHIVIST_ROLE = `You are the Archivist of SoftwareFactory. You keep order in a messy, branching conversation.
You get one new message from the person, the current node tree (projects > ideas > threads) and the closest existing rules (the Canon).
Cut the message into atomic fragments (one idea, rule, decision, question, task or note each; chit-chat is noise). Keep the person's own words; trim only filler.
For each fragment pick the best node by id. Open a new idea or thread node only when the fragment starts something that has no home yet; open a new project only when the person clearly names a new project.
Mark important when the wording says so (important, must, never, always) or it is a rule or decision that constrains future work.
List in "contradicts" the ids of Canon rules this fragment clashes with or replaces (same subject, incompatible content). Do not resolve anything yourself.
Answer with ONE fenced json block and nothing else, shaped exactly like:
{"nodes": [{"ref": "new1", "kind": "idea", "title": "Short title", "parent": 12}],
 "fragments": [{"text": "...", "kind": "rule", "important": true, "node": 12, "confidence": 0.8, "contradicts": [34]}]}
"parent" and "node" are an existing node id (number), a "ref" from your own "nodes" list, or null (a project has parent null; a fragment with node null goes to the Unsorted tray). kind is one of: ${KINDS.join(", ")}. confidence is 0 to 1; use below ${FILE_AT} when unsure.`;

/** What the agent Archivist sees: the message, the tree and the nearest Canon only, so the call stays small. */
export function archivistPrompt(text: string, state: OrderState, maxCanon = 25, home?: number | null): string {
  const live = state.nodes.filter((n) => n.mergedInto == null);
  const tree = live.length
    ? live.map((n) => `${n.id} ${n.kind} "${n.title}"${n.parentId != null ? ` parent ${n.parentId}` : ""}`).join("\n")
    : "(empty: open a project for this message if it names or implies one)";
  const canon = state.fragments
    .filter((f) => f.state === "live" && isCanonKind(f.kind) && f.nodeId != null)
    .map((f) => ({ f, s: similarity(f.text, text) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, maxCanon)
    .map(({ f }) => `${f.id} [node ${f.nodeId}] ${f.text.slice(0, 200)}`);
  const homeNode = home != null ? live.find((n) => n.id === home) : undefined;
  const said = homeNode ? `SAID IN THE CHAT OF PROJECT ${homeNode.id} "${homeNode.title}": file fragments under it (or its ideas and threads) unless they are clearly about another project.\n\n` : "";
  return `${said}NODE TREE (id kind "title" parent):\n${tree}\n\nNEAREST CANON (id [node] text):\n${canon.join("\n") || "(none yet)"}\n\nNEW MESSAGE:\n"""\n${text.slice(0, 6000)}\n"""`;
}

/** Check and normalise an agent's proposal. Throws when it is unusable. */
export function parseArchivistPlan(raw: string, state: OrderState): ArchivistPlan {
  const j = parseJsonBlock<any>(raw);
  if (!j || !Array.isArray(j.fragments)) throw new Error("The Archivist's answer has no fragments list");
  const ids = new Set(state.nodes.filter((n) => n.mergedInto == null).map((n) => n.id));
  const frIds = new Set(state.fragments.map((f) => f.id));
  const nodes: ProposedNode[] = [];
  const refs = new Set<string>();
  for (const n of Array.isArray(j.nodes) ? j.nodes : []) {
    const ref = String(n.ref ?? `new${nodes.length + 1}`);
    const kind: NodeKind = ["project", "idea", "thread"].includes(n.kind) ? n.kind : "idea";
    const title = String(n.title ?? "").trim().slice(0, 80);
    if (!title || refs.has(ref)) continue;
    const parent = asRef(n.parent);
    nodes.push({ ref, kind, title, parent: kind === "project" ? null : parent });
    refs.add(ref);
  }
  const fragments: ProposedFragment[] = [];
  for (const f of j.fragments) {
    const text = String(f.text ?? "").trim();
    if (!text) continue;
    const kind: FragmentKind = KINDS.includes(f.kind) ? f.kind : classify(text);
    const node = asRef(f.node);
    const confidence = Math.max(0, Math.min(1, Number(f.confidence ?? 0.5)));
    const contradicts = (Array.isArray(f.contradicts) ? f.contradicts : []).map(Number).filter((x: number) => frIds.has(x));
    fragments.push({ text: text.slice(0, 2000), kind, important: f.important === true || emphasized(text), node: kind === "noise" ? null : node, confidence, contradicts });
  }
  if (!fragments.length) throw new Error("The Archivist returned no usable fragments");
  return { nodes, fragments };

  function asRef(v: unknown): number | string | null {
    if (v == null || v === "") return null;
    if (typeof v === "string" && refs.has(v)) return v;
    const n = Number(v);
    return Number.isFinite(n) && ids.has(n) ? n : null;
  }
}

import type { SfEvent } from "../events.js";
import { engineReview, type EngineReview } from "./retro.js";
import { normIdea } from "./loop.js";

/**
 * Engine cycles: the same prompt given to the factory more than once. A benchmark run tests the ENGINE, not the
 * product it builds, so runs that share a prompt are laid side by side: which app version built each, what the
 * design loop and the product judge scored, what it cost, and the engine review (what the engine did badly and
 * well). Reading across the row shows whether an engine change helped. Computed from the log, with no agent call
 * and nothing written: a run that ended before reviews were logged gets its review worked out here.
 */
export interface CycleRun {
  run: number;
  cycle: number;
  startedAt: string;
  /** The installed app version when the run started; null when the log holds none (a dev core). */
  appVersion: string | null;
  /** "running" until the run ends. */
  outcome: string;
  reason: string;
  spentUsd: number;
  maxUsd: number;
  minutes: number;
  agentCalls: number;
  /** The design loop's best round: its scores and whether any round passed the Critic. */
  design: { rounds: number; passed: boolean; scores: Record<string, number> } | null;
  /** The product judge's last look. */
  judge: { looks: number; passed: boolean; scores: Record<string, number>; met: number; of: number } | null;
  /** Null while the run is still going. */
  review: EngineReview | null;
}
export interface EngineCycle { prompt: string; name: string; runs: CycleRun[] }

const total = (s: Record<string, number>) => Object.values(s).reduce((a, b) => a + (Number(b) || 0), 0);

export function engineCycles(events: SfEvent[]): EngineCycle[] {
  const starts = events.filter((e) => e.type === "factory.run.started");
  const groups = new Map<string, SfEvent[]>();
  for (const s of starts) {
    const idea = String((s.payload as { idea?: string }).idea ?? "");
    if (idea.trim().length < 12) continue;
    const k = normIdea(idea);
    groups.set(k, [...(groups.get(k) ?? []), s]);
  }
  const versions = events.filter((e) => e.type === "app.updated");
  const mine = new Map<number, SfEvent[]>();
  for (const e of events) {
    const p = e.payload as { run?: number; factoryRun?: number };
    const id = e.type === "factory.run.started" ? e.id : typeof p.run === "number" ? p.run : typeof p.factoryRun === "number" ? p.factoryRun : null;
    if (id != null) (mine.get(id) ?? mine.set(id, []).get(id)!).push(e);
  }
  const out: EngineCycle[] = [];
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const prompt = String((g[0].payload as { idea: string }).idea).trim();
    const runs = g.map((s, i): CycleRun => {
      const ev = mine.get(s.id) ?? [s];
      const of = <T = any>(type: string) => ev.filter((e) => e.type === type).map((e) => e.payload as T);
      const maxUsd = Number((s.payload as { maxUsd?: number }).maxUsd ?? 0);
      const calls = ev.filter((e) => e.type === "agent.run.completed" || e.type === "agent.run.failed");
      const spentUsd = calls.reduce((a, e) => a + (Number((e.payload as { costUsd?: number }).costUsd) || 0), 0);
      // A run can stop and be resumed: only the last word counts.
      const life = ev.filter((e) => e.type === "factory.run.finished" || e.type === "factory.run.resumed").at(-1);
      const fin = life?.type === "factory.run.finished" ? life.payload as { outcome: string; reason?: string } : null;
      const stored = of<EngineReview & { run: number }>("factory.retro").at(-1);
      const review = !fin ? null : stored && stored.outcome === fin.outcome ? stored : engineReview(ev, { outcome: fin.outcome, reason: fin.reason ?? "", spentUsd, maxUsd });
      const rounds = of<{ pass?: boolean; critique?: { scores?: Record<string, number> } }>("factory.discovery");
      const best = rounds.filter((r) => r.critique?.scores).sort((a, b) => total(b.critique!.scores!) - total(a.critique!.scores!))[0];
      const looks = of<{ pass?: boolean; skipped?: string; scores?: Record<string, number>; requirements?: { met?: boolean }[] }>("factory.evaluation").filter((x) => !x.skipped);
      const last = looks.at(-1);
      const end = ev.at(-1)!;
      return {
        run: s.id, cycle: i + 1, startedAt: s.ts,
        appVersion: (versions.filter((v) => v.id < s.id).at(-1)?.payload as { to?: string } | undefined)?.to ?? null,
        outcome: fin?.outcome ?? "running", reason: (fin?.reason ?? "").split("\n")[0],
        spentUsd: Number(spentUsd.toFixed(4)), maxUsd,
        minutes: review?.minutes ?? Math.round((Date.parse(end.ts) - Date.parse(s.ts)) / 60_000),
        agentCalls: calls.length,
        design: rounds.length ? { rounds: rounds.length, passed: rounds.some((r) => r.pass), scores: best?.critique?.scores ?? {} } : null,
        judge: last ? { looks: looks.length, passed: !!last.pass, scores: last.scores ?? {}, met: (last.requirements ?? []).filter((q) => q.met).length, of: (last.requirements ?? []).length } : null,
        review,
      };
    });
    out.push({ prompt, name: prompt.split(/[:.\n]/)[0].replace(/^build\s+/i, "").trim().slice(0, 60) || `Run ${g[0].id}`, runs });
  }
  // The benchmark with the most recent run first.
  return out.sort((a, b) => b.runs.at(-1)!.run - a.runs.at(-1)!.run);
}

import { decideGate, type FactoryRunView } from "./api";
import { GateBar } from "./ui/GateBar";

/** Plain names for each station, used in "Retrying …" and "… failed". */
export const STEP: Record<string, string> = { intake: "Intake", council: "Council", plan: "Plan", gateA: "Your OK on the plan", tests: "Acceptance tests", build: "Build", test: "Test", fix: "Fix", review: "Review", gateB: "Your OK on the build", ship: "Ship" };

/**
 * The approval bar for the gate a run waits at, wired to the core. The bar itself is the shared
 * GateBar (ui/GateBar.tsx). A failed step that fails again comes back as a new notice that says
 * which attempt it was and whether the error was the same, so a Retry never looks like it did nothing.
 */
export function GateActions({ run, compact, label = STEP }: { run: FactoryRunView; compact?: boolean; label?: Record<string, string> }) {
  const w = run.waiting!;
  const esc = w.gate === "escalation";
  const failed = w.kind === "retry" && w.station ? (label[w.station] ?? w.station) : undefined;
  return (
    <GateBar key={`${run.run}:${w.at}`} question={w.question} failed={failed} error={w.error} attempt={w.attempt ?? 1} same={w.same}
      yes={w.action ?? (esc ? "Retry" : "Approve")} kind={esc ? "escalation" : "approve"} compact={compact} fresh={(w.attempt ?? 1) > 1}
      onDecide={(approve, note) => decideGate(run.run, w.gate, approve, note)}
      explain={(m) => /not waiting/.test(m) ? "The run is no longer waiting here (the app may have restarted it). Look at the run for a Resume button." : m} />
  );
}

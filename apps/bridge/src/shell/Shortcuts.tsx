import { useEffect, useState } from "react";
import type { Route } from "../projects/router";

/**
 * Keys for the Foundry Glass shell. "g" then a letter goes somewhere; "?" shows this list.
 * Keys never fire while you type in a field.
 */
const GO: Record<string, { label: string; to: Route }> = {
  n: { label: "Needs you", to: { page: "needs" } },
  p: { label: "Projects", to: { page: "home" } },
  a: { label: "Agents", to: { page: "factory", view: "bay" } },
  f: { label: "Whole factory", to: { page: "factory", view: "factory" } },
  l: { label: "Finished apps (Library)", to: { page: "features" } },
  o: { label: "Add-ons", to: { page: "plugins" } },
  b: { label: "Brain", to: { page: "brain" } },
};

const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

export function useShortcuts(on: boolean, go: (r: Route) => void): [boolean, (v: boolean) => void] {
  const [help, setHelp] = useState(false);
  useEffect(() => {
    if (!on) return;
    let pending = 0;
    const k = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || typing(e.target)) return;
      if (e.key === "Escape") { setHelp(false); return; }
      if (e.key === "?") { e.preventDefault(); setHelp((h) => !h); return; }
      if (pending && Date.now() - pending < 1200 && GO[e.key]) { e.preventDefault(); pending = 0; setHelp(false); go(GO[e.key].to); return; }
      pending = e.key === "g" ? Date.now() : 0;
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [on]); // eslint-disable-line react-hooks/exhaustive-deps
  return [help, setHelp];
}

export function ShortcutSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  const rows: [string[], string][] = [
    [["Ctrl", "K"], "Helm: file an idea, build it, or go anywhere"],
    [["Ctrl", "Enter"], "In the helm: build what you typed"],
    [["Ctrl", "J"], "Show or hide the Assistant"],
    ...Object.entries(GO).map(([k, v]) => [["G", k.toUpperCase()], `Go to ${v.label}`] as [string[], string]),
    [["?"], "Show or hide this list"],
    [["Esc"], "Close"],
  ];
  return (
    <div className="helm-scrim" onClick={onClose}>
      <div className="helm keys" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" onClick={(e) => e.stopPropagation()}>
        <div className="keys-head"><h2>Keyboard shortcuts</h2><button className="ghost sm" onClick={onClose}>Close</button></div>
        <dl className="keys-list">
          {rows.map(([ks, what]) => <div key={what} className="keys-row"><dt>{ks.map((x, i) => <kbd key={i}>{x}</kbd>)}</dt><dd>{what}</dd></div>)}
        </dl>
      </div>
    </div>
  );
}

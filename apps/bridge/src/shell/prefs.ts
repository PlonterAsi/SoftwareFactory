import { useEffect, useState } from "react";

/**
 * Small per-computer view choices, kept in this browser's storage. Storage can be missing or
 * throw (private window, blocked site data), so every read and write falls back quietly.
 */
function read<T extends string>(key: string, fallback: T): T {
  try { return (localStorage.getItem(key) as T | null) ?? fallback; } catch { return fallback; }
}
function write(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* not kept; fine */ }
}

export function usePref<T extends string>(key: string, fallback: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => read(key, fallback));
  // Another window of the app (or the Systems switch) changed it.
  useEffect(() => {
    const on = (e: StorageEvent) => { if (e.key === key) setV(read(key, fallback)); };
    window.addEventListener("storage", on);
    return () => window.removeEventListener("storage", on);
  }, [key, fallback]);
  return [v, (next: T) => { write(key, next); setV(next); }];
}

/**
 * "foundry" is the Foundry Glass sidebar shell; "classic" is the old top bar, still one click away in
 * Systems, Layout. Foundry is the default: on a real PC (2026-11-12) the new layout sat behind an opt-in
 * nobody found, so every install kept showing the old top bar. A choice made in Systems is kept.
 */
export type Layout = "classic" | "foundry";
export const LAYOUT_KEY = "sf.layout";
export const DEFAULT_LAYOUT: Layout = "foundry";

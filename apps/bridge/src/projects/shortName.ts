/**
 * A short name for a project, for cards, the sidebar and headers. Many projects are named after
 * the idea that started them ("A word counter app with history of past counts"); the short name
 * keeps the thing ("Word counter app") and drops the article and the "with…/that…/for…" tail.
 * The full name stays as the subtitle and tooltip.
 */
const TAIL = /\s+(?:with|that|which|where|so|for|to|using|where|who|and then|including)\s+.*$|\s*[,:;(–—-]\s.*$/i;

export function shortName(name: string, max = 32): string {
  let s = name.trim().replace(/^(?:an?|the)\s+/i, "").replace(TAIL, "").trim();
  if (!s) s = name.trim();
  if (s.length > max) s = s.slice(0, max).replace(/\s+\S*$/, "") + "…";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

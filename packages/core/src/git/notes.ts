/**
 * Versions (SF behavior brief 4.4): merged tickets grouped into a version, with release notes written from
 * the tickets themselves (no agent, no cost), a tag, and a place on the project's version timeline.
 */
export interface VersionTicket { id: number; key: string; kind: string; title: string; source?: string | null; pr?: number | null }
export type Bump = "major" | "minor" | "patch";

/** v1.2.3 → [1, 2, 3]; anything else → null. */
export function parseVersion(tag: string): [number, number, number] | null {
  const m = String(tag ?? "").trim().match(/^v?(\d+)\.(\d+)\.(\d+)$/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** The highest of these tags, or null. */
export function highest(tags: string[]): [number, number, number] | null {
  return tags.map(parseVersion).filter((v): v is [number, number, number] => !!v).sort((a, b) => b[0] - a[0] || b[1] - a[1] || b[2] - a[2])[0] ?? null;
}

/** Only fixes: a patch. Anything new: a minor step. The first version is v0.1.0. */
export function suggestBump(tickets: VersionTicket[]): Bump {
  return tickets.length && tickets.every((t) => t.kind === "bug") ? "patch" : "minor";
}

export function nextVersion(last: [number, number, number] | null, bump: Bump): string {
  if (!last) return bump === "major" ? "v1.0.0" : bump === "patch" ? "v0.0.1" : "v0.1.0";
  const [a, b, c] = last;
  return bump === "major" ? `v${a + 1}.0.0` : bump === "minor" ? `v${a}.${b + 1}.0` : `v${a}.${b}.${c + 1}`;
}

const GROUPS: { title: string; has: (t: VersionTicket) => boolean }[] = [
  { title: "New", has: (t) => t.source !== "outside" && ["request", "idea", "plan"].includes(t.kind) },
  { title: "Fixed", has: (t) => t.source !== "outside" && t.kind === "bug" },
  { title: "Changed", has: (t) => t.source !== "outside" && !["request", "idea", "plan", "bug"].includes(t.kind) },
  { title: "Made outside SF", has: (t) => t.source === "outside" },
];

/** Release notes in Markdown, one line per ticket under New, Fixed, Changed and Made outside SF. */
export function releaseNotes(version: string, project: string, tickets: VersionTicket[], at = new Date().toISOString()): string {
  const out = [`# ${project} ${version}`, "", `${at.slice(0, 10)} · ${tickets.length} ticket${tickets.length === 1 ? "" : "s"}`];
  for (const g of GROUPS) {
    const rows = tickets.filter(g.has);
    if (!rows.length) continue;
    out.push("", `## ${g.title}`, ...rows.map((t) => `- ${t.title} (${t.key}${t.pr ? `, PR #${t.pr}` : ""})`));
  }
  return out.join("\n");
}

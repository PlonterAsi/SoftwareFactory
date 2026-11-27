import type { GitHub, GitHubRepo, Issue } from "../tickets/github.js";
import type { RecordLine, TheRecord } from "./record.js";
import { type TicketKind, openTicket } from "./ticketrun.js";

/**
 * GitHub in step, both ways (docs/fence.md, "GitHub issues").
 *
 * In: an open issue of the project becomes a ticket. Only the owner's own issues, and only with the label from
 * Settings: an issue is text from outside, and a ticket is worked by a run, so a stranger's issue never becomes one.
 * Out: a ticket opened here gets an issue on GitHub, when Settings say "both".
 * The link is one line in the record (`issue.linked`), so it is made once and survives a restart.
 */
export type IssuesMode = "off" | "in" | "both";

export interface IssueDeps { record: TheRecord; github: Pick<GitHub, "issues" | "createIssue" | "login" | "hasToken"> }
/** A ticket as the look at GitHub needs it. `untouched`: it waits and no run ever worked it. */
export interface IssueTicket { ticket: string; project: string | null; sentence: string; kind: string; removed: boolean; untouched: boolean }
export interface IssueSync { ok: boolean; why?: string; in: string[]; out: string[]; closed: string[]; skipped: number }

/** The mark SoftwareFactory leaves in an issue it opened, so a lost link is found again instead of made twice. */
export const markOf = (ticket: string) => `<!-- softwarefactory ticket ${ticket} -->`;
const MARK = /<!-- softwarefactory ticket (T\d+) -->/;

/** The links the record holds for one project: ticket to issue number. */
export function linksOf(lines: RecordLine[], project: string): Map<string, { number: number; url: string; direction: string }> {
  const m = new Map<string, { number: number; url: string; direction: string }>();
  for (const l of lines) if (l.kind === "issue.linked" && l.project === project && l.ticket) m.set(l.ticket, { number: Number((l.data as any).number), url: String((l.data as any).url ?? ""), direction: String((l.data as any).direction ?? "") });
  return m;
}

/** An issue as a ticket's words: the title, then the text, never longer than a ticket may be. */
export const wordsOf = (i: Pick<Issue, "title" | "body">) => `${i.title.trim()}${i.body.trim() ? `\n\n${i.body.replace(MARK, "").trim()}` : ""}`.slice(0, 3900).trim();

/**
 * One look at GitHub. `waiting` says which tickets may still be taken off the list when their issue was closed
 * (a ticket that was worked keeps its place). Never throws: what went wrong is said in `why`.
 */
export async function syncIssues(deps: IssueDeps, repo: GitHubRepo, o: { mode: IssuesMode; label: string; tickets: () => IssueTicket[] }): Promise<IssueSync> {
  const out: IssueSync = { ok: true, in: [], out: [], closed: [], skipped: 0 };
  if (o.mode === "off") return out;
  const { record, github } = deps;
  const project = `${repo.owner}/${repo.name}`;
  try {
    if (!github.hasToken()) return { ...out, ok: false, why: "This computer has no GitHub sign-in, so issues cannot be read." };
    const me = (await github.login())?.toLowerCase() ?? null;
    const issues = await github.issues(repo, o.label);
    const links = linksOf(record.all(), project);
    const byNumber = new Map([...links].map(([t, l]) => [l.number, t]));
    // A ticket opened from an issue whose link line was never written (SoftwareFactory died in between) is still
    // that issue's ticket: the link is written now, and no second ticket is opened.
    for (const l of record.all()) {
      const d = l.data as any;
      if (l.kind !== "ticket.opened" || l.project !== project || !l.ticket || d.from !== "github" || !Number.isInteger(d.issue) || byNumber.has(d.issue)) continue;
      const i = issues.find((x) => x.number === d.issue);
      record.append({ kind: "issue.linked", who: "SF itself", ticket: l.ticket, project, data: { number: d.issue, url: i?.url ?? "", direction: "in", found: true } });
      links.set(l.ticket, { number: d.issue, url: i?.url ?? "", direction: "in" }); byNumber.set(d.issue, l.ticket);
    }
    // Read again before every change: the queue may have started a ticket while GitHub was being asked.
    const fresh = () => o.tickets().filter((t) => t.project === project);
    const mine = fresh();
    for (const i of issues) {
      if (byNumber.has(i.number)) continue;
      // Only the owner's own issues: by the sign-in in use, or marked by GitHub as the owner of the project.
      const owners = i.association === "OWNER" || (!!me && i.author.toLowerCase() === me);
      if (!owners || i.state !== "open") { if (i.state === "open") out.skipped++; continue; }
      // An issue SoftwareFactory opened itself, whose link was lost before it was written: link it, do not copy it.
      const marked = MARK.exec(i.body)?.[1];
      if (marked && mine.some((t) => t.ticket === marked) && !links.has(marked)) {
        record.append({ kind: "issue.linked", who: "SF itself", ticket: marked, project, data: { number: i.number, url: i.url, direction: "out", found: true } });
        links.set(marked, { number: i.number, url: i.url, direction: "out" }); byNumber.set(i.number, marked);
        continue;
      }
      const words = wordsOf(i);
      if (!words) { out.skipped++; continue; }
      const kind: TicketKind = i.labels.some((l) => l.toLowerCase() === "bug") ? "bug" : "request";
      const ticket = openTicket(record, project, words, kind, { from: "github", issue: i.number });
      record.append({ kind: "issue.linked", who: "SF itself", ticket, project, data: { number: i.number, url: i.url, direction: "in" } });
      byNumber.set(i.number, ticket); links.set(ticket, { number: i.number, url: i.url, direction: "in" });
      out.in.push(ticket);
    }
    // Closed on GitHub while the ticket still waits here: it leaves the list (the record keeps it; it can be put back).
    // Once per issue: a ticket you put back stays, though its issue is still closed.
    const tookOff = new Set(record.all().filter((l) => l.kind === "ticket.removed" && l.project === project && (l.data as any).from === "github").map((l) => `${l.ticket} ${(l.data as any).issue}`));
    for (const i of issues) {
      const t = i.state === "closed" ? fresh().find((x) => x.ticket === byNumber.get(i.number)) : undefined;
      if (t && t.untouched && !t.removed && !tookOff.has(`${t.ticket} ${i.number}`)) { record.append({ kind: "ticket.removed", who: "SF itself", ticket: t.ticket, project, data: { from: "github", issue: i.number, why: `issue #${i.number} was closed on GitHub` } }); out.closed.push(t.ticket); }
    }
    if (o.mode === "both") {
      for (const name of fresh().map((x) => x.ticket)) {
        const t = fresh().find((x) => x.ticket === name);
        if (!t) continue;
        // Only a ticket that still waits gets an issue: switching this on never fills GitHub with issues for old tickets.
        if (links.has(t.ticket) || t.removed || !t.untouched || out.in.includes(t.ticket)) continue;
        const first = t.sentence.trim().split("\n")[0]!.slice(0, 120);
        const made = await github.createIssue(repo, { title: first, body: `${t.sentence.trim()}\n\nOpened in SoftwareFactory as ticket ${t.ticket}.\n${markOf(t.ticket)}`, labels: [o.label, ...(t.kind === "bug" ? ["bug"] : [])].filter(Boolean) });
        record.append({ kind: "issue.linked", who: "SF itself", ticket: t.ticket, project, data: { number: made.number, url: made.url, direction: "out" } });
        links.set(t.ticket, { number: made.number, url: made.url, direction: "out" });
        out.out.push(t.ticket);
      }
    }
    return out;
  } catch (e) { return { ...out, ok: false, why: String((e as Error)?.message ?? e).slice(0, 200) }; }
}

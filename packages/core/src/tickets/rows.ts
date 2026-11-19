/** How a ticket row is read: the one select every read goes through, and the row → view mapping. Internal to tickets/. */
import { keyText, type TicketView } from "./model.js";

export type Row = Record<string, any>;
export const pri = (p: string | null) => ({ now: 0, this_week: 1, next: 2, someday: 3 } as Record<string, number>)[p ?? ""] ?? 4;

/**
 * Every read of a ticket goes through this select: the row, its project's key,
 * its parent's kind (for its level), whether an open ticket blocks it (one whose pull request merged no
 * longer does: its work is on the main line, though a request stays built for your look), and how
 * many of its children are done. Columns of the ticket itself are `t.`.
 */
export const SELECT = `SELECT t.*, k.key AS project_key, p.kind AS parent_kind,
  EXISTS (SELECT 1 FROM ticket_links l JOIN tickets b ON b.id = l.from_id
          WHERE l.to_id = t.id AND l.relation = 'blocks' AND b.status NOT IN ('closed', 'rejected') AND coalesce(b.pr_state, '') != 'merged') AS is_blocked,
  (SELECT count(*) FROM tickets c WHERE c.parent_id = t.id) AS n_children,
  (SELECT count(*) FROM tickets c WHERE c.parent_id = t.id AND c.status IN ('built', 'closed', 'rejected')) AS n_done
  FROM tickets t LEFT JOIN ticket_keys k ON k.project = t.project LEFT JOIN tickets p ON p.id = t.parent_id`;

export const toView = (r: Row): TicketView => ({
  id: Number(r.id), key: keyText(r.project_key ?? null, r.number == null ? null : Number(r.number), Number(r.id)), number: r.number == null ? null : Number(r.number),
  level: r.kind === "plan" ? "epic" : r.parent_id == null || r.parent_kind === "plan" ? "ticket" : "subtask",
  blocked: !!r.is_blocked, children: { total: Number(r.n_children ?? 0), done: Number(r.n_done ?? 0) }, kind: r.kind, title: r.title, body: r.body ?? "", answers: JSON.parse(r.answers ?? "{}"), project: r.project == null ? null : Number(r.project),
  status: r.status, priority: r.priority ?? null, severity: r.severity ?? null, size: r.size ?? null, flow: r.flow ?? null, assignee: r.assignee ?? null, parentId: r.parent_id == null ? null : Number(r.parent_id),
  lineOrder: r.line_order == null ? null : Number(r.line_order), tags: JSON.parse(r.tags ?? "[]"), source: r.source, openedBy: r.opened_by, fingerprint: r.fingerprint ?? null,
  run: r.run == null ? null : Number(r.run), branch: r.branch ?? null, branchDir: r.branch_dir ?? null, pushedUrl: r.pushed_url ?? null,
  pr: r.pr_number != null ? { repo: r.pr_repo, number: Number(r.pr_number), url: r.pr_url, state: r.pr_state } : null, createdAt: r.created_at, updatedAt: r.updated_at, closedAt: r.closed_at ?? null, lastNote: r.last_note ?? null,
});

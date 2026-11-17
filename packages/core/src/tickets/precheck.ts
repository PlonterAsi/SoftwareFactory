import { FORMS, type TicketView } from "./model.js";

/**
 * The check before money (SF behavior brief 2.5): before a ticket costs anything, SF reads it for three
 * things and sends what it finds to you in one batch, instead of finding out half way through a paid run.
 *
 *   clarity     could someone build it as written? (what it should do, what "done" looks like)
 *   confidence  is the ask settled? (open words like "maybe" and "something", too much for its flow)
 *   your call   decisions only you make: money, data that could be lost, secrets and accounts, going
 *               public, legal terms
 *
 * It is plain code over the ticket's words, free and instant, and says why it asks. Each question is
 * answered on the ticket (an answer under `check.<id>`), and a ticket whose questions are all answered goes.
 * You can always run anyway: the check advises, the caps still guard the money.
 */
export type CheckKind = "clarity" | "confidence" | "decision";
export interface CheckQuestion { id: string; kind: CheckKind; ask: string; why: string }
export interface TicketCheck { verdict: "go" | "ask"; questions: CheckQuestion[]; answered: number }

export const CHECK_WORD: Record<CheckKind, string> = { clarity: "Clarity", confidence: "Confidence", decision: "Your call" };

/** Words that mark a decision only the person makes, each with the question it raises. */
const YOUR_CALL: { id: string; re: RegExp; ask: string; why: string }[] = [
  { id: "money", re: /\b(pay(ment)?s?|pric(e|es|ing)|subscriptions?|billing|charg(e|es|ing)|purchases?|checkout|invoices?|refunds?|stripe|paypal)\b/i, ask: "This touches money. What may it charge or spend, and who approves a payment?", why: "it mentions payments or prices" },
  { id: "data", re: /\b(delet(e|es|ing)|drop(s|ping)? (the )?(table|database|column|data)|wip(e|es|ing)|purg(e|es|ing)|migrat(e|es|ion|ing)|remove all|truncat(e|es|ing))\b/i, ask: "This can remove or move data. Which data may it change, and is there a backup first?", why: "it can delete or migrate data" },
  { id: "secrets", re: /\b(passwords?|api[ -]?keys?|tokens?|secrets?|credentials?|private keys?|oauth|sign[- ]?in with)\b/i, ask: "This involves secrets or accounts. Where do they come from, and which may the crew use?", why: "it mentions passwords, keys or sign-in" },
  { id: "public", re: /\b(publish(es|ing)?|go(es)? live|production|deploy(s|ing|ment)?|release to|make (it )?public|app store|announce)\b/i, ask: "This goes out to people. Should it, and when?", why: "it would go public or to production" },
  { id: "legal", re: /\b(licen[cs](e|es|ing)|terms of (service|use)|privacy polic(y|ies)|gdpr|copyright|trademark)\b/i, ask: "This has legal weight. What terms or license do you want?", why: "it mentions licenses, terms or privacy" },
];

const OPEN_WORDS = /\b(maybe|perhaps|somehow|something|some kind of|etc|and so on|or so|whatever|tbd|not sure|either|probably)\b|\?\?/gi;

const words = (s: string) => s.split(/\s+/).filter((w) => /\w/.test(w)).length;

/** Read one ticket. `runner` is how its flow is carried out (a session flow is one Builder session). */
export function checkTicket(t: Pick<TicketView, "kind" | "title" | "body" | "answers" | "size">, o: { runner?: string } = {}): TicketCheck {
  const answers = t.answers ?? {};
  const told = [t.title, t.body, ...Object.entries(answers).filter(([k]) => !k.startsWith("check.")).map(([, v]) => v)].join("\n");
  const qs: CheckQuestion[] = [];
  const add = (q: CheckQuestion) => { if (!qs.some((x) => x.id === q.id)) qs.push(q); };

  // Clarity: enough words to build from, and the kind's own first question answered.
  if (t.kind !== "question") {
    if (words(told) < 8) add({ id: "what", kind: "clarity", ask: "What should it do, and how will you know it works? A sentence or two is enough.", why: `only ${words(told)} words so far` });
    const req = FORMS[t.kind as keyof typeof FORMS]?.find((q) => q.required);
    if (req && !String(answers[req.key] ?? "").trim() && words(t.body ?? "") < 12) add({ id: "form", kind: "clarity", ask: `${req.label}?`, why: `the ${t.kind} form's first question is empty` });
    if (t.kind === "bug" && !String(answers.expected ?? "").trim() && !/\b(expect|should|instead|supposed to)\b/i.test(told)) add({ id: "expected", kind: "clarity", ask: "What did you expect to happen instead?", why: "a bug fix needs to know what right looks like" });
  }

  // Confidence: the ask is settled, and it fits the flow it would take.
  const open = [...new Set((told.match(OPEN_WORDS) ?? []).map((w) => w.toLowerCase()))];
  if (open.length >= 2) add({ id: "open", kind: "confidence", ask: `Some of it is still open (${open.slice(0, 4).map((w) => `"${w}"`).join(", ")}). Which do you mean?`, why: "open words leave the crew guessing" });
  const asks = told.split("\n").filter((l) => /^\s*([-*•]|\d+[.)])\s+\S/.test(l)).length;
  if (o.runner === "session" && (t.size === "L" || asks >= 6)) add({ id: "size", kind: "confidence", ask: t.size === "L" ? "It is sized L but would go through one Builder session. Give it the Feature flow, or split it into tickets?" : `It lists ${asks} separate asks for one Builder session. Split it into tickets, or give it the Feature flow?`, why: "too much for one session" });

  // Your call: decisions only you make.
  for (const c of YOUR_CALL) if (c.re.test(told)) add({ id: c.id, kind: "decision", ask: c.ask, why: c.why });

  const answered = qs.filter((q) => String(answers[`check.${q.id}`] ?? "").trim()).length;
  const left = qs.filter((q) => !String(answers[`check.${q.id}`] ?? "").trim());
  return { verdict: left.length ? "ask" : "go", questions: left, answered };
}

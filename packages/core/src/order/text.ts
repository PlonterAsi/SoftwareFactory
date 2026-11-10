/**
 * Plain-code text helpers for the Order Engine: tokens, similarity, polarity.
 * No model calls, so they are free, fast and give the same answer every time.
 */

const STOP = new Set(
  ("a an the and or but if then so of to in on at for by with from into over under about as is are was were be been being am " +
    "i me my we us our you your he she it its they them their this that these those there here what which who whom whose " +
    "do does did doing done have has had having can could would will shall may might just also very really too more most " +
    "some any all each every no not nor only own same such than both few other again further once out up down off " +
    "let lets let's get got make made like think thinking want need maybe stuff thing things way ways etc one " +
    // Modal and cue words say how, not what; polarity and emphasis read them separately.
    "must should shall never always actually instead important really please ok so").split(/\s+/),
);

/** Lowercase content words with a light stem, stop words removed. */
export function tokens(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) ?? [])
    .map((w) => w.replace(/'s$/, "").replace(/^'+|'+$/g, ""))
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map(stem);
}

export function stem(w: string): string {
  if (w.length > 5 && w.endsWith("ing")) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith("ed")) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith("es") && !w.endsWith("ses")) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

/** Jaccard similarity of two token sets, 0..1. */
export function similarity(a: string | string[], b: string | string[]): number {
  const A = new Set(typeof a === "string" ? tokens(a) : a);
  const B = new Set(typeof b === "string" ? tokens(b) : b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

/** How much of `a`'s vocabulary appears in `b`, 0..1 (asymmetric overlap). */
export function coverage(a: string[], b: Set<string>): number {
  if (!a.length) return 0;
  return a.filter((t) => b.has(t)).length / a.length;
}

const NEG = /\b(never|not|no|don'?t|do not|doesn'?t|cannot|can'?t|mustn'?t|must not|shouldn'?t|should not|avoid|forbid|forbidden|disallow|won'?t|without)\b/i;

/** "never push" and "may push" have opposite polarity. */
export function polarity(text: string): 1 | -1 {
  return NEG.test(text) ? -1 : 1;
}

const REPLACE = /\b(instead of|instead|no longer|switch(ed)? to|change(d)? (it )?to|actually|scratch that|forget (that|what i said)|replace[sd]?|rather than|from now on)\b/i;

/** The person signals that this line replaces something said before. */
export function replacesCue(text: string): boolean {
  return REPLACE.test(text);
}

const EMPHASIS = /\b(important|importantly|must|never|always|critical|crucial|essential|required|mandatory|key point|remember)\b|!{2,}|\b[A-Z]{4,}\b/;

/** Marked as important by the words used: "important", "must", "never", shouting. */
export function emphasized(text: string): boolean {
  return EMPHASIS.test(text);
}

/** A short title from a sentence: its first few meaningful words. */
export function titleOf(text: string, words = 5): string {
  const clean = text.replace(/^(idea|project|thread|topic|note|rule|todo|task)\s*[:\-]\s*/i, "").replace(/[`*_#>]/g, "").trim()
    .replace(/^(a|an|the)\s+/i, "")
    // A title is the noun phrase: stop at the first clause ("where", "that", a comma).
    .split(/\s+(?:where|that|which|who|when|so|because|to|for|with|and)\s+|[,;:(]/i)[0];
  const ws = clean.split(/\s+/).slice(0, words).join(" ").replace(/[.,;:!?]+$/, "");
  return ws.charAt(0).toUpperCase() + ws.slice(1);
}

/** Split a message into sentence-sized pieces, keeping list items and lines apart. */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  for (const line of text.replace(/\r\n/g, "\n").split(/\n+/)) {
    const l = line.replace(/^\s*([-*•]|\d+[.)])\s+/, "").trim();
    if (!l) continue;
    // Break at sentence ends, but not after short abbreviations ("e.g.", "etc.").
    const parts = l.split(/(?<!\b(?:etc|e\.g|i\.e|vs|approx))(?<=[^.]{3}[.!?])\s+(?=["'“A-Za-z0-9])/).flatMap((x) => x.split(/(?<=[.!?])\s+(?=["'“A-Z0-9])/));
    for (const p of parts) {
      const t = p.trim();
      if (t) out.push(t);
    }
  }
  // Glue a lone lead-in ("Important,") onto the sentence after it.
  const glued: string[] = [];
  for (const p of out) {
    const prev = glued.at(-1);
    if (prev && tokens(prev).length <= 1 && /[,:]$/.test(prev)) glued[glued.length - 1] = `${prev} ${p}`;
    else glued.push(p);
  }
  return glued;
}

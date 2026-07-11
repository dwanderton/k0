/** Types + pure helpers shared by the call cockpit's hook and panels. */

export type Status = "idle" | "listening" | "denied" | "unsupported" | "unavailable";

/** knowledge scope — "customers" restricts retrieval to the posts in
 *  customers-manifest.json (vercel.com/blog/category/customers) */
export type KbMode = "all" | "customers";

/** finalized utterance — streams to the agent, except sys lines (mic
 *  errors), which render in the transcript only */
export interface Segment {
  id: number;
  at: string;
  text: string;
  sys?: boolean;
}

/** one customer story's build-time metadata — enriched offline into
 *  customers-manifest.json, never inferred live on a call */
export interface StoryRef {
  customer: string;
  industry: string;
  vercelProducts: string[];
  otherTech: string[];
  outcome: string;
  uri: string;
  score: number;
}

/** agent response in the DOC/ANSWER/QUOTE/ANCHOR/SOURCE format */
export interface Suggestion {
  id: number;
  heard: string;
  at: string;
  text: string;
  /** reasoning + tool trace for the per-card dropdown */
  debug: string[];
  /** customers mode: the 4 retrieved stories — primary gets the quote,
   *  the rest render as alternate proof-point rows */
  stories?: StoryRef[];
}

export interface TraceState {
  turn: number;
  lines: string[];
  outcome: "streaming" | "card" | "none" | "duplicate" | "failed";
}

export function clock() {
  return new Date().toLocaleTimeString("en-US", { hour12: false });
}

/** everything needed to reconstruct a live call after refresh/crash —
 *  watermarks persist atomically WITH the segments they describe */
export interface SessionSnapshot {
  /** schema version — a shape change must not silently break resume */
  v: number;
  sessionId: string;
  savedAt: number;
  segments: Segment[];
  cards: Suggestion[];
  consumed: number;
  lastCard: { id: number; start: number; doc: string } | null;
  /** optional — pre-mode snapshots resume as "all" */
  mode?: KbMode;
}

export const SNAP_VERSION = 1;
export const SNAP_PREFIX = "k0-session:";
export const SNAP_LATEST = "k0-session-latest";
const DEBUG_CAP = 40; // traces are chunky; localStorage is ~5MB

export function saveSnapshot(snap: SessionSnapshot) {
  const write = (s: SessionSnapshot) => {
    localStorage.setItem(SNAP_PREFIX + s.sessionId, JSON.stringify(s));
    localStorage.setItem(SNAP_LATEST, s.sessionId);
  };
  try {
    write({
      ...snap,
      cards: snap.cards.map((c) => ({ ...c, debug: c.debug.slice(0, DEBUG_CAP) })),
    });
  } catch {
    // quota — drop traces and retry once; restore degrades, live call unaffected
    try {
      write({ ...snap, cards: snap.cards.map((c) => ({ ...c, debug: [] })) });
    } catch {}
  }
}

export function loadLatestSnapshot(): SessionSnapshot | null {
  try {
    const latest = localStorage.getItem(SNAP_LATEST);
    const raw = latest && localStorage.getItem(SNAP_PREFIX + latest);
    if (!raw) return null;
    const snap = JSON.parse(raw) as SessionSnapshot;
    if (snap.v !== SNAP_VERSION) return null; // old shape — never resume it
    return snap.sessionId && snap.segments?.length ? snap : null;
  } catch {
    return null;
  }
}

/** common speech-recognition mishears, fixed before the transcript */
const TIDY_RULES: [RegExp, string][] = [
  [/\bthe cell\b/gi, "Vercel"],
  [/\bfor sales?\b/gi, "Vercel"],
  [/\bfor cells?\b/gi, "Vercel"],
  [/\bwill sell\b/gi, "Vercel"],
  [/\bwork clothes\b/gi, "workflows"],
  [/\bchrome task\b/gi, "cron task"],
  [/\bchromecast\b/gi, "cron task"],
  [/\bcrown\b/gi, "cron"],
  [/\bgerbil\b/gi, "durable"],
  [/\bcase components\b/gi, "Cache Components"],
  [/\bcash components\b/gi, "Cache Components"],
  [/\bnexus\b/gi, "Next.js"],
  [/\bnext ?js\b/gi, "Next.js"],
  [/\bnext year's\b/gi, "Next.js"],
  [/\bnext jazz\b/gi, "Next.js"],
  [/\bcasing strategies\b/gi, "caching strategies"],
  // narrow on purpose — bare "use case" is legit English (rule removed once)
  [/\buse case directive\b/gi, "use cache directive"],
];

export function tidyTranscript(text: string) {
  return TIDY_RULES.reduce((t, [re, sub]) => t.replace(re, sub), text);
}

/** stream interleaves NUL-prefixed \n-terminated debug lines and one
 *  SOH-prefixed stories frame with card text — peel apart */
export const NUL = "\u0000";
export const SOH = "\u0001";
export function splitStream(raw: string) {
  // stories frame: SOH + JSON + \n, sent once retrieval settles — before
  // the model's first token, so story slots can paint immediately
  let stories: StoryRef[] | undefined;
  const framed = raw.split(SOH);
  let rest = framed[0];
  for (let k = 1; k < framed.length; k++) {
    const nl = framed[k].indexOf("\n");
    if (nl === -1) continue; // frame still streaming — hold it
    try {
      stories = JSON.parse(framed[k].slice(0, nl)) as StoryRef[];
    } catch {
      // torn frame — card and debug still render
    }
    rest += framed[k].slice(nl + 1);
  }
  const debug: string[] = [];
  const parts = rest.split(NUL);
  let card = parts[0];
  for (let k = 1; k < parts.length; k++) {
    const nl = parts[k].indexOf("\n");
    if (nl === -1) continue; // debug line still streaming — hold it
    debug.push(parts[k].slice(0, nl));
    card += parts[k].slice(nl + 1);
  }
  return { card, debug, stories };
}

// hoisted — parseCard runs per stream chunk and per card render
const FIELD_RE = {
  DOC: /^DOC:\s*(.*)$/im,
  ANSWER: /^ANSWER:\s*(.*)$/im,
  QUOTE: /^QUOTE:\s*(.*)$/im,
  ANCHOR: /^ANCHOR:\s*(.*)$/im,
  SOURCE: /^SOURCE:\s*(.*)$/im,
} as const;
const BARE_NONE_RE = /^none$/i;
const DOC_LINE_RE = /^DOC:/im;

export function parseCard(text: string) {
  const field = (k: keyof typeof FIELD_RE) => {
    const v = text.match(FIELD_RE[k])?.[1]?.trim() ?? "";
    // half-refusal guard: model sometimes stuffs NONE into fields instead
    // of replying bare NONE — an all-NONE card must land as a NONE turn
    return BARE_NONE_RE.test(v) ? "" : v;
  };
  const answer = field("ANSWER");
  const quote = field("QUOTE");
  return {
    none:
      text.trim().toUpperCase().startsWith("NONE") ||
      (DOC_LINE_RE.test(text) && !answer && !quote),
    doc: field("DOC"),
    answer,
    quote,
    anchor: field("ANCHOR"),
    source: field("SOURCE"),
  };
}

/** fresh noopener window per click — the #:~:text= highlight fires only on
 *  cross-document navs with no opener; a reused named window re-navigates
 *  same-document and keeps window.opener, so the fragment silently skips */
export function openDocs(url: string) {
  window.open(url, "_blank", "noopener,width=1100,height=800");
}

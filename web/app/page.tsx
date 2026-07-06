"use client";

import { useEffect, useRef, useState } from "react";
import {
  isGladiaCapable,
  startGladiaLive,
  type GladiaHandle,
} from "@/lib/gladia-live";

type Status = "idle" | "listening" | "denied" | "unsupported" | "unavailable";

/** finalized utterance — streams to the agent, except sys lines (mic
 *  errors), which render in the transcript only */
interface Segment {
  id: number;
  at: string;
  text: string;
  sys?: boolean;
}

/** agent response in the DOC/ANSWER/QUOTE/ANCHOR/SOURCE format */
interface Suggestion {
  id: number;
  heard: string;
  at: string;
  text: string;
  /** reasoning + tool trace for the per-card dropdown */
  debug: string[];
}

function clock() {
  return new Date().toLocaleTimeString("en-US", { hour12: false });
}

/** everything needed to reconstruct a live call after refresh/crash —
 *  watermarks persist atomically WITH the segments they describe */
interface SessionSnapshot {
  sessionId: string;
  savedAt: number;
  segments: Segment[];
  cards: Suggestion[];
  consumed: number;
  lastCard: { id: number; start: number; doc: string } | null;
}

const SNAP_PREFIX = "k0-session:";
const SNAP_LATEST = "k0-session-latest";
const DEBUG_CAP = 40; // traces are chunky; localStorage is ~5MB

function saveSnapshot(snap: SessionSnapshot) {
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

function loadLatestSnapshot(): SessionSnapshot | null {
  try {
    const latest = localStorage.getItem(SNAP_LATEST);
    const raw = latest && localStorage.getItem(SNAP_PREFIX + latest);
    if (!raw) return null;
    const snap = JSON.parse(raw) as SessionSnapshot;
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

function tidyTranscript(text: string) {
  return TIDY_RULES.reduce((t, [re, sub]) => t.replace(re, sub), text);
}

/** stream interleaves NUL-prefixed \n-terminated debug lines with card
 *  text — peel apart */
const NUL = "\u0000";
function splitStream(raw: string) {
  const debug: string[] = [];
  const parts = raw.split(NUL);
  let card = parts[0];
  for (let k = 1; k < parts.length; k++) {
    const nl = parts[k].indexOf("\n");
    if (nl === -1) continue; // debug line still streaming — hold it
    debug.push(parts[k].slice(0, nl));
    card += parts[k].slice(nl + 1);
  }
  return { card, debug };
}

function parseCard(text: string) {
  const field = (k: string) => {
    const v = text.match(new RegExp(`^${k}:\\s*(.*)$`, "mi"))?.[1]?.trim() ?? "";
    // half-refusal guard: model sometimes stuffs NONE into fields instead
    // of replying bare NONE — an all-NONE card must land as a NONE turn
    return /^none$/i.test(v) ? "" : v;
  };
  const answer = field("ANSWER");
  const quote = field("QUOTE");
  return {
    none:
      text.trim().toUpperCase().startsWith("NONE") ||
      (/^DOC:/im.test(text) && !answer && !quote),
    doc: field("DOC"),
    answer,
    quote,
    anchor: field("ANCHOR"),
    source: field("SOURCE"),
  };
}

/** named target — every click top-level-navigates one reused window, so the
 *  #:~:text= fragment fires and the highlight lands */
function openDocs(url: string) {
  window.open(url, "k0Docs", "width=1100,height=800");
}

function OfflineBanner({ callLive }: { callLive: boolean }) {
  const [conn, setConn] = useState<"online" | "offline" | "reconnected">(
    "online",
  );

  useEffect(() => {
    if (!navigator.onLine) setConn("offline");
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = () => {
      if (timer) clearTimeout(timer);
      setConn("offline");
    };
    const on = () => {
      // green confirmation only after a real drop, then auto-dismiss
      setConn((c) => (c === "offline" ? "reconnected" : c));
      timer = setTimeout(() => setConn("online"), 4000);
    };
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  // presence outlives `conn` by one fade so dismissal animates out instead
  // of vanishing
  const [mounted, setMounted] = useState(false);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (conn === "online") {
      setShown(false);
      const t = setTimeout(() => setMounted(false), 300);
      return () => clearTimeout(t);
    }
    setMounted(true);
    // opacity flips a frame after mount so the fade-in transition runs
    const raf = requestAnimationFrame(() =>
      requestAnimationFrame(() => setShown(true)),
    );
    return () => cancelAnimationFrame(raf);
  }, [conn]);

  if (!mounted) return null;
  const offline = conn === "offline";

  return (
    <div
      role="status"
      aria-live="polite"
      className={`fixed inset-x-0 top-0 z-50 flex items-center justify-center gap-2 border-b bg-card px-3 py-2 text-sm font-semibold transition-all duration-300 motion-reduce:transition-none ${
        shown ? "opacity-100" : "opacity-0"
      } ${offline ? "border-error/30 text-error" : "border-live/30 text-live"}`}
    >
      <svg
        aria-hidden="true"
        className="h-4 w-4 shrink-0"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {offline ? (
          <>
            <line x1="2" x2="22" y1="2" y2="22" />
            <path d="M8.5 16.5a5 5 0 0 1 7 0" />
            <path d="M2 8.82a15 15 0 0 1 4.17-2.65" />
            <path d="M10.66 5c4.01-.36 8.14.9 11.34 3.76" />
            <path d="M16.85 11.25a10 10 0 0 1 2.22 1.68" />
            <path d="M5 13a10 10 0 0 1 5.24-2.76" />
            <line x1="12" x2="12.01" y1="20" y2="20" />
          </>
        ) : (
          <>
            <path d="M2 8.82a15 15 0 0 1 20 0" />
            <path d="M5 12.86a10 10 0 0 1 14 0" />
            <path d="M8.5 16.43a5 5 0 0 1 7 0" />
            <line x1="12" x2="12.01" y1="20" y2="20" />
          </>
        )}
      </svg>
      <span>
        {offline
          ? callLive
            ? "You're offline. k0 keeps your transcript — unanswered lines retry when the connection returns. Don't close this tab."
            : "You're offline."
          : "You are back online"}
      </span>
    </div>
  );
}

function SuggestionCard({ s }: { s: Suggestion }) {
  const p = parseCard(s.text);
  const quote = p.quote;
  const i = p.anchor ? quote.toLowerCase().indexOf(p.anchor.toLowerCase()) : -1;
  const marked =
    i < 0 ? (
      quote
    ) : (
      <>
        {quote.slice(0, i)}
        <mark className="rounded-[3px] bg-frag px-0.75 py-px text-frag-ink">
          {quote.slice(i, i + p.anchor.length)}
        </mark>
        {quote.slice(i + p.anchor.length)}
      </>
    );

  return (
    <div className="card-rise flex flex-col gap-2">
      <div className="font-mono text-[10px] font-semibold uppercase tracking-widest text-muted">
        Turn {s.id}
      </div>
      <div className="rounded-lg border border-accent bg-card px-3.5 py-3">
        <div className="mb-2 flex items-center justify-between gap-2 font-mono text-[11px] font-semibold text-muted">
          <span className="truncate">{p.doc || "searching docs…"}</span>
          <span className="tabular-nums">{s.at}</span>
        </div>
        {p.answer && <div className="mb-2 text-[14px]">{p.answer}</div>}
        {quote && (
          <div className="text-[15px]">
            {p.source ? (
              <a
                href={p.source}
                title="Open in Vercel docs"
                className="cursor-pointer no-underline hover:[&_mark]:bg-[#c2d9ff] hover:[&_mark]:underline hover:[&_mark]:underline-offset-2"
                onClick={(e) => {
                  e.preventDefault();
                  openDocs(p.source);
                }}
              >
                {marked}
              </a>
            ) : (
              marked
            )}
          </div>
        )}
        {s.debug.length > 0 && (
          <details className="group mt-3 border-t border-line pt-2">
            <summary className="flex cursor-pointer list-none items-center gap-1 font-mono text-[10px] font-semibold uppercase tracking-wider text-muted hover:text-ink">
              <span className="inline-block transition-transform group-open:rotate-90">
                ▸
              </span>
              how k0 answered · {s.debug.length} steps
            </summary>
            <div className="mt-2 border-l-2 border-line pl-2.5 text-[12px] text-muted">
              heard: &ldquo;{s.heard}&rdquo;
            </div>
            <div className="mt-2 flex flex-col gap-0.5 font-mono text-[10px] leading-relaxed text-[#b6b6be]">
              {s.debug.map((line, k) => (
                <div key={k} className="whitespace-pre-wrap wrap-break-word">
                  {line}
                </div>
              ))}
            </div>
          </details>
        )}
      </div>
    </div>
  );
}

export default function Home() {
  const [status, setStatus] = useState<Status>("idle");
  const [segments, setSegments] = useState<Segment[]>([]);
  const [interim, setInterim] = useState("");
  const [current, setCurrent] = useState<Suggestion | null>(null);
  const [cards, setCards] = useState<Suggestion[]>([]); // oldest → newest
  const [agentError, setAgentError] = useState(false);
  // latest query's trace — survives NONE and failures, where no card (and
  // no per-card dropdown) ever lands
  const [trace, setTrace] = useState<{
    turn: number;
    lines: string[];
    outcome: "streaming" | "card" | "none" | "duplicate" | "failed";
  } | null>(null);
  const [view, setView] = useState(0); // index of the card on screen
  const [following, setFollowing] = useState(true); // carousel keeps up with live
  const gladiaRef = useRef<GladiaHandle | null>(null);
  // per-tab session id (sessionStorage) — two tabs write two snapshot keys
  // instead of fighting over one
  const sessionIdRef = useRef("");
  const [resumeOffer, setResumeOffer] = useState<SessionSnapshot | null>(null);
  const activeRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  // several queries can run at once; only unmount aborts
  const inflightRef = useRef(new Set<AbortController>());
  const queriedRef = useRef(0);
  // segments answered (card or NONE) — never resent to the agent
  const consumedRef = useRef(0);
  // last card + the transcript span it answered — dedupes overlapping
  // concurrent turns that surface the same doc twice
  const lastCardRef = useRef<{ id: number; start: number; doc: string } | null>(
    null,
  );

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [segments, interim]);

  // following = ride the live edge: new card (or resume) snaps the carousel
  // to newest
  useEffect(() => {
    if (following) setView(Math.max(0, cards.length - 1));
  }, [cards.length, following]);

  useEffect(() => {
    return () => {
      activeRef.current = false;
      gladiaRef.current?.stop();
      inflightRef.current.forEach((c) => c.abort());
    };
  }, []);

  // session identity + resume offer, once per mount
  useEffect(() => {
    let sid = sessionStorage.getItem("k0-session-id");
    if (!sid) {
      sid = crypto.randomUUID();
      sessionStorage.setItem("k0-session-id", sid);
    }
    sessionIdRef.current = sid;
    setResumeOffer(loadLatestSnapshot());
  }, []);

  // write-through: every settle (segments, cards, or watermark movement via
  // trace outcome) persists one atomic snapshot
  const lastSavedRef = useRef<{ seg: unknown; cards: unknown }>({
    seg: null,
    cards: null,
  });
  useEffect(() => {
    if (!sessionIdRef.current) return;
    if (segments.length === 0 && cards.length === 0) return;
    const changed =
      lastSavedRef.current.seg !== segments || lastSavedRef.current.cards !== cards;
    // trace updates per stream chunk — don't churn localStorage mid-stream
    if (!changed && trace?.outcome === "streaming") return;
    lastSavedRef.current = { seg: segments, cards };
    saveSnapshot({
      sessionId: sessionIdRef.current,
      savedAt: Date.now(),
      segments,
      cards,
      consumed: consumedRef.current,
      lastCard: lastCardRef.current,
    });
  }, [segments, cards, trace]);

  function resumeSession(snap: SessionSnapshot) {
    sessionIdRef.current = snap.sessionId;
    sessionStorage.setItem("k0-session-id", snap.sessionId);
    // watermarks BEFORE state — the query effect must not re-fire on
    // restored segments
    queriedRef.current = snap.segments.length;
    consumedRef.current = snap.consumed;
    lastCardRef.current = snap.lastCard;
    setSegments(snap.segments);
    setCards(snap.cards);
    setFollowing(true);
    setResumeOffer(null);
    // backfill cards the server finished after this client dropped
    (async () => {
      try {
        const res = await fetch(`/api/session/${snap.sessionId}`);
        if (!res.ok) return;
        const { cards: parked } = (await res.json()) as {
          cards: { turn: number; at: string; heard: string; text: string; debug: string[] }[];
        };
        if (!parked?.length) return;
        setCards((cs) => {
          const have = new Set(cs.map((c) => c.id));
          const add = parked
            .filter((p) => !have.has(p.turn))
            .map((p) => ({
              id: p.turn,
              heard: p.heard,
              at: new Date(p.at).toLocaleTimeString("en-US", { hour12: false }),
              text: p.text,
              debug: p.debug ?? [],
            }));
          if (add.length === 0) return cs;
          for (const a of add) {
            consumedRef.current = Math.max(consumedRef.current, a.id);
          }
          return [...cs, ...add].sort((a, b) => a.id - b.id);
        });
      } catch {
        // backfill is best-effort; the local snapshot already restored
      }
    })();
  }

  function startFresh() {
    try {
      const latest = localStorage.getItem(SNAP_LATEST);
      if (latest) localStorage.removeItem(SNAP_PREFIX + latest);
      localStorage.removeItem(SNAP_LATEST);
    } catch {}
    setResumeOffer(null);
  }

  // Every finalized utterance re-queries. Queries run concurrently — a newer
  // line never aborts an in-flight one (a finished answer is work already
  // paid for); turns settle out of order, cards insert sorted.
  // Consumed-GC: a card or NONE consumes everything sent — later queries
  // send only the unconsumed tail, else old topics get re-answered forever.
  // Failures do NOT consume; those lines retry on the next utterance.
  useEffect(() => {
    if (segments.length === 0 || segments.length === queriedRef.current) return;
    queriedRef.current = segments.length;

    const unconsumed = segments.slice(consumedRef.current);
    if (unconsumed.length === 0) return;
    // sys lines never reach the agent — and never trigger a query
    if (unconsumed[unconsumed.length - 1].sys) return;
    const spoken = unconsumed.filter((s) => !s.sys);
    if (spoken.length === 0) return;
    const heard = spoken[spoken.length - 1].text;
    const transcript = spoken.map((s) => s.text).join("\n");
    const id = segments.length;
    // transcript span this turn answers: segments [start, id)
    const start = consumedRef.current;

    const ctrl = new AbortController();
    inflightRef.current.add(ctrl);
    setAgentError(false);
    setCurrent({ id, heard, at: clock(), text: "", debug: [] });
    setTrace({ turn: id, lines: [], outcome: "streaming" });

    (async () => {
      try {
        const res = await fetch("/api/agent", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // sessionId+turn let the server park this card for backfill if we
          // drop mid-stream
          body: JSON.stringify({
            transcript,
            sessionId: sessionIdRef.current,
            turn: id,
            heard,
          }),
          signal: ctrl.signal,
        });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let raw = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          raw += decoder.decode(value, { stream: true });
          const { card, debug } = splitStream(raw);
          setCurrent((c) => (c && c.id === id ? { ...c, text: card, debug } : c));
          setTrace((t) =>
            t && t.turn === id ? { ...t, lines: debug } : t,
          );
        }
        raw += decoder.decode(); // flush any trailing multi-byte remainder
        const { card, debug } = splitStream(raw);
        const p = parseCard(card);
        setCurrent((c) => (c && c.id === id ? null : c));
        if (!card.trim()) {
          // trace only (or nothing) = model/tool failure, not NONE. Only the
          // newest turn drives the banner — an old turn failing after a
          // newer one answered is noise.
          if (id === queriedRef.current) setAgentError(true);
          setTrace((t) =>
            t && t.turn === id ? { ...t, lines: debug, outcome: "failed" } : t,
          );
        } else if (!p.none && (p.quote || p.answer)) {
          consumedRef.current = Math.max(consumedRef.current, id);
          // concurrent turns share lines — dup = same doc AND overlapping
          // spans; same doc from a fresh later span is a genuine re-ask
          const lc = lastCardRef.current;
          const dup =
            lc !== null &&
            !!p.doc &&
            lc.doc.toLowerCase() === p.doc.toLowerCase() &&
            lc.start < id &&
            start < lc.id;
          if (!dup) {
            lastCardRef.current = { id, start, doc: p.doc };
            setCards((cs) =>
              [...cs, { id, heard, at: clock(), text: card, debug }].sort(
                (a, b) => a.id - b.id,
              ),
            );
          }
          setTrace((t) =>
            t && t.turn === id
              ? { ...t, lines: debug, outcome: dup ? "duplicate" : "card" }
              : t,
          );
        } else if (p.none) {
          // NONE consumed too — don't re-litigate small talk
          consumedRef.current = Math.max(consumedRef.current, id);
          setTrace((t) =>
            t && t.turn === id ? { ...t, lines: debug, outcome: "none" } : t,
          );
        } else {
          // prose without card fields = format failure, NOT a NONE — don't
          // consume, retry next utterance
          if (id === queriedRef.current) setAgentError(true);
          setTrace((t) =>
            t && t.turn === id ? { ...t, lines: debug, outcome: "failed" } : t,
          );
        }
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          setCurrent((c) => (c && c.id === id ? null : c));
          if (id === queriedRef.current) setAgentError(true);
          setTrace((t) =>
            t && t.turn === id ? { ...t, outcome: "failed" } : t,
          );
        }
      } finally {
        inflightRef.current.delete(ctrl);
      }
    })();
  }, [segments]);

  function goOlder() {
    setFollowing(false);
    setView((v) => Math.max(0, v - 1));
  }
  function goNewer() {
    setFollowing(false);
    setView((v) => Math.min(cards.length - 1, v + 1));
  }
  function togglePlay() {
    // resume snaps to the live edge (following effect)
    setFollowing((f) => !f);
  }

  /** mic failures land as timestamped sys lines in the transcript */
  function logSystem(text: string) {
    setSegments((s) => [...s, { id: s.length, at: clock(), text, sys: true }]);
  }

  function fireWarmup() {
    // fire-and-forget warm-up — instance pays one-time init before the first
    // utterance finalizes: first card ~0.9s instead of ~6s
    fetch("/api/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ warmup: true }),
    }).catch(() => {});
  }

  async function startGladia() {
    setStatus("listening");
    activeRef.current = true;
    fireWarmup();
    try {
      gladiaRef.current = await startGladiaLive({
        sessionId: sessionIdRef.current,
        onFinal: (raw) => {
          const text = tidyTranscript(raw);
          if (text)
            setSegments((s) => [...s, { id: s.length, at: clock(), text }]);
          setInterim("");
        },
        onInterim: (raw) => setInterim(tidyTranscript(raw)),
        onError: (message) => {
          activeRef.current = false;
          setStatus("unavailable");
          logSystem(`mic error: ${message}`);
        },
      });
      if (!activeRef.current) {
        // user hit Stop while the session was still minting
        gladiaRef.current?.stop();
        gladiaRef.current = null;
      }
    } catch (err) {
      activeRef.current = false;
      if ((err as Error).name === "NotAllowedError") {
        setStatus("denied");
        logSystem("mic error: not-allowed — allow the mic for this site");
      } else {
        setStatus("unavailable");
        logSystem(`mic error: ${String(err).slice(0, 140)}`);
      }
    }
  }

  function start() {
    setResumeOffer(null); // starting a live call supersedes the offer
    // Gladia everywhere — browser SpeechRecognition mishears technical
    // vocabulary too often for an SA call, and mobile never had it anyway
    if (!isGladiaCapable()) {
      setStatus("unsupported");
      return;
    }
    startGladia();
  }

  function stop() {
    activeRef.current = false;
    gladiaRef.current?.stop();
    gladiaRef.current = null;
    setInterim("");
    setStatus("idle");
  }

  const listening = status === "listening";
  const streaming = current !== null;
  const liveView = following && streaming;
  const currentParse = current ? parseCard(current.text) : null;
  const currentIsCard =
    !!current && !!current.text.trim() && !!currentParse && !currentParse.none;
  const viewIndex = Math.min(view, Math.max(0, cards.length - 1));
  const shownCard = cards.length ? cards[viewIndex] : null;
  const behind = cards.length - 1 - viewIndex;
  const modeLabel =
    !listening && cards.length === 0 && !streaming
      ? "Idle"
      : following
        ? streaming
          ? "Live · Searching…"
          : "Live"
        : `Paused${behind > 0 ? ` · ${behind} newer` : ""}`;

  return (
    <div className="mx-auto w-full max-w-245 px-5 pt-8 pb-12">
      <OfflineBanner callLive={listening || streaming} />
      <header className="mb-6">
        <div
          aria-hidden="true"
          className="mb-3 h-8.5 w-8.5 select-none rounded-lg bg-ink text-center font-mono text-[15px] font-bold leading-8.5 tracking-tight text-white"
        >
          k0
        </div>
        <h1 className="text-[26px] font-bold tracking-tight">
          Knowledge that{" "}
          <span className="rounded-[3px] bg-frag px-1.25 text-frag-ink">
            follows your voice
          </span>
        </h1>
      </header>

      <div className="grid grid-cols-1 gap-4.5 md:grid-cols-2">
        {/* dev visual aid — the transcript feeds the agent */}
        <section
          aria-label="Live call transcript"
          className="flex min-h-105 flex-col rounded-[10px] border border-line bg-card"
        >
          <div className="flex items-center justify-between gap-2.5 border-b border-line px-3.5 py-2.5 font-mono text-xs font-semibold uppercase tracking-wider text-muted">
            <span>
              Live call — your side (SA mic · gladia)
            </span>
            <span className="tabular-nums">{segments.length} lines</span>
          </div>
          <div
            ref={scrollRef}
            className="flex max-h-115 flex-1 flex-col gap-3 overflow-y-auto p-4"
          >
            {resumeOffer && segments.length === 0 && status === "idle" && (
              <div className="rounded-lg border border-line bg-[#f4f4f5] px-3 py-2.5 text-sm">
                Resume call from{" "}
                {new Date(resumeOffer.savedAt).toLocaleTimeString("en-US", {
                  hour12: false,
                  hour: "2-digit",
                  minute: "2-digit",
                })}{" "}
                — {resumeOffer.segments.filter((s) => !s.sys).length} lines,{" "}
                {resumeOffer.cards.length} card
                {resumeOffer.cards.length === 1 ? "" : "s"}?
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    onClick={() => resumeSession(resumeOffer)}
                    className="rounded-md bg-ink px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#333]"
                  >
                    Resume
                  </button>
                  <button
                    type="button"
                    onClick={startFresh}
                    className="rounded-md border border-line px-3 py-1.5 text-xs font-semibold text-ink hover:border-accent hover:text-accent"
                  >
                    Start fresh
                  </button>
                </div>
              </div>
            )}
            {segments.length === 0 && !interim && !resumeOffer && (
              <p className="text-sm text-muted">
                {status === "denied"
                  ? "Microphone access denied (not-allowed). Allow the mic for this site — and check the browser has mic access in System Settings → Privacy & Security."
                  : status === "unsupported"
                    ? "Live transcription needs a modern browser (WebSocket + AudioWorklet + microphone). Update or switch browsers, then try again."
                    : status === "unavailable"
                      ? "Live transcription disconnected. Check your connection, then start listening again."
                      : "Press Start Listening — your side of the call transcribes here."}
              </p>
            )}
            {segments.map((s) => (
              <div key={s.id} className="max-w-[92%]">
                <div className="mb-1 font-mono text-[11px] font-semibold tabular-nums text-muted">
                  {s.at}
                </div>
                <div
                  className={`rounded-lg border border-line px-3 py-2.5 ${
                    s.sys
                      ? "bg-card font-mono text-[12px] text-error"
                      : "bg-[#f4f4f5]"
                  }`}
                >
                  {s.text}
                </div>
              </div>
            ))}
            {interim && (
              <div className="max-w-[92%]">
                <div className="mb-1 font-mono text-[11px] font-semibold text-muted">
                  hearing…
                </div>
                <div className="rounded-lg border border-dashed border-line px-3 py-2.5 text-muted">
                  {interim}
                </div>
              </div>
            )}
            <button
              type="button"
              onClick={listening ? stop : start}
              className={`mt-auto self-start rounded-lg px-4 py-2.75 text-sm font-semibold text-white ${
                listening
                  ? "bg-live hover:opacity-90"
                  : "bg-ink hover:bg-[#333]"
              }`}
            >
              {listening ? "Stop Listening" : "Start Listening"}
            </button>
          </div>
        </section>

        <section
          aria-label="k0 suggestions"
          className="flex min-h-105 flex-col rounded-[10px] border border-line bg-card"
        >
          <div className="flex items-center justify-between gap-2.5 border-b border-line px-3.5 py-2.5 font-mono text-xs font-semibold uppercase tracking-wider">
            <span className={following ? "text-live" : "text-muted"}>
              {/* dot pulses only while truthfully live: mic on or agent mid-search */}
              <span
                className={`mr-1.5 inline-block h-1.75 w-1.75 -translate-y-px rounded-full bg-current ${
                  listening || streaming ? "dot-listening" : ""
                }`}
              />
              {modeLabel}
            </span>
            <div
              className="flex items-center gap-1"
              role="group"
              aria-label="Browse suggestion turns"
            >
              <button
                type="button"
                onClick={goOlder}
                disabled={cards.length === 0 || viewIndex <= 0}
                aria-label="Previous turn"
                title="Previous turn"
                className="flex h-6 w-6 items-center justify-center rounded-md border border-line text-[13px] leading-none text-ink hover:border-accent hover:text-accent disabled:border-line disabled:text-line disabled:hover:border-line disabled:hover:text-line"
              >
                ‹
              </button>
              <button
                type="button"
                onClick={togglePlay}
                disabled={cards.length === 0}
                aria-label={following ? "Pause on this card" : "Follow live"}
                title={following ? "Pause on this card" : "Follow live"}
                className={`flex h-6 w-6 items-center justify-center rounded-md border text-[11px] leading-none disabled:border-line disabled:text-line ${
                  following
                    ? "border-live text-live"
                    : "border-line text-ink hover:border-accent hover:text-accent"
                }`}
              >
                {following ? "❚❚" : "▶"}
              </button>
              <button
                type="button"
                onClick={goNewer}
                disabled={cards.length === 0 || viewIndex >= cards.length - 1}
                aria-label="Next turn"
                title="Next turn"
                className="flex h-6 w-6 items-center justify-center rounded-md border border-line text-[13px] leading-none text-ink hover:border-accent hover:text-accent disabled:border-line disabled:text-line disabled:hover:border-line disabled:hover:text-line"
              >
                ›
              </button>
              <span className="ml-1 tabular-nums text-muted">
                {cards.length ? `${viewIndex + 1}/${cards.length}` : "–/–"}
              </span>
            </div>
          </div>
          <div className="flex max-h-115 flex-1 flex-col gap-4 overflow-y-auto p-4">
            {agentError && (
              <p className="text-sm text-error">
                Search failed. k0 retries on your next line.
              </p>
            )}

            {/* Settled card stays mounted while a query runs — swapping to a
                skeleton replays the entrance animation on old info. Streaming
                card takes over only once it has real content (same key → no
                remount on settle); the skeleton marks only the FIRST answer. */}
            {liveView && currentIsCard ? (
              <SuggestionCard key={current!.id} s={current!} />
            ) : shownCard ? (
              <SuggestionCard key={shownCard.id} s={shownCard} />
            ) : streaming ? (
              <div className="card-rise flex flex-col gap-2" aria-hidden="true">
                <div className="h-3 w-1/3 animate-pulse rounded bg-line" />
                <div className="h-4 w-full animate-pulse rounded bg-line" />
                <div className="h-4 w-5/6 animate-pulse rounded bg-line" />
                <div className="h-4 w-2/3 animate-pulse rounded bg-line" />
              </div>
            ) : (
              !agentError && (
                <p className="text-sm text-muted">
                  Start the conversation — k0 surfaces knowledge as you talk.
                </p>
              )
            )}
          </div>
        </section>
      </div>

      {/* survives NONE and failures, where no card dropdown ever lands */}
      {trace && (
        <section
          aria-label="Agent trace"
          className="mt-4.5 rounded-[10px] border border-line bg-card"
        >
          <div className="flex items-center justify-between gap-2.5 border-b border-line px-3.5 py-2.5 font-mono text-xs font-semibold uppercase tracking-wider text-muted">
            <span>Agent trace — turn {trace.turn}</span>
            <span
              className={
                trace.outcome === "failed"
                  ? "text-error"
                  : trace.outcome === "card"
                    ? "text-live"
                    : "text-muted"
              }
            >
              {trace.outcome === "streaming"
                ? "running…"
                : trace.outcome === "card"
                  ? "card"
                  : trace.outcome === "none"
                    ? "none — no doc needed"
                    : trace.outcome === "duplicate"
                      ? "duplicate — already on a card"
                      : "failed"}
            </span>
          </div>
          <div className="flex max-h-55 flex-col gap-0.5 overflow-y-auto p-4 font-mono text-[10px] leading-relaxed text-[#b6b6be]">
            {trace.lines.length === 0 && (
              <span className="text-muted">waiting for the agent…</span>
            )}
            {trace.lines.map((line, k) => (
              <div key={k} className="whitespace-pre-wrap wrap-break-word">
                {line}
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";

/* Minimal Web Speech API types — not in TS's dom lib. */
interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
}
interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
}

type Status = "idle" | "listening" | "denied" | "unsupported" | "unavailable";

/** One finalized utterance. This is what streams to the agent — except
 *  system lines (mic errors), which render in the transcript but never
 *  reach the agent. */
interface Segment {
  id: number;
  at: string;
  text: string;
  sys?: boolean;
}

/** One agent response, streamed in the strict DOC/ANSWER/QUOTE/ANCHOR/SOURCE format. */
interface Suggestion {
  id: number;
  heard: string;
  at: string;
  text: string;
  /** The model's reasoning + tool-call trace, for the per-card debug dropdown. */
  debug: string[];
}

function clock() {
  return new Date().toLocaleTimeString("en-US", { hour12: false });
}

/** Fix common speech-recognition mishears before they reach the transcript. */
const TIDY_RULES: [RegExp, string][] = [
  [/\bthe cell\b/gi, "Vercel"],
  [/\bfor sale\b/gi, "Vercel"],
  [/\bfor cell\b/gi, "Vercel"],
  [/\bwill sell\b/gi, "Vercel"],
  [/\bwork clothes\b/gi, "workflows"],
  [/\bchrome task\b/gi, "cron task"],
  [/\bchromecast\b/gi, "cron task"],
  [/\bcrown\b/gi, "cron"],
  [/\bgerbil\b/gi, "durable"],
];

function tidyTranscript(text: string) {
  return TIDY_RULES.reduce((t, [re, sub]) => t.replace(re, sub), text);
}

/** The agent stream interleaves a NUL-prefixed, newline-terminated debug trace
 *  (reasoning + tool calls) with the card text. Peel the two apart. */
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
  const field = (k: string) =>
    text.match(new RegExp(`^${k}:\\s*(.*)$`, "mi"))?.[1]?.trim() ?? "";
  return {
    none: text.trim().toUpperCase().startsWith("NONE"),
    doc: field("DOC"),
    answer: field("ANSWER"),
    quote: field("QUOTE"),
    anchor: field("ANCHOR"),
    source: field("SOURCE"),
  };
}

/** Named target: every click is a top-level navigation of one reused window,
 *  so the #:~:text= fragment fires and the highlight lands in the real docs. */
function openDocs(url: string) {
  window.open(url, "k0Docs", "width=1100,height=800");
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
        <mark className="rounded-[3px] bg-frag px-[3px] py-px text-frag-ink">
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
                <div key={k} className="whitespace-pre-wrap break-words">
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
  // Raw SpeechRecognition error code — "not-allowed" (permission) and
  // "service-not-allowed" (speech service blocked) need different advice.
  const [micError, setMicError] = useState("");
  const [segments, setSegments] = useState<Segment[]>([]);
  const [interim, setInterim] = useState("");
  const [current, setCurrent] = useState<Suggestion | null>(null);
  const [cards, setCards] = useState<Suggestion[]>([]); // oldest → newest
  const [agentError, setAgentError] = useState(false);
  // Latest query's full trace — survives NONE and failures, where no card
  // (and no per-card dropdown) ever lands.
  const [trace, setTrace] = useState<{
    turn: number;
    lines: string[];
    outcome: "streaming" | "card" | "none" | "duplicate" | "failed";
  } | null>(null);
  const [view, setView] = useState(0); // index of the card on screen
  const [following, setFollowing] = useState(true); // carousel keeps up with live
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const activeRef = useRef(false);
  // Rapid-restart guard: a healthy recognizer runs for seconds before Chrome
  // ends it; ending right after start means it's failing on arrival.
  const recStartedAtRef = useRef(0);
  const rapidEndsRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  // In-flight queries — several can run at once; only unmount aborts them.
  const inflightRef = useRef(new Set<AbortController>());
  const queriedRef = useRef(0);
  // Segments answered (card or NONE) — never resent to the agent.
  const consumedRef = useRef(0);
  // Last card pushed, with the transcript span it answered — dedupes
  // overlapping concurrent turns that surface the same doc twice.
  const lastCardRef = useRef<{ id: number; start: number; doc: string } | null>(
    null,
  );

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [segments, interim]);

  // Following = ride the live edge: whenever a new card lands (or the user
  // resumes), snap the carousel to the newest card.
  useEffect(() => {
    if (following) setView(Math.max(0, cards.length - 1));
  }, [cards.length, following]);

  useEffect(() => {
    return () => {
      activeRef.current = false;
      recRef.current?.stop();
      inflightRef.current.forEach((c) => c.abort());
    };
  }, []);

  // Continuous querying: every finalized utterance re-queries the agent.
  // Queries run concurrently — a newer line never aborts an in-flight one;
  // a finished answer is work already paid for, so it lands if appropriate.
  // Turns can settle out of order; cards insert sorted by turn.
  //
  // Garbage-collect answered transcript: once a query settles with a card
  // OR a NONE, everything up to that point is consumed — later queries send
  // only the unconsumed tail. Otherwise the agent keeps seeing (and
  // re-answering) old topics: mention fluid compute, get the card, talk
  // about cats → without trimming, the same fluid-compute card comes back.
  // Overlapping turns that surface the same doc dedupe on landing.
  // Failures do NOT consume — those lines get another chance on the next
  // utterance.
  useEffect(() => {
    if (segments.length === 0 || segments.length === queriedRef.current) return;
    queriedRef.current = segments.length;

    const unconsumed = segments.slice(consumedRef.current);
    if (unconsumed.length === 0) return;
    // System lines (mic errors) render in the transcript but never reach
    // the agent — and a system line is not a question, so it triggers no
    // query of its own.
    if (unconsumed[unconsumed.length - 1].sys) return;
    const spoken = unconsumed.filter((s) => !s.sys);
    if (spoken.length === 0) return;
    const heard = spoken[spoken.length - 1].text;
    const transcript = spoken.map((s) => s.text).join("\n");
    const id = segments.length;
    // Transcript span this turn answers: segments [start, id).
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
          body: JSON.stringify({ transcript }),
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
          // Stream carried only a trace (or nothing) — a model/tool failure,
          // not a NONE. The trace panel below shows what the agent did.
          // Only the newest turn drives the error banner: an old turn
          // failing after a newer one answered is noise, not a problem.
          if (id === queriedRef.current) setAgentError(true);
          setTrace((t) =>
            t && t.turn === id ? { ...t, lines: debug, outcome: "failed" } : t,
          );
        } else if (!p.none && (p.quote || p.answer)) {
          // Card delivered — everything sent in this query is consumed.
          consumedRef.current = Math.max(consumedRef.current, id);
          // Concurrent turns share transcript lines, so two in-flight
          // queries can answer the same topic. A card is a duplicate when
          // it cites the last card's doc AND their spans overlap — the same
          // doc from a fresh, later span is a genuine re-ask and lands.
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
          // NONE: the agent looked and decided no doc applies — not a
          // failure, and equally consumed: don't re-litigate small talk.
          consumedRef.current = Math.max(consumedRef.current, id);
          setTrace((t) =>
            t && t.turn === id ? { ...t, lines: debug, outcome: "none" } : t,
          );
        } else {
          // Prose without card fields: a format failure, NOT a NONE.
          // Don't consume — these lines get another chance next utterance.
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
    // Resuming snaps back to the live edge (handled by the following effect).
    setFollowing((f) => !f);
  }

  /** Mic failures land in the transcript as timestamped system lines —
   *  the placeholder text only shows while the transcript is empty. */
  function logSystem(text: string) {
    setSegments((s) => [...s, { id: s.length, at: clock(), text, sys: true }]);
  }

  function start() {
    const w = window as unknown as Record<string, unknown>;
    const Rec = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!Rec) {
      setStatus("unsupported");
      return;
    }
    const rec = new (Rec as new () => SpeechRecognitionLike)();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = "en-US";
    rec.onresult = (e) => {
      let pending = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) {
          const text = tidyTranscript(r[0].transcript.trim());
          if (text)
            setSegments((s) => [...s, { id: s.length, at: clock(), text }]);
        } else {
          pending += r[0].transcript;
        }
      }
      setInterim(tidyTranscript(pending));
    };
    rec.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        activeRef.current = false;
        setMicError(e.error);
        setStatus("denied");
        logSystem(
          e.error === "service-not-allowed"
            ? "mic error: service-not-allowed — speech service blocked; use desktop Chrome"
            : "mic error: not-allowed — allow the mic for this site, and check Chrome has mic access in System Settings → Privacy & Security",
        );
      }
    };
    // Chrome ends recognition after silence — restart while the mic is meant
    // to be on. But an end within ~1s of start means the recognizer is dying
    // on arrival (another tab holds the mic, speech service unreachable) —
    // restarting forever just flickers the recording light. Three rapid ends
    // in a row: stop and say what still works.
    rec.onend = () => {
      setInterim("");
      if (!activeRef.current) return;
      const rapid = Date.now() - recStartedAtRef.current < 1000;
      rapidEndsRef.current = rapid ? rapidEndsRef.current + 1 : 0;
      if (rapidEndsRef.current >= 3) {
        activeRef.current = false;
        setStatus("unavailable");
        logSystem(
          "mic error: recognition keeps disconnecting — usually another tab is listening; close it and start again",
        );
        return;
      }
      recStartedAtRef.current = Date.now();
      rec.start();
    };
    recRef.current = rec;
    activeRef.current = true;
    rapidEndsRef.current = 0;
    recStartedAtRef.current = Date.now();
    setStatus("listening");
    rec.start();
    // Fire-and-forget warm-up: the serverless instance pays its one-time
    // init now, during the seconds before the first utterance finalizes —
    // so the first card is warm-path (~0.9s) instead of cold (~6s).
    fetch("/api/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ warmup: true }),
    }).catch(() => {});
  }

  function stop() {
    activeRef.current = false;
    recRef.current?.stop();
    setInterim("");
    setStatus("idle");
  }

  const listening = status === "listening";
  const streaming = current !== null; // a query is in flight
  const liveView = following && streaming; // carousel shows the streaming card
  const currentParse = current ? parseCard(current.text) : null;
  const currentIsCard =
    !!current && !!current.text.trim() && !!currentParse && !currentParse.none;
  const viewIndex = Math.min(view, Math.max(0, cards.length - 1));
  const shownCard = cards.length ? cards[viewIndex] : null;
  const behind = cards.length - 1 - viewIndex; // newer cards off-screen
  const modeLabel =
    !listening && cards.length === 0 && !streaming
      ? "Idle"
      : following
        ? streaming
          ? "Live · Searching…" // connected AND the agent is working right now
          : "Live"
        : `Paused${behind > 0 ? ` · ${behind} newer` : ""}`;

  return (
    <div className="mx-auto w-full max-w-[980px] px-5 pt-8 pb-12">
      <header className="mb-6">
        <div
          aria-hidden="true"
          className="mb-3 h-[34px] w-[34px] select-none rounded-lg bg-ink text-center font-mono text-[15px] font-bold leading-[34px] tracking-tight text-white"
        >
          k0
        </div>
        <h1 className="text-[26px] font-bold tracking-tight">
          Knowledge that{" "}
          <span className="rounded-[3px] bg-frag px-[5px] text-frag-ink">
            follows your voice
          </span>
        </h1>
      </header>

      <div className="grid grid-cols-1 gap-[18px] md:grid-cols-2">
        {/* Live call — dev visual aid; the transcript feeds the agent */}
        <section
          aria-label="Live call transcript"
          className="flex min-h-[420px] flex-col rounded-[10px] border border-line bg-card"
        >
          <div className="flex items-center justify-between gap-2.5 border-b border-line px-3.5 py-2.5 font-mono text-xs font-semibold uppercase tracking-wider text-muted">
            <span>Live call — your side (SA mic)</span>
            <span className="tabular-nums">{segments.length} lines</span>
          </div>
          <div
            ref={scrollRef}
            className="flex max-h-[460px] flex-1 flex-col gap-3 overflow-y-auto p-4"
          >
            {segments.length === 0 && !interim && (
              <p className="text-sm text-muted">
                {status === "denied"
                  ? micError === "service-not-allowed"
                    ? "Speech service blocked (service-not-allowed). Use desktop Chrome, then start listening again."
                    : "Microphone access denied (not-allowed). Allow the mic for this site — and check Chrome has mic access in System Settings → Privacy & Security."
                  : status === "unsupported"
                    ? "Speech recognition isn't available in this browser. Use Chrome."
                    : status === "unavailable"
                      ? "Speech recognition keeps disconnecting — usually another tab is listening. Close it, then start again."
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

        {/* Suggestions — the agent answers continuously as the transcript grows */}
        <section
          aria-label="k0 suggestions"
          className="flex min-h-[420px] flex-col rounded-[10px] border border-line bg-card"
        >
          <div className="flex items-center justify-between gap-2.5 border-b border-line px-3.5 py-2.5 font-mono text-xs font-semibold uppercase tracking-wider">
            <span className={following ? "text-live" : "text-muted"}>
              {/* The dot pulses while something is truthfully live: the mic
                  listening, or the agent mid-search. Stops when both stop. */}
              <span
                className={`mr-1.5 inline-block h-[7px] w-[7px] -translate-y-px rounded-full bg-current ${
                  listening || streaming ? "dot-listening" : ""
                }`}
              />
              {modeLabel}
            </span>
            {/* Carousel transport — browse suggestion turns, or follow live */}
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
          <div className="flex max-h-[460px] flex-1 flex-col gap-4 overflow-y-auto p-4">
            {agentError && (
              <p className="text-sm text-error">
                Search failed. k0 retries on your next line.
              </p>
            )}

            {/* The settled card stays mounted while a query runs — swapping
                it for a skeleton and back replays the entrance animation on
                information that isn't new. The streaming card takes over
                only once it has real card content (same key → no remount
                when it settles); the skeleton only marks where the FIRST
                answer will appear. */}
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

      {/* Agent trace — full-width debug panel. Survives NONE and failures,
          where no card (and no per-card dropdown) ever lands. */}
      {trace && (
        <section
          aria-label="Agent trace"
          className="mt-[18px] rounded-[10px] border border-line bg-card"
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
          <div className="flex max-h-[220px] flex-col gap-0.5 overflow-y-auto p-4 font-mono text-[10px] leading-relaxed text-[#b6b6be]">
            {trace.lines.length === 0 && (
              <span className="text-muted">waiting for the agent…</span>
            )}
            {trace.lines.map((line, k) => (
              <div key={k} className="whitespace-pre-wrap break-words">
                {line}
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

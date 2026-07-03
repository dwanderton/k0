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

type Status = "idle" | "listening" | "denied" | "unsupported";

/** One finalized utterance. This is what streams to the agent. */
interface Segment {
  id: number;
  at: string;
  text: string;
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
        Turn {s.id} · heard from your mic
      </div>
      <div className="border-l-2 border-line pl-2.5 text-[13px] text-muted">
        &ldquo;{s.heard}&rdquo;
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
  const [segments, setSegments] = useState<Segment[]>([]);
  const [interim, setInterim] = useState("");
  const [current, setCurrent] = useState<Suggestion | null>(null);
  const [cards, setCards] = useState<Suggestion[]>([]); // oldest → newest
  const [agentError, setAgentError] = useState(false);
  const [view, setView] = useState(0); // index of the card on screen
  const [following, setFollowing] = useState(true); // carousel keeps up with live
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const activeRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const queriedRef = useRef(0);

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
      abortRef.current?.abort();
    };
  }, []);

  // Continuous querying: every finalized utterance re-queries the agent with
  // the full transcript. Latest wins — a newer line aborts the in-flight one.
  useEffect(() => {
    if (segments.length === 0 || segments.length === queriedRef.current) return;
    queriedRef.current = segments.length;

    const heard = segments[segments.length - 1].text;
    const transcript = segments.map((s) => s.text).join("\n");
    const id = segments.length;

    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setAgentError(false);
    setCurrent({ id, heard, at: clock(), text: "", debug: [] });

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
        }
        const { card, debug } = splitStream(raw);
        const p = parseCard(card);
        setCurrent((c) => (c && c.id === id ? null : c));
        if (!card.trim()) {
          // Stream carried only a trace (or nothing) — a model/tool failure,
          // not a NONE. The card's trace dropdown shows what the agent did.
          setAgentError(true);
        } else if (!p.none && (p.quote || p.answer)) {
          setCards((cs) => [...cs, { id, heard, at: clock(), text: card, debug }]);
        }
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          setCurrent((c) => (c && c.id === id ? null : c));
          setAgentError(true);
        }
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
        setStatus("denied");
      }
    };
    // Chrome ends recognition after silence — restart while the mic is meant to be on.
    rec.onend = () => {
      setInterim("");
      if (activeRef.current) rec.start();
    };
    recRef.current = rec;
    activeRef.current = true;
    setStatus("listening");
    rec.start();
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
        ? "Live"
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
                  ? "Microphone access denied. Allow access in the browser, then start listening again."
                  : status === "unsupported"
                    ? "Speech recognition isn't available in this browser. Use Chrome."
                    : "Press Start Listening — your side of the call transcribes here."}
              </p>
            )}
            {segments.map((s) => (
              <div key={s.id} className="max-w-[92%]">
                <div className="mb-1 font-mono text-[11px] font-semibold tabular-nums text-muted">
                  {s.at}
                </div>
                <div className="rounded-lg border border-line bg-[#f4f4f5] px-3 py-2.5">
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
              <span
                className={`mr-1.5 inline-block h-[7px] w-[7px] -translate-y-px rounded-full bg-current ${
                  listening ? "dot-listening" : ""
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

            {liveView ? (
              currentIsCard ? (
                <SuggestionCard s={current!} />
              ) : (
                <div className="card-rise flex flex-col gap-2" aria-hidden="true">
                  <div className="h-3 w-1/3 animate-pulse rounded bg-line" />
                  <div className="h-4 w-full animate-pulse rounded bg-line" />
                  <div className="h-4 w-5/6 animate-pulse rounded bg-line" />
                  <div className="h-4 w-2/3 animate-pulse rounded bg-line" />
                </div>
              )
            ) : shownCard ? (
              <SuggestionCard key={shownCard.id} s={shownCard} />
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
    </div>
  );
}

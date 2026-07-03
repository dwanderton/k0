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
type AnswerState = "idle" | "searching" | "streaming" | "done" | "error";

/** One finalized utterance. This array is what streams to the model later. */
interface Segment {
  id: number;
  at: string;
  text: string;
}

function clock() {
  return new Date().toLocaleTimeString("en-US", { hour12: false });
}

export default function Home() {
  const [status, setStatus] = useState<Status>("idle");
  const [segments, setSegments] = useState<Segment[]>([]);
  const [interim, setInterim] = useState("");
  const [answer, setAnswer] = useState("");
  const [answerState, setAnswerState] = useState<AnswerState>("idle");
  const [answeredAt, setAnsweredAt] = useState("");
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const activeRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [segments, interim]);

  useEffect(() => {
    return () => {
      activeRef.current = false;
      recRef.current?.stop();
    };
  }, []);

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
          const text = r[0].transcript.trim();
          if (text)
            setSegments((s) => [...s, { id: s.length, at: clock(), text }]);
        } else {
          pending += r[0].transcript;
        }
      }
      setInterim(pending);
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

  // Text-only for now: the captured transcript POSTs to the agent, which
  // searches Vercel docs over MCP and streams the answer back.
  async function searchDocs() {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setAnswer("");
    setAnswerState("searching");
    try {
      const transcript = segments.map((s) => s.text).join("\n");
      const res = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transcript }),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let text = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        setAnswer(text);
        setAnswerState("streaming");
      }
      setAnsweredAt(clock());
      setAnswerState("done");
    } catch (err) {
      if ((err as Error).name !== "AbortError") setAnswerState("error");
    }
  }

  const listening = status === "listening";
  const searching = answerState === "searching" || answerState === "streaming";
  const sourceMatch = answer.match(/\nSource:\s*(\S+)\s*$/i);
  const answerBody = sourceMatch
    ? answer.slice(0, sourceMatch.index).trimEnd()
    : answer;
  const sourceUrl = sourceMatch?.[1];

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
        {/* Live call — the browser transcript that streams to the model */}
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

        {/* Suggestions — cards land here once retrieval is wired in */}
        <section
          aria-label="k0 suggestions"
          className="flex min-h-[420px] flex-col rounded-[10px] border border-line bg-card"
        >
          <div className="flex items-center gap-2.5 border-b border-line px-3.5 py-2.5 font-mono text-xs font-semibold uppercase tracking-wider">
            <span className={listening ? "text-live" : "text-muted"}>
              <span
                className={`mr-1.5 inline-block h-[7px] w-[7px] -translate-y-px rounded-full bg-current ${
                  listening ? "dot-listening" : ""
                }`}
              />
              {listening ? "Listening" : "Idle"}
            </span>
          </div>
          <div className="flex flex-1 flex-col gap-3 p-4">
            {answerState === "idle" && (
              <p className="text-sm text-muted">
                {segments.length === 0
                  ? "Start the conversation — k0 surfaces knowledge as you talk."
                  : "Transcript ready — press Search Vercel Docs."}
              </p>
            )}

            {answerState === "searching" && (
              <div className="card-rise flex flex-col gap-2" aria-hidden="true">
                <div className="h-3 w-1/3 animate-pulse rounded bg-line" />
                <div className="h-4 w-full animate-pulse rounded bg-line" />
                <div className="h-4 w-5/6 animate-pulse rounded bg-line" />
                <div className="h-4 w-2/3 animate-pulse rounded bg-line" />
              </div>
            )}

            {(answerState === "streaming" || answerState === "done") && (
              <div className="card-rise rounded-lg border border-accent bg-card px-3.5 py-3">
                <div className="mb-2 font-mono text-[11px] font-semibold uppercase tracking-wider text-muted">
                  vercel docs · mcp
                </div>
                <div className="whitespace-pre-wrap text-[15px]">
                  {answerBody}
                </div>
                <div className="mt-2 flex items-center justify-between gap-2 font-mono text-[11px] text-muted">
                  {sourceUrl ? (
                    <a
                      href={sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="truncate underline underline-offset-2 hover:text-accent"
                    >
                      {sourceUrl.replace(/^https?:\/\//, "")}
                    </a>
                  ) : (
                    <span>{answerState === "done" ? "no source returned" : "searching…"}</span>
                  )}
                  {answerState === "done" && (
                    <span className="tabular-nums">{answeredAt}</span>
                  )}
                </div>
              </div>
            )}

            {answerState === "error" && (
              <p className="text-sm text-error">
                Search failed. Check the connection, then press Search Vercel
                Docs to retry.
              </p>
            )}

            <button
              type="button"
              onClick={searchDocs}
              disabled={segments.length === 0 || searching}
              className="mt-auto self-start rounded-lg bg-ink px-4 py-2.75 text-sm font-semibold text-white hover:bg-[#333] disabled:cursor-not-allowed disabled:bg-line disabled:text-muted"
            >
              {searching ? "Searching…" : "Search Vercel Docs"}
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}

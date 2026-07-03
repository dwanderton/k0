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
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const activeRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);

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

  const listening = status === "listening";

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
              className={`mt-auto self-start rounded-lg px-4 py-[11px] text-sm font-semibold text-white ${
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
            <p className="text-sm text-muted">
              Start the conversation — k0 surfaces knowledge as you talk.
            </p>
          </div>
        </section>
      </div>
    </div>
  );
}

"use client";

/**
 * Memoized cockpit panels — transcript, suggestions carousel, agent trace.
 * The memo boundaries are the point: while a card streams, setCurrent/
 * setTrace fire per chunk — panels whose props didn't change must not
 * re-render with it.
 */
import { memo, useEffect, useRef, useState } from "react";
import {
  parseCard,
  type Segment,
  type SessionSnapshot,
  type Status,
  type Suggestion,
  type TraceState,
} from "@/lib/call-shared";
import { SuggestionCard } from "./suggestion-card";

export const TranscriptPanel = memo(function TranscriptPanel({
  segments,
  interim,
  status,
  resumeOffer,
  onResume,
  onStartFresh,
}: {
  segments: Segment[];
  interim: string;
  status: Status;
  resumeOffer: SessionSnapshot | null;
  onResume: (snap: SessionSnapshot) => void;
  onStartFresh: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [segments, interim]);

  return (
    <section
      aria-label="Live call transcript"
      className="flex min-h-105 flex-col rounded-[10px] border border-line bg-card"
    >
      <div className="flex items-center justify-between gap-2.5 border-b border-line px-3.5 py-2.5 font-mono text-xs font-semibold uppercase tracking-wider text-muted">
        <span>Live call — your side</span>
        <span className="tabular-nums">{segments.length} lines</span>
      </div>
      <div
        ref={scrollRef}
        className="flex max-h-115 flex-1 flex-col gap-3 overflow-y-auto p-4"
      >
        {resumeOffer && segments.length === 0 && status === "idle" ? (
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
                onClick={() => onResume(resumeOffer)}
                className="rounded-md bg-ink px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#333]"
              >
                Resume
              </button>
              <button
                type="button"
                onClick={onStartFresh}
                className="rounded-md border border-line px-3 py-1.5 text-xs font-semibold text-ink hover:border-accent hover:text-accent"
              >
                Start fresh
              </button>
            </div>
          </div>
        ) : null}
        {segments.length === 0 && !interim && !resumeOffer ? (
          <p className="text-sm text-muted">
            {status === "denied"
              ? "Microphone access denied (not-allowed). Allow the mic for this site — and check the browser has mic access in System Settings → Privacy & Security."
              : status === "unsupported"
                ? "Live transcription needs a modern browser (WebSocket + AudioWorklet + microphone). Update or switch browsers, then try again."
                : status === "unavailable"
                  ? "Live transcription disconnected. Check your connection, then start listening again."
                  : "Press Start Listening — your side of the call transcribes here."}
          </p>
        ) : null}
        {segments.map((s) => (
          <div key={s.id} className="max-w-[92%]">
            <div className="mb-1 font-mono text-[11px] font-semibold tabular-nums text-muted">
              {s.at}
            </div>
            <div
              className={`rounded-lg border border-line px-3 py-2.5 ${
                s.sys ? "bg-card font-mono text-[12px] text-error" : "bg-[#f4f4f5]"
              }`}
            >
              {s.text}
            </div>
          </div>
        ))}
        {interim ? (
          <div className="max-w-[92%]">
            <div className="mb-1 font-mono text-[11px] font-semibold text-muted">
              hearing…
            </div>
            <div className="rounded-lg border border-dashed border-line px-3 py-2.5 text-muted">
              {interim}
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
});

export const SuggestionsPanel = memo(function SuggestionsPanel({
  cards,
  current,
  listening,
  agentError,
}: {
  cards: Suggestion[];
  current: Suggestion | null;
  listening: boolean;
  agentError: boolean;
}) {
  const [view, setView] = useState(0); // index of the card on screen
  const [following, setFollowing] = useState(true); // carousel keeps up with live

  // following = ride the live edge: new card (or resume) snaps the carousel
  // to newest
  useEffect(() => {
    if (following) setView(Math.max(0, cards.length - 1));
  }, [cards.length, following]);

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
            onClick={() => {
              setFollowing(false);
              setView((v) => Math.max(0, v - 1));
            }}
            disabled={cards.length === 0 || viewIndex <= 0}
            aria-label="Previous turn"
            title="Previous turn"
            className="flex h-6 w-6 items-center justify-center rounded-md border border-line text-[13px] leading-none text-ink hover:border-accent hover:text-accent disabled:border-line disabled:text-line disabled:hover:border-line disabled:hover:text-line"
          >
            ‹
          </button>
          <button
            type="button"
            onClick={() => setFollowing((f) => !f)}
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
            onClick={() => {
              setFollowing(false);
              setView((v) => Math.min(cards.length - 1, v + 1));
            }}
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
        {agentError ? (
          <p className="text-sm text-error">
            Search failed. k0 retries on your next line.
          </p>
        ) : null}

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
        ) : !agentError ? (
          <p className="text-sm text-muted">
            Start the conversation — k0 surfaces knowledge as you talk.
          </p>
        ) : null}
      </div>
    </section>
  );
});

export const TracePanel = memo(function TracePanel({
  trace,
}: {
  trace: TraceState | null;
}) {
  if (!trace) return null;
  return (
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
        {trace.lines.length === 0 ? (
          <span className="text-muted">waiting for the agent…</span>
        ) : null}
        {trace.lines.map((line, k) => (
          <div key={k} className="whitespace-pre-wrap wrap-break-word">
            {line}
          </div>
        ))}
      </div>
    </section>
  );
});

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  isGladiaCapable,
  startGladiaLive,
  type GladiaHandle,
} from "@/lib/gladia-live";
import { tidyTranscript, type Status } from "@/lib/call-shared";
import { useCallSession } from "./_cockpit/use-call-session";
import { OfflineBanner } from "./_cockpit/offline-banner";
import {
  SuggestionsPanel,
  TracePanel,
  TranscriptPanel,
} from "./_cockpit/panels";

export default function Home() {
  const session = useCallSession();
  const [status, setStatus] = useState<Status>("idle");

  const gladiaRef = useRef<GladiaHandle | null>(null);
  const activeRef = useRef(false);
  // transcription bills per LISTENING minute — silence costs the same as
  // speech, so 10 idle minutes auto-stop the session; restart mints a new one
  const IDLE_CUTOFF_MS = 10 * 60 * 1000;
  const lastFinalRef = useRef(0);
  const idleTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const { appendSegment, logSystem, setInterim, sessionIdRef } = session;

  useEffect(() => {
    return () => {
      activeRef.current = false;
      if (idleTimerRef.current) clearInterval(idleTimerRef.current);
      gladiaRef.current?.stop();
    };
  }, []);

  const stop = useCallback(() => {
    activeRef.current = false;
    if (idleTimerRef.current) {
      clearInterval(idleTimerRef.current);
      idleTimerRef.current = null;
    }
    gladiaRef.current?.stop();
    gladiaRef.current = null;
    setInterim("");
    setStatus("idle");
  }, [setInterim]);

  const startGladia = useCallback(async () => {
    setStatus("listening");
    activeRef.current = true;
    lastFinalRef.current = Date.now();
    // fire-and-forget warm-up — instance pays one-time init before the first
    // utterance finalizes: first card ~0.9s instead of ~6s
    fetch("/api/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ warmup: true }),
    }).catch(() => {});
    try {
      gladiaRef.current = await startGladiaLive({
        sessionId: sessionIdRef.current,
        onFinal: (raw) => {
          lastFinalRef.current = Date.now();
          const text = tidyTranscript(raw);
          if (text) appendSegment(text);
          setInterim("");
        },
        onInterim: (raw) => setInterim(tidyTranscript(raw)),
        onError: (message) => {
          activeRef.current = false;
          if (idleTimerRef.current) {
            clearInterval(idleTimerRef.current);
            idleTimerRef.current = null;
          }
          setStatus("unavailable");
          logSystem(`mic error: ${message}`);
        },
      });
      if (!activeRef.current) {
        // user hit Stop while the session was still minting
        gladiaRef.current?.stop();
        gladiaRef.current = null;
        return;
      }
      if (idleTimerRef.current) clearInterval(idleTimerRef.current);
      idleTimerRef.current = setInterval(() => {
        if (!activeRef.current) return;
        if (Date.now() - lastFinalRef.current > IDLE_CUTOFF_MS) {
          logSystem(
            "mic idle for 10 minutes — transcription stopped to save cost; press Start Listening to resume",
          );
          stop();
        }
      }, 30_000);
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
  }, [IDLE_CUTOFF_MS, appendSegment, logSystem, sessionIdRef, setInterim, stop]);

  const toggleListening = useCallback(() => {
    if (status === "listening") {
      stop();
      return;
    }
    session.dismissResumeOffer(); // starting a live call supersedes the offer
    // Gladia everywhere — browser SpeechRecognition mishears technical
    // vocabulary too often for an SA call, and mobile never had it anyway
    if (!isGladiaCapable()) {
      setStatus("unsupported");
      return;
    }
    startGladia();
  }, [status, stop, session.dismissResumeOffer, startGladia]);

  const listening = status === "listening";
  const streaming = session.current !== null;

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

      <button
        type="button"
        onClick={toggleListening}
        className={`mb-4.5 rounded-lg px-4 py-2.75 text-sm font-semibold text-white ${
          listening ? "bg-live hover:opacity-90" : "bg-ink hover:bg-[#333]"
        }`}
      >
        {listening ? "Stop Listening" : "Start Listening"}
      </button>

      <div className="grid grid-cols-1 gap-4.5 md:grid-cols-2">
        {/* dev visual aid — the transcript feeds the agent */}
        <TranscriptPanel
          segments={session.segments}
          interim={session.interim}
          status={status}
          resumeOffer={session.resumeOffer}
          onResume={session.resumeSession}
          onStartFresh={session.startFresh}
        />
        <SuggestionsPanel
          cards={session.cards}
          current={session.current}
          listening={listening}
          agentError={session.agentError}
        />
      </div>

      {/* survives NONE and failures, where no card dropdown ever lands */}
      <TracePanel trace={session.trace} />
    </div>
  );
}

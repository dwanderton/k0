"use client";

/**
 * Owns everything a call session is: transcript segments, cards, the query
 * loop, consumed/queried watermarks, localStorage write-through, and
 * resume + server backfill. Panels render what this returns; the engine
 * (mic) appends into it.
 */
import { useCallback, useEffect, useRef, useState, startTransition } from "react";
import {
  clock,
  loadLatestSnapshot,
  parseCard,
  saveSnapshot,
  splitStream,
  SNAP_LATEST,
  SNAP_PREFIX,
  SNAP_VERSION,
  type KbMode,
  type Segment,
  type SessionSnapshot,
  type Suggestion,
  type TraceState,
} from "@/lib/call-shared";

export function useCallSession() {
  const [segments, setSegments] = useState<Segment[]>([]);
  const [interim, setInterim] = useState("");
  const [current, setCurrent] = useState<Suggestion | null>(null);
  const [cards, setCards] = useState<Suggestion[]>([]); // oldest → newest
  const [agentError, setAgentError] = useState(false);
  // latest query's trace — survives NONE and failures, where no card (and
  // no per-card dropdown) ever lands
  const [trace, setTrace] = useState<TraceState | null>(null);
  const [resumeOffer, setResumeOffer] = useState<SessionSnapshot | null>(null);
  // state for the toggle UI, ref for the query loop — the loop reads the
  // value at fetch time without re-firing the segments effect
  const [mode, setModeState] = useState<KbMode>("all");
  const modeRef = useRef<KbMode>("all");
  const setMode = useCallback((m: KbMode) => {
    modeRef.current = m;
    setModeState(m);
  }, []);

  // per-tab session id (sessionStorage) — two tabs write two snapshot keys
  // instead of fighting over one
  const sessionIdRef = useRef("");
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
    return () => {
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
      v: SNAP_VERSION,
      sessionId: sessionIdRef.current,
      savedAt: Date.now(),
      segments,
      cards,
      consumed: consumedRef.current,
      lastCard: lastCardRef.current,
      mode,
    });
  }, [segments, cards, trace, mode]);

  const resumeSession = useCallback((snap: SessionSnapshot) => {
    sessionIdRef.current = snap.sessionId;
    sessionStorage.setItem("k0-session-id", snap.sessionId);
    // watermarks BEFORE state — the query effect must not re-fire on
    // restored segments
    queriedRef.current = snap.segments.length;
    consumedRef.current = snap.consumed;
    lastCardRef.current = snap.lastCard;
    setMode(snap.mode ?? "all");
    setSegments(snap.segments);
    setCards(snap.cards);
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
  }, [setMode]);

  const startFresh = useCallback(() => {
    try {
      const latest = localStorage.getItem(SNAP_LATEST);
      if (latest) localStorage.removeItem(SNAP_PREFIX + latest);
      localStorage.removeItem(SNAP_LATEST);
    } catch {}
    setResumeOffer(null);
  }, []);

  const dismissResumeOffer = useCallback(() => setResumeOffer(null), []);

  const appendSegment = useCallback((text: string) => {
    setSegments((s) => [...s, { id: s.length, at: clock(), text }]);
  }, []);

  /** mic failures land as timestamped sys lines in the transcript */
  const logSystem = useCallback((text: string) => {
    setSegments((s) => [...s, { id: s.length, at: clock(), text, sys: true }]);
  }, []);

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
            mode: modeRef.current,
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
          // per-chunk paints are non-urgent — never block input on them
          startTransition(() => {
            setCurrent((c) => (c && c.id === id ? { ...c, text: card, debug } : c));
            setTrace((t) => (t && t.turn === id ? { ...t, lines: debug } : t));
          });
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
          setTrace((t) => (t && t.turn === id ? { ...t, outcome: "failed" } : t));
        }
      } finally {
        inflightRef.current.delete(ctrl);
      }
    })();
  }, [segments]);

  return {
    segments,
    interim,
    setInterim,
    cards,
    current,
    trace,
    agentError,
    resumeOffer,
    mode,
    setMode,
    sessionIdRef,
    appendSegment,
    logSystem,
    resumeSession,
    startFresh,
    dismissResumeOffer,
  };
}

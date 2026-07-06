"use client";

/** App-level connectivity chrome — full-bleed top banner: red while
 *  offline, green "back online" confirmation that fades after 4s. */
import { useEffect, useState } from "react";

export function OfflineBanner({ callLive }: { callLive: boolean }) {
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

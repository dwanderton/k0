"use client";

/** One settled (or streaming) agent card: doc path, answer, quote with
 *  the highlight anchor marked, and the per-card trace dropdown. */
import { memo } from "react";
import { openDocs, parseCard, type Suggestion } from "@/lib/call-shared";

export const SuggestionCard = memo(function SuggestionCard({
  s,
}: {
  s: Suggestion;
}) {
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
        {p.answer ? <div className="mb-2 text-[14px]">{p.answer}</div> : null}
        {quote ? (
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
        ) : null}
        {s.debug.length > 0 ? (
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
        ) : null}
      </div>
    </div>
  );
});

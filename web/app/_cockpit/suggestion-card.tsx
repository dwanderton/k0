"use client";

/** One settled (or streaming) agent card: doc path, answer, quote with
 *  the highlight anchor marked, and the per-card trace dropdown. Customers
 *  mode adds story chrome: customer + industry eyebrow, stack chips, and
 *  the other retrieved stories as alternate proof-point rows. KB mode adds
 *  fine-print chrome: value, trade-offs, limitations, comparisons — the
 *  caveats an SA must not overpromise past. */
import { memo } from "react";
import {
  openDocs,
  parseCard,
  type KbGuideRef,
  type StoryRef,
  type Suggestion,
} from "@/lib/call-shared";

const samePost = (a: string, b: string) => {
  try {
    return new URL(a).pathname === new URL(b).pathname;
  } catch {
    return false;
  }
};

export const SuggestionCard = memo(function SuggestionCard({
  s,
}: {
  s: Suggestion;
}) {
  const p = parseCard(s.text);
  // primary = the story the model actually quoted, not retrieval's #1
  const primary: StoryRef | undefined = s.stories?.length
    ? (s.stories.find((st) => p.source && samePost(st.uri, p.source)) ??
      s.stories[0])
    : undefined;
  const alternates =
    primary && s.stories ? s.stories.filter((st) => st !== primary) : [];
  // kb mode: same pick rule — the guide the model quoted leads the card
  const guide: KbGuideRef | undefined = s.guides?.length
    ? (s.guides.find((g) => p.source && samePost(g.uri, p.source)) ??
      s.guides[0])
    : undefined;
  const relatedGuides =
    guide && s.guides ? s.guides.filter((g) => g !== guide) : [];
  const finePrint: [string, string[]][] = guide
    ? (
        [
          ["Value", guide.value ? [guide.value] : []],
          ["Trade-offs", guide.tradeoffs],
          ["Limitations", guide.limitations],
          ["Vs Alternatives", guide.comparisons],
        ] as [string, string[]][]
      ).filter(([, lines]) => lines.length > 0)
    : [];
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
          {primary ? (
            <span className="truncate">
              <span className="uppercase tracking-wider text-ink">
                {primary.customer}
              </span>
              {primary.industry ? ` · ${primary.industry}` : ""}
            </span>
          ) : guide ? (
            <span className="truncate text-ink">{guide.title}</span>
          ) : (
            <span className="truncate">{p.doc || "searching docs…"}</span>
          )}
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
        {guide && guide.products.length > 0 ? (
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            {guide.products.map((t) => (
              <span
                key={t}
                className="rounded-md border border-line bg-[#f4f4f5] px-1.5 py-0.5 font-mono text-[10px] font-semibold text-ink"
              >
                {t}
              </span>
            ))}
          </div>
        ) : null}
        {finePrint.length > 0 ? (
          <details open className="group/fp mt-3 border-t border-line pt-2">
            <summary className="flex cursor-pointer list-none items-center gap-1 font-mono text-[10px] font-semibold uppercase tracking-wider text-muted hover:text-ink">
              <span className="inline-block transition-transform group-open/fp:rotate-90">
                ▸
              </span>
              Fine Print
            </summary>
            <dl className="mt-2 flex flex-col gap-2">
              {finePrint.map(([h, lines]) => (
                <div key={h}>
                  <dt className="font-mono text-[10px] font-semibold uppercase tracking-wider text-muted">
                    {h}
                  </dt>
                  {lines.map((line, i) => (
                    <dd key={i} className="text-[12px] leading-snug">
                      {lines.length > 1 ? "· " : ""}
                      {line}
                    </dd>
                  ))}
                </div>
              ))}
            </dl>
          </details>
        ) : null}
        {relatedGuides.length > 0 ? (
          <div
            role="group"
            aria-label="Related guides"
            className="mt-3 border-t border-line pt-2"
          >
            <div className="mb-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-muted">
              Related Guides
            </div>
            {relatedGuides.map((g) => (
              <button
                key={g.uri}
                type="button"
                onClick={() => openDocs(g.uri)}
                title={`Open ${g.title}`}
                className="group/rel flex w-full items-baseline gap-2 rounded-md px-1 py-1 text-left hover:bg-[#f4f4f5]"
              >
                <span className="min-w-0 shrink-0 max-w-[55%] truncate text-[12px] font-semibold text-ink">
                  {g.title}
                </span>
                <span className="min-w-0 flex-1 truncate text-[12px] text-muted">
                  {g.value}
                </span>
                <span
                  aria-hidden="true"
                  className="shrink-0 text-[11px] text-muted group-hover/rel:text-accent"
                >
                  ↗
                </span>
              </button>
            ))}
          </div>
        ) : null}
        {primary &&
        (primary.vercelProducts.length > 0 || primary.otherTech.length > 0) ? (
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            {primary.vercelProducts.map((t) => (
              <span
                key={t}
                className="rounded-md border border-line bg-[#f4f4f5] px-1.5 py-0.5 font-mono text-[10px] font-semibold text-ink"
              >
                {t}
              </span>
            ))}
            {primary.otherTech.map((t) => (
              <span
                key={t}
                className="rounded-md border border-line px-1.5 py-0.5 font-mono text-[10px] text-muted"
              >
                {t}
              </span>
            ))}
          </div>
        ) : null}
        {primary?.journey?.solution ? (
          <details open className="group/arc mt-3 border-t border-line pt-2">
            <summary className="flex cursor-pointer list-none items-center gap-1 font-mono text-[10px] font-semibold uppercase tracking-wider text-muted hover:text-ink">
              <span className="inline-block transition-transform group-open/arc:rotate-90">
                ▸
              </span>
              Story arc
            </summary>
            <dl className="mt-2 flex flex-col gap-2">
              {(
                [
                  ["Where they were", primary.journey.before],
                  ["Where they were going", primary.journey.goal],
                  ["What needed to change", primary.journey.change],
                  ["How Vercel satisfied it", primary.journey.solution],
                ] as const
              ).map(([h, v]) =>
                v ? (
                  <div key={h}>
                    <dt className="font-mono text-[10px] font-semibold uppercase tracking-wider text-muted">
                      {h}
                    </dt>
                    <dd className="text-[12px] leading-snug">{v}</dd>
                  </div>
                ) : null,
              )}
            </dl>
          </details>
        ) : null}
        {alternates.length > 0 ? (
          <div
            role="group"
            aria-label="More proof points"
            className="mt-3 border-t border-line pt-2"
          >
            <div className="mb-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-muted">
              More proof points
            </div>
            {alternates.map((st) => (
              <button
                key={st.uri}
                type="button"
                onClick={() => openDocs(st.uri)}
                title={`Open ${st.customer} story`}
                className="group/alt flex w-full items-baseline gap-2 rounded-md px-1 py-1 text-left hover:bg-[#f4f4f5]"
              >
                <span className="shrink-0 text-[12px] font-semibold text-ink">
                  {st.customer}
                </span>
                {st.industry ? (
                  <span className="shrink-0 font-mono text-[10px] text-muted">
                    {st.industry}
                  </span>
                ) : null}
                <span className="min-w-0 flex-1 truncate text-[12px] text-muted">
                  {st.outcome}
                </span>
                <span
                  aria-hidden="true"
                  className="shrink-0 text-[11px] text-muted group-hover/alt:text-accent"
                >
                  ↗
                </span>
              </button>
            ))}
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

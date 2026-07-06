"use client";

/** Cockpit render-error boundary. The localStorage snapshot means a reload
 *  lands on the resume banner with the call intact — lead with that. */
export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="mx-auto w-full max-w-245 px-5 pt-8 pb-12">
      <div
        aria-hidden="true"
        className="mb-3 h-8.5 w-8.5 select-none rounded-lg bg-ink text-center font-mono text-[15px] font-bold leading-8.5 tracking-tight text-white"
      >
        k0
      </div>
      <div className="rounded-[10px] border border-error/30 bg-card p-5">
        <h2 className="text-[17px] font-bold tracking-tight">
          Something broke — your call is saved.
        </h2>
        <p className="mt-1 text-sm text-muted">
          Reload and k0 will offer to resume this session exactly where it
          left off.
        </p>
        {error.digest ? (
          <p className="mt-2 font-mono text-[11px] text-muted">
            ref {error.digest}
          </p>
        ) : null}
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-lg bg-ink px-4 py-2 text-sm font-semibold text-white hover:bg-[#333]"
          >
            Reload — resume call
          </button>
          <button
            type="button"
            onClick={reset}
            className="rounded-lg border border-line px-4 py-2 text-sm font-semibold text-ink hover:border-accent hover:text-accent"
          >
            Try again
          </button>
        </div>
      </div>
    </div>
  );
}

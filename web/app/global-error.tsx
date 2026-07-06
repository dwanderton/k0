"use client";

/** Fires only when the root layout itself throws — must render its own
 *  html/body and can't rely on globals.css, so styles are inline. */
export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string };
}) {
  return (
    <html lang="en">
      <body
        style={{
          fontFamily: "ui-sans-serif, system-ui, sans-serif",
          background: "#fafafa",
          color: "#000",
          display: "flex",
          minHeight: "100vh",
          alignItems: "center",
          justifyContent: "center",
          padding: 20,
        }}
      >
        <div
          style={{
            border: "1px solid rgba(229,72,77,0.3)",
            borderRadius: 10,
            background: "#fff",
            padding: 20,
            maxWidth: 480,
          }}
        >
          <h2 style={{ fontWeight: 700, fontSize: 17, margin: 0 }}>
            Something broke — your call is saved.
          </h2>
          <p style={{ color: "#666", fontSize: 14, margin: "6px 0 0" }}>
            Reload and k0 will offer to resume this session exactly where it
            left off.
          </p>
          {error.digest ? (
            <p style={{ color: "#666", fontSize: 11, fontFamily: "monospace" }}>
              ref {error.digest}
            </p>
          ) : null}
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              marginTop: 14,
              background: "#000",
              color: "#fff",
              border: 0,
              borderRadius: 8,
              padding: "8px 16px",
              fontSize: 14,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Reload — resume call
          </button>
        </div>
      </body>
    </html>
  );
}

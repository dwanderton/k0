import { streamText, stepCountIs, tool, type ToolSet } from "ai";
import { createMCPClient } from "@ai-sdk/mcp";
import { z } from "zod";
import { after } from "next/server";
import { checkBotId } from "botid/server";
import { getCachedDoc } from "@/lib/docs-cache";
import { retrieveWithInfo, type Candidate, type Backend } from "@/lib/retriever";
import { parkCard, isValidSessionId } from "@/lib/session-store";

export const maxDuration = 60;

/** MCP search returns synthesized snippets, NOT page text — quotes grounded
 *  in it never land the #:~:text= highlight. `<path>.md` IS the page. */
const readVercelDoc = tool({
  description:
    "Fetch the full verbatim markdown of a Vercel or Next.js docs page. For " +
    "Vercel docs pass the path only (e.g. 'fluid-compute' or 'ai-gateway' — " +
    "no domain, no /docs/, no .md). For Next.js docs pass the candidate's " +
    "full documentUri (e.g. 'https://nextjs.org/docs/app/getting-started'). " +
    "QUOTE and ANCHOR must be copied word-for-word from what this returns, " +
    "because only this is the real page text the browser highlight matches.",
  inputSchema: z.object({
    path: z
      .string()
      .describe("Docs path, e.g. 'fluid-compute' or 'functions/streaming'."),
  }),
  execute: async ({ path }) => {
    const raw = String(path ?? "").trim();
    // nextjs docs arrive as full documentUri; bare paths default to vercel
    const isNext = /(^|\/\/)nextjs\.org\//i.test(raw);
    const clean = raw
      .replace(/^https?:\/\/[^/]+/, "")
      .replace(/[#?].*$/, "")
      .replace(/\.md$/, "")
      .replace(/^\/+/, "")
      .replace(/^docs\//, "")
      .replace(/^\/+/, "");
    if (!clean) return "No path given.";
    // model-supplied path — reject traversal / non-slug before it hits a URL
    if (!/^[a-z0-9]([a-z0-9/-]*[a-z0-9])?$/i.test(clean) || clean.includes("..")) {
      return `Invalid docs path: ${clean}`;
    }
    const site = isNext
      ? { origin: "https://nextjs.org", host: "nextjs.org", source: "nextjs-docs" }
      : { origin: "https://vercel.com", host: "vercel.com", source: "vercel-docs" };
    const url = `${site.origin}/docs/${clean}.md`;
    // defense in depth — resolved URL must stay on an allow-listed docs host
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return `Invalid docs path: ${clean}`;
    }
    if (parsed.hostname !== site.host || !parsed.pathname.startsWith("/docs/")) {
      return `Refusing to fetch non-docs URL: ${url}`;
    }
    // cache key shape `<source>:<pathname>`. Verdict rides the first line of
    // the tool result → UI trace `← read_vercel_doc:` line + server logs.
    const cacheKey = `${site.source}:/docs/${clean}`;
    const cached = await getCachedDoc(cacheKey);
    console.log(`docs-cache ${cached ? "HIT" : "MISS"}: ${cacheKey}`);
    if (cached) {
      const body =
        cached.length > 16000
          ? cached.slice(0, 16000) + "\n…[truncated]"
          : cached;
      return `[docs-cache HIT ${cacheKey}]\n\n${body}`;
    }
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) return `Could not fetch ${url} (HTTP ${res.status}).`;
      const md = await res.text();
      // cap tool result — context budget
      const body =
        md.length > 16000 ? md.slice(0, 16000) + "\n…[truncated]" : md;
      return `[docs-cache MISS ${cacheKey} — fetched live]\n\n${body}`;
    } catch (err) {
      return `Could not fetch ${url}: ${String(err)}`;
    }
  },
});

// sort throughput not ttft — pipeline generation-bound (~1s of a ~2s card is
// token writing once pre-call retrieval deleted the search turn).
// gpt-5.4-mini: only model that reliably runs retrieval → quote; others loop
// re-searching or fabricate quotes.
const MODEL = "openai/gpt-5.4-mini";
const GATEWAY_OPTIONS = { gateway: { sort: "throughput" as const } };

/** MCP handshake once per warm instance — Fluid reuses instances; the
 *  per-utterance RTTs to mcp.vercel.com came out of the <1s first-content
 *  budget. Failure resets the cache so the next request retries. */
let mcpTools: Promise<ToolSet> | null = null;
function getMcpTools(token: string) {
  mcpTools ??= createMCPClient({
    transport: {
      type: "http",
      url: "https://mcp.vercel.com",
      headers: { Authorization: `Bearer ${token}` },
    },
  })
    .then(async (mcp) => (await mcp.tools()) as ToolSet)
    .catch((err) => {
      mcpTools = null;
      throw err;
    });
  return mcpTools;
}

const SYSTEM = `IDENTITY:
You are a live documentation assistant for Vercel Sales Engineers.
Surface exact relevant docs mid-call so SAs can quote with confidence.

CORE PRINCIPLES:
- All knowledge comes from CANDIDATES (pre-retrieved page excerpts in the
  message) or tools. Never answer from memory.
- Verbatim quotes from docs or NONE. Never paraphrase or fake certainty.

RETRIEVAL:
Each message carries CANDIDATES — excerpts retrieved for the newest line,
best first, with relevanceScore. Candidate content IS real page text (the
same .md the tools return). They are context, NOT evidence a question
exists.

TOOLS:
1. read_vercel_doc(path) → full page markdown. Use when the winning
   candidate's excerpt doesn't contain the exact sentence to quote.

FLOW:
1. Newest line asks about Vercel product/feature? → Continue. Else → NONE,
   no matter what the candidates say.
2. Pick the candidate that answers the newest line (usually the first;
   judge by content, not just score).
3. Exact quotable sentence in its excerpt? → answer directly, ZERO tool
   calls. DOC/SOURCE come from the candidate's documentUri.
4. Otherwise read_vercel_doc on that candidate's path, quote from the page.
5. No candidate answers it? → read_vercel_doc on the most plausible path,
   or NONE. Never invent.
6. Render QUOTE: exact words, no markdown syntax, no backticks.
7. ANCHOR: word-for-word from QUOTE, plain prose only.

CRITICAL RULES:
- Candidate excerpts and read_vercel_doc output are the ONLY quote sources.
- ANCHOR must appear on page as plain prose (no code punctuation).
- Small talk stays NONE even when candidates are attached.
- NONE is a complete reply, never a field value. No quotable sentence →
  reply the single word NONE; never emit DOC/ANSWER/QUOTE lines around it.

OUTPUT FORMAT (always):
DOC: [path from Source]
ANSWER: [1-2 sentence plain English answer]
QUOTE: [exact sentence from page]
ANCHOR: [substring inside QUOTE for browser highlight]
SOURCE: [full URL with #:~:text=ANCHOR]

Or reply: NONE`;

/** injected at step-budget end — long tool transcript makes models forget
 *  the output contract and answer in prose */
const FINAL_STEP = `${"\n\n"}TOOLS ARE DONE. Answer NOW from what you already read.
Reply in the EXACT DOC/ANSWER/QUOTE/ANCHOR/SOURCE format, or NONE.
No prose. No explanation. The format or NONE.`;

/** Card contract. Stream is line-oriented text, so zod validates the
 *  assembled card at finish — verdict lands in the trace; cross-field rules
 *  live here, not in prose checks. */
const OutputSchema = z
  .object({
    DOC: z.string().min(1),
    ANSWER: z.string().min(1),
    QUOTE: z.string().min(1),
    ANCHOR: z.string().min(1),
    SOURCE: z.url(), // zod 4: z.string().url() is deprecated
  })
  .refine((c) => c.QUOTE.toLowerCase().includes(c.ANCHOR.toLowerCase()), {
    message: "ANCHOR must appear inside QUOTE",
  })
  .refine((c) => c.SOURCE.includes("#:~:text="), {
    message: "SOURCE must carry a #:~:text= highlight fragment",
  })
  // browser matches fragment against RENDERED text — code punctuation never
  // renders, highlight silently misses
  .refine((c) => !/[`\[\]{}|<>]/.test(c.ANCHOR), {
    message: "ANCHOR must be plain prose — no backticks/brackets/pipes",
  })
  // half-refusal: DOC filled but NONE stuffed into fields — should have
  // been a bare NONE reply
  .refine((c) => ![c.ANSWER, c.QUOTE, c.ANCHOR].some((v) => /^none$/i.test(v.trim())), {
    message: "NONE inside card fields — reply must be bare NONE",
  });

function extractCard(text: string) {
  const field = (k: string) =>
    text.match(new RegExp(`^${k}:\\s*(.*)$`, "mi"))?.[1]?.trim() ?? "";
  return {
    DOC: field("DOC"),
    ANSWER: field("ANSWER"),
    QUOTE: field("QUOTE"),
    ANCHOR: field("ANCHOR"),
    SOURCE: field("SOURCE"),
  };
}

/** debug lines = NUL … \n — client splits them from card text into the grey
 *  trace. NUL never appears in prose. */
const DBG = "\u0000";
const oneline = (s: string, n = 160) =>
  s.replace(/\s+/g, " ").trim().slice(0, n);

export async function POST(req: Request) {
  // the scorecard IS a bot, deliberately — probes carry a shared secret
  // and skip BotID; rotate SCORECARD_PROBE_SECRET to revoke
  const probeSecret = process.env.SCORECARD_PROBE_SECRET;
  const isProbe =
    !!probeSecret && req.headers.get("x-k0-probe") === probeSecret;
  if (!isProbe) {
    const verdict = await checkBotId();
    if (verdict.isBot) {
      return Response.json({ error: "automated traffic" }, { status: 403 });
    }
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  // warm-up: client fires on Start Listening — ~3s one-time init (indexes +
  // ONNX) runs while the human is still talking. No LLM call, ~$0.
  if ((body as { warmup?: unknown })?.warmup === true) {
    await retrieveWithInfo("warm up", 1).catch(() => {});
    return new Response(null, { status: 204 });
  }

  const transcript = (body as { transcript?: unknown })?.transcript;
  if (typeof transcript !== "string" || !transcript.trim()) {
    return Response.json({ error: "transcript required" }, { status: 400 });
  }
  // session parking: with a valid sessionId+turn the finished card is
  // written to the session store even if the client dropped mid-stream
  const b = body as { sessionId?: unknown; turn?: unknown; heard?: unknown };
  const sessionId = isValidSessionId(b.sessionId) ? b.sessionId : null;
  const turn =
    typeof b.turn === "number" && Number.isInteger(b.turn) && b.turn >= 0
      ? b.turn
      : null;
  const heard = typeof b.heard === "string" ? b.heard.slice(0, 500) : "";

  // pre-call retrieval — infrastructure, not a model decision. Top-k excerpts
  // ride the FIRST turn, so the fast path cards in one generation.
  let candidates: Candidate[] = [];
  let retrievalFailed = false;
  let retrievalMs = 0;
  let retrieverBackend: Backend | null = null;
  let coldInitMs: number | null = null;
  {
    const t0 = performance.now();
    try {
      const r = await retrieveWithInfo(transcript, 2);
      candidates = r.candidates;
      retrieverBackend = r.backend;
      coldInitMs = r.coldInitMs ?? null;
      // >0.95 top score → send it alone. Gold run cited #1 almost
      // exclusively; second excerpt is ~900 tokens dead prefill.
      if (candidates.length > 1 && candidates[0].relevanceScore > 0.95) {
        candidates = [candidates[0]];
      }
    } catch (err) {
      retrievalFailed = true;
      console.error("retrieval failed (all backends):", err);
    }
    retrievalMs = Math.round(performance.now() - t0);
  }

  const tools: ToolSet = {
    // MCP search retired from the fast path (pre-call retrieval replaced it);
    // a FAILED retriever — not an empty result — re-enables it below.
    read_vercel_doc: readVercelDoc,
  };
  let fallbackNote = "";
  if (retrievalFailed) {
    const token = process.env.VERCEL_MCP_TOKEN;
    if (token) {
      try {
        const all = await getMcpTools(token);
        for (const [name, t] of Object.entries(all)) {
          if (name === "search_vercel_documentation") tools[name] = t;
        }
        fallbackNote = "⚠ retrieval failed → MCP search fallback";
      } catch {
        fallbackNote = "⚠ retrieval failed, MCP fallback unavailable";
      }
    } else {
      fallbackNote = "⚠ retrieval failed, no fallback (VERCEL_MCP_TOKEN unset)";
    }
  }

  const candidatesBlock = retrievalFailed
    ? "CANDIDATES: retrieval unavailable — fall back to search_vercel_documentation if present, then read_vercel_doc."
    : candidates.length === 0
      ? "CANDIDATES: none above relevance floor — likely small talk (NONE) or use read_vercel_doc if it is a real Vercel question."
      : `CANDIDATES (best first):\n${candidates
          .map(
            (c, i) =>
              `[${i + 1}] ${c.documentUri} · ${c.documentTitle} · relevanceScore ${c.relevanceScore}\n${c.content}`,
          )
          .join("\n\n")}`;

  const makeAttempt = () => streamText({
    model: MODEL,
    providerOptions: GATEWAY_OPTIONS,
    system: SYSTEM,
    prompt: `${transcript}\n\n${candidatesBlock}`,
    tools,
    // fast path is one turn, read_vercel_doc escape hatch 2-3; old cap of 8
    // was sized for search-loop pathology pre-call retrieval removed
    stopWhen: stepCountIs(4),
    prepareStep: ({ stepNumber }) =>
      stepNumber >= 2
        ? { toolChoice: "none" as const, instructions: SYSTEM + FINAL_STEP }
        : undefined,
    onError: (event) => console.error("agent stream error:", event.error),
  });

  // NONE-retry: residual failure mode is the model refusing despite a
  // high-confidence candidate. Text held back while it still looks like a
  // bare NONE (cards start "DOC:" — hold costs one chunk max); a finished
  // NONE with top candidate above RETRY_FLOOR gets exactly one regeneration.
  // 0.85: gold hits cluster ≥0.88, observed refusals sat at 0.87-0.89 just
  // under the old 0.9; controls peak ~0.56 so no false-positive exposure.
  const RETRY_FLOOR = 0.85;
  const topScore = candidates[0]?.relevanceScore ?? 0;
  const encoder = new TextEncoder();

  // The agent loop lives OUTSIDE the stream so a client disconnect cancels
  // delivery, not the work: enqueues become no-ops, the turn finishes under
  // after(), and the card parks for backfill.
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
  let clientGone = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
    },
    cancel() {
      clientGone = true;
    },
  });
  const send = (bytes: Uint8Array) => {
    if (clientGone) return;
    try {
      controllerRef?.enqueue(bytes);
    } catch {
      clientGone = true;
    }
  };
  const closeStream = () => {
    if (clientGone) return;
    try {
      controllerRef?.close();
    } catch {
      // already closed
    }
  };
  const traceLines: string[] = [];

  const work = (async () => {
    const dbg = (m: string) => {
      traceLines.push(m);
      send(encoder.encode(`${DBG}${m}\n`));
    };
    dbg(`model: ${MODEL} · throughput · retriever: ${retrieverBackend ?? "unavailable"}`);
      if (coldInitMs != null) dbg(`❄ cold init ${coldInitMs}ms`);
      dbg(
        retrievalFailed
          ? fallbackNote
          : `⚡ retrieved ${candidates.length} candidate${candidates.length === 1 ? "" : "s"} in ${retrievalMs}ms${
              candidates.length
                ? ` · top: ${candidates[0].documentUri.replace("https://", "")} (${candidates[0].relevanceScore})`
                : ""
            }`,
      );

    let finalAnswer = "";
    try {
      for (let attempt = 1; attempt <= 2; attempt++) {
          const result = makeAttempt();
          let step = 0;
          let reasoning = "";
          let held = "";
          let holding = true;
          let emitted = "";
          const flushReasoning = () => {
            let nl: number;
            while ((nl = reasoning.indexOf("\n")) >= 0) {
              const line = reasoning.slice(0, nl).trim();
              reasoning = reasoning.slice(nl + 1);
              if (line) dbg(`· ${line}`);
            }
          };
          const flushHeld = () => {
            if (held) {
              send(encoder.encode(held));
              emitted += held;
              held = "";
            }
            holding = false;
          };

          for await (const part of result.stream) {
            switch (part.type) {
              case "start-step":
                dbg(`▸ step ${++step}`);
                break;
              case "reasoning-delta":
                reasoning += part.text;
                flushReasoning();
                break;
              case "reasoning-end":
                if (reasoning.trim()) dbg(`· ${oneline(reasoning)}`);
                reasoning = "";
                break;
              case "tool-call":
                dbg(`→ ${part.toolName}(${oneline(JSON.stringify(part.input), 120)})`);
                break;
              case "tool-result":
                dbg(
                  `← ${part.toolName}: ${oneline(
                    typeof part.output === "string"
                      ? part.output
                      : JSON.stringify(part.output),
                  )}`,
                );
                break;
              case "tool-error":
                // failed MCP call may mean stale session — drop cache so the
                // next request re-handshakes
                if (part.toolName === "search_vercel_documentation") {
                  mcpTools = null;
                }
                dbg(`⚠ ${part.toolName} errored: ${oneline(String(part.error))}`);
                break;
              case "finish-step": {
                // per-step cost → trace → scorecard cost-per-insight
                const gw = part.providerMetadata?.gateway as
                  | { cost?: string | number }
                  | undefined;
                dbg(
                  `✓ step ${step}: ${part.finishReason}` +
                    (gw?.cost != null ? ` · $${gw.cost}` : ""),
                );
                break;
              }
              case "text-delta": {
                if (!holding) {
                  send(encoder.encode(part.text));
                  emitted += part.text;
                  break;
                }
                held += part.text;
                const t = held.trimStart().toUpperCase();
                const maybeNone =
                  t === "" || "NONE".startsWith(t) || (t.startsWith("NONE") && t.length <= 8);
                if (!maybeNone) flushHeld();
                break;
              }
              case "finish":
                dbg(
                  `■ done: ${part.finishReason} · tokens ${part.totalUsage.inputTokens ?? "?"}/${part.totalUsage.outputTokens ?? "?"}`,
                );
                break;
              case "error":
                dbg(`⚠ error: ${oneline(String(part.error))}`);
                break;
            }
          }

          const heldNone = holding && held.trim().toUpperCase().startsWith("NONE");
          if (heldNone && attempt === 1 && !retrievalFailed && topScore > RETRY_FLOOR) {
            dbg(`⟲ NONE despite top candidate ${topScore} — retrying once`);
            continue; // discard the held NONE; second attempt streams fresh
          }
          if (holding) flushHeld(); // NONE (kept) or a short real answer
          finalAnswer = emitted;
          break;
        }

        // zod verdict rides the trace — bad cards visible in the UI dropdown,
        // countable by the scorecard
        if (finalAnswer.trim() && !finalAnswer.trim().toUpperCase().startsWith("NONE")) {
          const check = OutputSchema.safeParse(extractCard(finalAnswer));
          dbg(
            check.success
              ? "✓ card valid (zod)"
              : `⚠ card invalid (zod): ${check.error.issues
                  .map((i) => `${i.path.join(".") || "card"}: ${i.message}`)
                  .join("; ")
                  .slice(0, 200)}`,
          );
        }
    } catch (err) {
      dbg(`⚠ stream failed: ${oneline(String(err))}`);
    } finally {
      // MCP client is shared across requests — never close it here; close
      // only the response stream (the client may already be gone)
      closeStream();
    }

    // park AFTER stream close — parking latency never delays a connected
    // client. Only renderable cards park: NONEs and half-refusals don't.
    if (sessionId && turn !== null && /^DOC:/im.test(finalAnswer)) {
      const c = extractCard(finalAnswer);
      const renderable = [c.ANSWER, c.QUOTE].some(
        (v) => v && !/^none$/i.test(v.trim()),
      );
      if (renderable) {
        try {
          await parkCard(sessionId, {
            turn,
            at: new Date().toISOString(),
            heard,
            text: finalAnswer,
            debug: traceLines.slice(-40),
          });
          console.log(`parked card session=${sessionId} turn=${turn}`);
        } catch (err) {
          console.error("card park failed:", err);
        }
      }
    }
  })();
  // keep the function alive until the turn finishes and parks, even after
  // the client disconnects
  after(work);

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

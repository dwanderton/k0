import { streamText, stepCountIs, tool, type ToolSet } from "ai";
import { createMCPClient } from "@ai-sdk/mcp";
import { z } from "zod";
import { getCachedDoc } from "@/lib/docs-cache";
import { retrieve, type Candidate } from "@/lib/retriever";

export const maxDuration = 60;

/** Fetch the real, verbatim markdown of a Vercel docs page. The MCP search
 *  returns synthesized snippet captions, NOT page text — so quotes grounded in
 *  search never appear on the page and the #:~:text= highlight never lands.
 *  Every docs path is also served as markdown at `<path>.md`; that IS the page. */
const readVercelDoc = tool({
  description:
    "Fetch the full verbatim markdown of a Vercel docs page. Pass the docs " +
    "path only (e.g. 'fluid-compute' or 'ai-gateway' — no domain, no /docs/, " +
    "no .md). Call this AFTER search_vercel_documentation locates the page: " +
    "QUOTE and ANCHOR must be copied word-for-word from what this returns, " +
    "because only this is the real page text the browser highlight matches.",
  inputSchema: z.object({
    path: z
      .string()
      .describe("Docs path, e.g. 'fluid-compute' or 'functions/streaming'."),
  }),
  execute: async ({ path }) => {
    const clean = String(path ?? "")
      .trim()
      .replace(/^https?:\/\/[^/]+/, "") // strip origin
      .replace(/[#?].*$/, "") // strip fragment/query
      .replace(/\.md$/, "") // strip .md
      .replace(/^\/+/, "") // strip leading slashes
      .replace(/^docs\//, "") // strip docs/
      .replace(/^\/+/, "");
    if (!clean) return "No path given.";
    // The model supplies this path — reject traversal / anything that isn't a
    // plain docs slug before it reaches a fetch URL.
    if (!/^[a-z0-9]([a-z0-9/-]*[a-z0-9])?$/i.test(clean) || clean.includes("..")) {
      return `Invalid docs path: ${clean}`;
    }
    const url = `https://vercel.com/docs/${clean}.md`;
    // Defense in depth: whatever the path resolves to, it must stay on
    // vercel.com/docs — never fetch an arbitrary host.
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return `Invalid docs path: ${clean}`;
    }
    if (parsed.hostname !== "vercel.com" || !parsed.pathname.startsWith("/docs/")) {
      return `Refusing to fetch non-Vercel-docs URL: ${url}`;
    }
    // Cache first: the docs-cache stores pages as `<source>:<pathname>`
    // (e.g. "vercel-docs:/docs/functions"). A hit skips the network round
    // trip entirely; a miss falls through to the live fetch. The verdict is
    // the first line of the tool result, so it lands in the UI trace's
    // `← read_vercel_doc:` line and in server logs.
    const cacheKey = `vercel-docs:/docs/${clean}`;
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
      // Cap to keep the tool result inside a sane context budget.
      const body =
        md.length > 16000 ? md.slice(0, 16000) + "\n…[truncated]" : md;
      return `[docs-cache MISS ${cacheKey} — fetched live]\n\n${body}`;
    } catch (err) {
      return `Could not fetch ${url}: ${String(err)}`;
    }
  },
});

// Gateway sorted for output THROUGHPUT: the pipeline is generation-bound —
// stage timing showed ~1s of a ~2s card is the model writing tokens, so ttft
// optimized the wrong stage once pre-call retrieval deleted the search turn.
// gpt-5.4-mini is the one model that reliably runs the retrieval -> quote
// flow; others either loop re-searching or fabricate quotes (see git history).
const MODEL = "openai/gpt-5.4-mini";
const GATEWAY_OPTIONS = { gateway: { sort: "throughput" as const } };

/** MCP handshake + tool listing once per warm instance, not once per
 *  utterance — Fluid Compute reuses instances across requests, so every turn
 *  after the first skips the round trips to mcp.vercel.com. Those RTTs came
 *  straight out of the <1s first-content budget on every single query.
 *  On failure the cache resets so the next request retries the handshake. */
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

OUTPUT FORMAT (always):
DOC: [path from Source]
ANSWER: [1-2 sentence plain English answer]
QUOTE: [exact sentence from page]
ANCHOR: [substring inside QUOTE for browser highlight]
SOURCE: [full URL with #:~:text=ANCHOR]

Or reply: NONE`;

/** Injected when the step budget runs out — the long tool transcript makes
 *  models forget the output contract and answer in prose. */
const FINAL_STEP = `${"\n\n"}TOOLS ARE DONE. Answer NOW from what you already read.
Reply in the EXACT DOC/ANSWER/QUOTE/ANCHOR/SOURCE format, or NONE.
No prose. No explanation. The format or NONE.`;

/** The card contract. The stream is line-oriented text (the client parses it
 *  as it streams), so zod validates the assembled card at finish — the
 *  verdict lands in the trace, and cross-field rules (ANCHOR inside QUOTE,
 *  SOURCE carries the highlight fragment) live here, not in prose checks. */
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
  // The browser matches the fragment against RENDERED page text — code
  // punctuation in the anchor (backticks, brackets, pipes) never renders,
  // so the highlight silently fails to land.
  .refine((c) => !/[`\[\]{}|<>]/.test(c.ANCHOR), {
    message: "ANCHOR must be plain prose — no backticks/brackets/pipes",
  });

/** Pull the card fields out of the streamed text for validation. */
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

/** Debug lines start with NUL and end with \n; the client splits them out of the
 *  card text and renders them as a light-grey trace. NUL never appears in prose. */
const DBG = "\u0000";
const oneline = (s: string, n = 160) =>
  s.replace(/\s+/g, " ").trim().slice(0, n);

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const transcript = (body as { transcript?: unknown })?.transcript;
  if (typeof transcript !== "string" || !transcript.trim()) {
    return Response.json({ error: "transcript required" }, { status: 400 });
  }

  // Pre-call retrieval — infrastructure, not a model decision. Embeds the
  // unconsumed tail (the client's transcript GC keeps it short/on-topic)
  // and hands top-k page excerpts to the model's FIRST turn, so the fast
  // path cards in one generation.
  let candidates: Candidate[] = [];
  let retrievalFailed = false;
  let retrievalMs = 0;
  {
    const t0 = performance.now();
    try {
      // retrieve() deadlines only its embed call — the one-time index load
      // on a cold instance may take seconds and must not misfire the fallback.
      candidates = await retrieve(transcript, 2);
    } catch (err) {
      retrievalFailed = true;
      console.error("retrieval failed:", err);
    }
    retrievalMs = Math.round(performance.now() - t0);
  }

  const tools: ToolSet = {
    // search_vercel_documentation (Vercel MCP) — retired from the fast path
    // in favor of pre-call local retrieval. Kept as the explicit recovery
    // path: a FAILED retriever (not an empty result) re-enables it below.
    // Re-enable permanently by uncommenting:
    // ...Object.fromEntries(
    //   Object.entries(await getMcpTools(process.env.VERCEL_MCP_TOKEN!)).filter(
    //     ([name]) => ["search_vercel_documentation"].includes(name),
    //   ),
    // ),
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

  const result = streamText({
    model: MODEL,
    providerOptions: GATEWAY_OPTIONS,
    system: SYSTEM,
    prompt: `${transcript}\n\n${candidatesBlock}`,
    tools,
    // Fast path is one turn; the read_vercel_doc escape hatch two-three.
    // The old cap of 8 was sized for search-loop pathology that pre-call
    // retrieval removes.
    stopWhen: stepCountIs(4),
    prepareStep: ({ stepNumber }) =>
      stepNumber >= 2
        ? { toolChoice: "none" as const, instructions: SYSTEM + FINAL_STEP }
        : undefined,
    onError: (event) => console.error("agent stream error:", event.error),
  });

  // Interleave the model's reasoning/tool trace (as NUL-prefixed debug lines)
  // with the answer text, so the client can show what the agent is thinking.
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const dbg = (m: string) =>
        controller.enqueue(encoder.encode(`${DBG}${m}\n`));
      let reasoning = "";
      const flushReasoning = () => {
        let nl: number;
        while ((nl = reasoning.indexOf("\n")) >= 0) {
          const line = reasoning.slice(0, nl).trim();
          reasoning = reasoning.slice(nl + 1);
          if (line) dbg(`· ${line}`);
        }
      };
      let step = 0;
      let answer = ""; // accumulated card text, validated at finish
      try {
        dbg(`model: ${MODEL} · throughput · retriever: local`);
        dbg(
          retrievalFailed
            ? fallbackNote
            : `⚡ retrieved ${candidates.length} candidate${candidates.length === 1 ? "" : "s"} in ${retrievalMs}ms${
                candidates.length
                  ? ` · top: ${candidates[0].documentUri.replace("https://", "")} (${candidates[0].relevanceScore})`
                  : ""
              }`,
        );
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
              // A failed MCP call can mean the cached session went stale —
              // drop the cache so the next request re-handshakes.
              if (part.toolName === "search_vercel_documentation") {
                mcpTools = null;
              }
              dbg(`⚠ ${part.toolName} errored: ${oneline(String(part.error))}`);
              break;
            case "finish-step": {
              // Gateway reports per-step cost in providerMetadata; surface it
              // so the scorecard can compute cost-per-insight from the trace.
              const gw = part.providerMetadata?.gateway as
                | { cost?: string | number }
                | undefined;
              dbg(
                `✓ step ${step}: ${part.finishReason}` +
                (gw?.cost != null ? ` · $${gw.cost}` : ""),
              );
              break;
            }
            case "text-delta":
              answer += part.text;
              controller.enqueue(encoder.encode(part.text));
              break;
            case "finish": {
              dbg(
                `■ done: ${part.finishReason} · tokens ${part.totalUsage.inputTokens ?? "?"}/${part.totalUsage.outputTokens ?? "?"}`,
              );
              // Validate the assembled card against the output contract —
              // the verdict rides the trace so bad cards are visible in the
              // UI dropdown and countable by the scorecard.
              if (answer.trim() && !answer.trim().toUpperCase().startsWith("NONE")) {
                const check = OutputSchema.safeParse(extractCard(answer));
                dbg(
                  check.success
                    ? "✓ card valid (zod)"
                    : `⚠ card invalid (zod): ${check.error.issues
                      .map((i) => `${i.path.join(".") || "card"}: ${i.message}`)
                      .join("; ")
                      .slice(0, 200)}`,
                );
              }
              break;
            }
            case "error":
              dbg(`⚠ error: ${oneline(String(part.error))}`);
              break;
          }
        }
      } catch (err) {
        dbg(`⚠ stream failed: ${oneline(String(err))}`);
      } finally {
        // The MCP client is shared across requests now — never close it here;
        // it lives as long as the warm instance does.
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

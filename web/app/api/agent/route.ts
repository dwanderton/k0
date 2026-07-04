import { streamText, stepCountIs, tool, type ToolSet } from "ai";
import { createMCPClient } from "@ai-sdk/mcp";
import { z } from "zod";
import { getCachedDoc } from "@/lib/docs-cache";

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
    // trip entirely; a miss falls through to the live fetch.
    const cached = await getCachedDoc(`vercel-docs:/docs/${clean}`);
    if (cached) {
      return cached.length > 16000
        ? cached.slice(0, 16000) + "\n…[truncated]"
        : cached;
    }
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) return `Could not fetch ${url} (HTTP ${res.status}).`;
      const md = await res.text();
      // Cap to keep the tool result inside a sane context budget.
      return md.length > 16000 ? md.slice(0, 16000) + "\n…[truncated]" : md;
    } catch (err) {
      return `Could not fetch ${url}: ${String(err)}`;
    }
  },
});

// Routed through the gateway's lowest time-to-first-token provider. gpt-5.4-mini
// is the one model that reliably runs the search -> read_vercel_doc -> quote
// flow; others either loop re-searching or fabricate quotes (see git history).
const MODEL = "openai/gpt-5.4-mini";
const GATEWAY_OPTIONS = { gateway: { sort: "ttft" as const } };

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
- All knowledge comes from search tools. Never answer from memory.
- Do not assume topics are out of scope without searching first.
- Verbatim quotes from docs or NONE. Never paraphrase or fake certainty.

TOOLS (in order):
1. search_vercel_documentation(query) → returns relevanceScore + Source paths
2. read_vercel_doc(path) → returns page markdown for quoting

FLOW:
1. Newest line mentions Vercel product/feature? → Continue. Else → NONE.
2. If vague (e.g., "it's slow"), use 2-3 prior lines for context.
3. search_vercel_documentation with exact SA line + context.
4. relevanceScore < 0.75? → NONE.
5. Call read_vercel_doc on best Source path.
6. Find exact sentence in markdown matching the answer.
7. Render QUOTE: exact words, no markdown syntax, no backticks.
8. ANCHOR: word-for-word from QUOTE, plain prose only.

CRITICAL RULES:
- Pass SA's EXACT line to search (don't rephrase).
- Never quote search snippets (they're captions, not real text).
- Only quote from read_vercel_doc output.
- 0.75 relevanceScore threshold is hard stop.
- ANCHOR must appear on page as plain prose (no code punctuation).
- Unfamiliar products (Eve, v0, BotID, Fluid, Workflows)? Always search.

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

  const token = process.env.VERCEL_MCP_TOKEN;
  if (!token) {
    return Response.json(
      { error: "VERCEL_MCP_TOKEN is not configured" },
      { status: 503 },
    );
  }

  const all = await getMcpTools(token);
  // From the MCP, keep only the docs search — the full surface (24 tools —
  // deployments, projects, toolbar…) bloats every request and slows the loop.
  // web_fetch_vercel_url is dropped on purpose — it fetches protected
  // deployment URLs, not docs pages (every /docs/ URL errors).
  // The verbatim page text comes from our own read_vercel_doc (.md fetch),
  // because MCP search only returns synthesized snippet captions.
  // TODO: we are manually filtering the toolset here, but the API key can take destructive actions
  const tools: ToolSet = {
    ...Object.fromEntries(
      Object.entries(all).filter(([name]) =>
        ["search_vercel_documentation"].includes(name),
      ),
    ),
    read_vercel_doc: readVercelDoc,
  };

  const result = streamText({
    model: MODEL,
    providerOptions: GATEWAY_OPTIONS,
    system: SYSTEM,
    prompt: transcript,
    tools,
    stopWhen: stepCountIs(8),
    // Some models spend every step re-searching and never emit text — after
    // step 5, cut tool access AND restate the output contract: by then the
    // context is thousands of tokens of .md dumps and models drift into
    // answering in prose, which the client can't parse into a card.
    prepareStep: ({ stepNumber }) =>
      stepNumber >= 5
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
        dbg(`model: ${MODEL} · ttft`);
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

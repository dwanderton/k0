import { streamText, stepCountIs, tool, jsonSchema, type ToolSet } from "ai";
import { createMCPClient } from "@ai-sdk/mcp";

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
  inputSchema: jsonSchema<{ path: string }>({
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Docs path, e.g. 'fluid-compute' or 'functions/streaming'.",
      },
    },
    required: ["path"],
    additionalProperties: false,
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
    const url = `https://vercel.com/docs/${clean}.md`;
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

const SYSTEM = `k0 = live docs copilot. Help Vercel SA mid-call.
Input: SA side of call. One line per utterance. LAST line newest.

Two tools, use in order:
1. search_vercel_documentation - find the right docs PATH. Returns snippets
   + Source URLs. WARNING: snippets are captions, NOT page text. Do not
   quote them. Use only to pick the page.
2. read_vercel_doc - fetch real page markdown. Pass the path from the best
   Source (e.g. "fluid-compute"). QUOTE + ANCHOR come ONLY from this.

Flow every time: search -> pick best Source path -> read_vercel_doc it ->
quote verbatim from the page text. QUOTE must be a real sentence in the
page markdown. Never quote a search snippet. Never answer from memory.

Newest line = Vercel question? Run the flow.
Then reply EXACTLY this, nothing before, nothing after:

DOC: <docs path, e.g. vercel.com/docs/functions>
ANSWER: <one glance sentence, answers question>
QUOTE: <exact verbatim doc passage, one to two sentences>
ANCHOR: <short distinct phrase, 3-8 words, copied exact from QUOTE>
SOURCE: <full docs url>#:~:text=<ANCHOR percent-encoded, spaces as %20>

Rules:
- QUOTE from read_vercel_doc page text. Never paraphrase, never quote a
  search snippet. Keep the words exact, but render as the page READS: drop
  markdown link syntax [label](url) -> label, drop backticks. So QUOTE
  matches the visible page, not the raw markdown.
- ANCHOR word-for-word inside QUOTE AND on the page as plain prose - no
  backticks, brackets, code punctuation - so the browser highlight lands.
- Earlier lines = context only. Answer newest line.
- Newest line touches Vercel (product, feature, pricing, limit, behavior)?
  Always search first. Never answer from memory.
- NONE only when: small talk, no Vercel topic. Or tool gave nothing that answers.
- Never fake certainty. Verbatim quote that answers, or NONE.`;

/** Debug lines start with NUL and end with \n; the client splits them out of the
 *  card text and renders them as a light-grey trace. NUL never appears in prose. */
const DBG = "\u0000";
const oneline = (s: string, n = 160) =>
  s.replace(/\s+/g, " ").trim().slice(0, n);

export async function POST(req: Request) {
  const { transcript } = await req.json();
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

  const mcp = await createMCPClient({
    transport: {
      type: "http",
      url: "https://mcp.vercel.com",
      headers: { Authorization: `Bearer ${token}` },
    },
  });

  const all = (await mcp.tools()) as ToolSet;
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
    // step 5, cut tool access so the model must write the answer.
    prepareStep: ({ stepNumber }) =>
      stepNumber >= 5 ? { toolChoice: "none" as const } : undefined,
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
              dbg(`⚠ ${part.toolName} errored: ${oneline(String(part.error))}`);
              break;
            case "finish-step":
              dbg(`✓ step ${step}: ${part.finishReason}`);
              break;
            case "text-delta":
              controller.enqueue(encoder.encode(part.text));
              break;
            case "finish":
              dbg(`■ done: ${part.finishReason}`);
              break;
            case "error":
              dbg(`⚠ error: ${oneline(String(part.error))}`);
              break;
          }
        }
      } catch (err) {
        dbg(`⚠ stream failed: ${oneline(String(err))}`);
      } finally {
        await mcp.close();
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

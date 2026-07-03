import { streamText, stepCountIs, type ToolSet } from "ai";
import { createMCPClient } from "@ai-sdk/mcp";

export const maxDuration = 60;

const DEFAULT_MODEL = "zai/glm-4.7";

/** Every model routes through the gateway's lowest time-to-first-token provider. */
const GATEWAY_OPTIONS = {
  gateway: {
    sort: "ttft" as const,
  },
};

/** Model spectrum: speed ↔ capability. Keys are what the client sends. */
const SPECTRUM: Record<
  "fastest" | "gptoss" | "qwen" | "gemini" | "fable",
  { model?: string }
> = {
  fastest: {},
  gptoss: { model: "openai/gpt-oss-120b" },
  qwen: { model: "alibaba/qwen-3-32b" },
  gemini: { model: "google/gemini-3-pro-preview" },
  fable: { model: "anthropic/claude-fable-5" },
};

type SpectrumKey = keyof typeof SPECTRUM;

const SYSTEM = `You are k0, a live knowledge-base copilot for a Vercel Solutions Architect mid-call.
Input: the SA's side of the call, one utterance per line. The LAST line is the newest.
If the newest line contains or restates a customer question about Vercel, answer it from
Vercel's documentation: search with the documentation tools first, then respond in EXACTLY
this format, nothing before or after:

DOC: <docs path, like vercel.com/docs/functions>
ANSWER: <one glanceable sentence answering the question>
QUOTE: <the exact verbatim passage from the docs that answers it, one to two sentences>
ANCHOR: <a short distinctive phrase of 3-8 words copied exactly from QUOTE>
SOURCE: <full docs url>#:~:text=<ANCHOR percent-encoded, spaces as %20>

Rules:
- QUOTE is verbatim from the documentation. Never paraphrase inside QUOTE.
- ANCHOR must appear word-for-word inside QUOTE — the browser uses it to highlight
  the passage, and the UI uses it to mark the card.
- Earlier lines are context only; answer the newest line.
- If the newest line touches anything about Vercel — products, features, pricing,
  limits, behavior — ALWAYS call search_vercel_documentation before deciding.
- Respond NONE only when the newest line is small talk with no Vercel topic, or
  when you searched and the results genuinely do not answer the question.
- Never fake certainty: a verbatim quote that answers the question, or NONE.`;

export async function POST(req: Request) {
  const { transcript, model } = await req.json();
  if (typeof transcript !== "string" || !transcript.trim()) {
    return Response.json({ error: "transcript required" }, { status: 400 });
  }
  const choice: SpectrumKey =
    typeof model === "string" && model in SPECTRUM
      ? (model as SpectrumKey)
      : "fastest";
  const spectrum = SPECTRUM[choice];

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
  // Docs tools only: the full Vercel MCP surface (24 tools — deployments,
  // projects, toolbar…) bloats every request and slows the tool loop.
  // TODO: we are manually filtering the toolset here, but the API key can take destructive actions
  const tools: ToolSet = Object.fromEntries(
    Object.entries(all).filter(([name]) =>
      ["search_vercel_documentation", "web_fetch_vercel_url"].includes(name),
    ),
  );

  const result = streamText({
    model: spectrum.model ?? DEFAULT_MODEL,
    providerOptions: GATEWAY_OPTIONS,
    system: SYSTEM,
    prompt: transcript,
    tools,
    stopWhen: stepCountIs(8),
    // Some models spend every step re-searching and never emit text — after
    // step 5, cut tool access so the model must write the answer.
    prepareStep: ({ stepNumber }) =>
      stepNumber >= 5 ? { toolChoice: "none" as const } : undefined,
    onFinish: () => mcp.close(),
    onError: (event) => {
      console.error("agent stream error:", event.error);
      mcp.close();
    },
  });

  return result.toTextStreamResponse();
}

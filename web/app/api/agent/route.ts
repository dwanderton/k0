import { streamText, stepCountIs, type ToolSet } from "ai";
import { createMCPClient } from "@ai-sdk/mcp";

export const maxDuration = 60;

const SYSTEM = `You are k0, a live knowledge-base copilot for a Vercel Solutions Architect mid-call.
You receive the SA's side of the conversation as a transcript.
Identify the customer question being restated and answer it from Vercel's documentation.
Use the documentation search tools to find the answer before responding.
Rules:
- Be concise: the SA gets one glance. Lead with the answer in 1-3 sentences.
- Quote the exact passage that matters when possible.
- Always end with the source on its own line, formatted exactly as: Source: <url>
- If the docs don't answer it, say so plainly. Never fake certainty.`;

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

  const result = streamText({
    model: "openai/gpt-5.4-mini",
    system: SYSTEM,
    prompt: transcript,
    // Cast: @ai-sdk/mcp pins provider-utils@5.0.3 while ai uses 5.0.4 — the
    // schema marker is Symbol.for-registered so runtime interop is safe; only
    // the declared unique-symbol types disagree.
    tools: (await mcp.tools()) as ToolSet,
    stopWhen: stepCountIs(5),
    onFinish: () => mcp.close(),
    onError: () => mcp.close(),
  });

  return result.toTextStreamResponse();
}

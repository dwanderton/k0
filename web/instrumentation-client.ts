import { initBotId } from "botid/client/core";

// protect the two routes where a request converts into our spend: agent
// turns (LLM tokens) and transcription mints (Gladia minutes). Session
// backfill GET stays open — capability-URL gated, near-zero cost.
initBotId({
  protect: [
    { path: "/api/agent", method: "POST" },
    { path: "/api/transcribe-session", method: "POST" },
  ],
});

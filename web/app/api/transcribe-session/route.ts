/** Mints a Gladia live-transcription session. The admin key stays server
 *  side — the returned WS URL embeds its own scoped auth, so the browser
 *  connects directly and PCM never proxies through us. */
export async function POST() {
  const key = process.env.GLADIA_API_KEY;
  if (!key) {
    return Response.json({ error: "GLADIA_API_KEY unset" }, { status: 503 });
  }
  const resp = await fetch("https://api.gladia.io/v2/live", {
    method: "POST",
    headers: { "x-gladia-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({
      // Gladia live accepts raw PCM only — client worklet downsamples the
      // mic to 16kHz mono int16 (see lib/gladia-live.ts)
      encoding: "wav/pcm",
      sample_rate: 16000,
      bit_depth: 16,
      channels: 1,
      language_config: { languages: ["en"], code_switching: false },
      messages_config: { receive_partial_transcripts: true },
      // finals drive agent turns — 0.3s endpointing finalizes utterances
      // fast without splitting mid-sentence; 15s caps run-on speech
      endpointing: 0.3,
      maximum_duration_without_endpointing: 15,
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!resp.ok) {
    const detail = (await resp.text()).slice(0, 300);
    return Response.json(
      { error: "session create failed", status: resp.status, detail },
      { status: 502 },
    );
  }
  const session = (await resp.json()) as { id: string; url: string };
  return Response.json({ wsUrl: session.url, sessionId: session.id });
}

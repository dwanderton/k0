/**
 * Gladia live transcription — the mobile path. Safari/Chrome on iOS and
 * Android ship no usable SpeechRecognition; this replaces it with:
 * mint session (server holds the key) → WS to Gladia → AudioWorklet
 * downsamples mic to 16kHz mono int16 PCM → 100ms binary frames up,
 * transcript messages down.
 */

// worklet runs in AudioWorkletGlobalScope — keep source self-contained
const PCM_WORKLET = `
class PCMDownsampler extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = [];
    this._ratio = sampleRate / 16000;
    this._chunk = 1600; // 100ms at 16kHz — Gladia guidance
  }
  process(inputs) {
    const ch = inputs[0]?.[0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i += this._ratio) {
      let s = ch[Math.floor(i)];
      if (s > 1) s = 1; else if (s < -1) s = -1;
      this._buf.push(s * 0x7fff);
    }
    while (this._buf.length >= this._chunk) {
      const out = new Int16Array(this._buf.splice(0, this._chunk));
      this.port.postMessage(out.buffer, [out.buffer]);
    }
    return true;
  }
}
registerProcessor("pcm-downsampler", PCMDownsampler);
`;

interface TranscriptMessage {
  type: string;
  data?: {
    is_final: boolean;
    utterance?: { text?: string };
  };
}

export interface GladiaHandle {
  stop(): Promise<void>;
}

// non-1000 close → reopen same wsUrl (resumable per Gladia docs); PCM
// captured during the gap rides a small ring (~3s) and flushes on open
const RING_MAX = 30;
const RECONNECT_BACKOFF_MS = [1000, 3000, 10000];

export function isGladiaCapable(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof WebSocket !== "undefined" &&
    typeof AudioWorkletNode !== "undefined" &&
    !!(window.AudioContext ??
      (window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext) &&
    !!navigator.mediaDevices?.getUserMedia
  );
}

export async function startGladiaLive(opts: {
  /** k0 session id — one identity across transcription and agent turns */
  sessionId?: string;
  onFinal: (text: string) => void;
  onInterim: (text: string) => void;
  onError: (message: string) => void;
}): Promise<GladiaHandle> {
  const { sessionId, onFinal, onInterim, onError } = opts;

  // mic first — permission prompt should precede any network work
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

  const resp = await fetch("/api/transcribe-session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId }),
  });
  if (!resp.ok) {
    stream.getTracks().forEach((t) => t.stop());
    const body = await resp.text();
    throw new Error(`transcribe-session ${resp.status}: ${body.slice(0, 120)}`);
  }
  const { wsUrl } = (await resp.json()) as { wsUrl: string };

  let ws: WebSocket | null = null;
  let closing = false;
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  const pending: ArrayBuffer[] = [];

  const flush = () => {
    while (ws?.readyState === WebSocket.OPEN && pending.length > 0) {
      ws.send(pending.shift()!);
    }
  };

  const connect = () => {
    ws = new WebSocket(wsUrl);
    ws.binaryType = "arraybuffer";
    ws.addEventListener("open", () => {
      reconnectAttempt = 0;
      flush();
    });
    ws.addEventListener("message", (ev) => {
      try {
        const msg = JSON.parse(ev.data as string) as TranscriptMessage;
        if (msg.type !== "transcript") return;
        const text = msg.data?.utterance?.text?.trim();
        if (!text) return;
        if (msg.data?.is_final) onFinal(text);
        else onInterim(text);
      } catch {
        // non-JSON frame — ignore
      }
    });
    ws.addEventListener("close", (ev) => {
      if (closing || ev.code === 1000) return;
      if (reconnectAttempt >= RECONNECT_BACKOFF_MS.length) {
        onError("live transcription disconnected — stop and start again");
        return;
      }
      const delay = RECONNECT_BACKOFF_MS[reconnectAttempt++];
      reconnectTimer = setTimeout(connect, delay);
    });
  };
  connect();

  const AudioCtor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const audioContext = new AudioCtor();
  const workletUrl = URL.createObjectURL(
    new Blob([PCM_WORKLET], { type: "application/javascript" }),
  );
  try {
    await audioContext.audioWorklet.addModule(workletUrl);
  } finally {
    URL.revokeObjectURL(workletUrl);
  }
  const source = audioContext.createMediaStreamSource(stream);
  const worklet = new AudioWorkletNode(audioContext, "pcm-downsampler");
  worklet.port.onmessage = (ev: MessageEvent<ArrayBuffer>) => {
    if (ws?.readyState === WebSocket.OPEN) {
      flush();
      ws.send(ev.data);
    } else {
      pending.push(ev.data);
      if (pending.length > RING_MAX) pending.shift();
    }
  };
  source.connect(worklet);
  // silent sink — worklet needs a downstream connection to keep processing
  const sink = audioContext.createGain();
  sink.gain.value = 0;
  worklet.connect(sink).connect(audioContext.destination);

  return {
    async stop() {
      closing = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      try {
        source.disconnect();
        worklet.disconnect();
      } catch {
        // best-effort teardown
      }
      if (ws?.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ type: "stop_recording" }));
        } catch {
          // best-effort
        }
        // give the server a moment to close clean (1000)
        await new Promise<void>((resolve) => {
          const done = () => resolve();
          ws!.addEventListener("close", done, { once: true });
          setTimeout(done, 2000);
        });
      } else {
        ws?.close();
      }
      await audioContext.close().catch(() => {});
      stream.getTracks().forEach((t) => t.stop());
    },
  };
}

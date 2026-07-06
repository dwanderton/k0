# k0 Concept

**Executive summary**

- **What k0 is:** a knowledge foundation, layer zero, under every live call.
- **How k0 moves:** streams, end to end. Never a request/response the user can feel.
- **What k0 looks like:** Geist. Minimal, high-contrast, one glance is enough.
- **How k0 behaves under failure:** it never leaves you stranded. Backup is identity, not error handling.

## What It Is

An agent that listens to **our side of a live customer conversation**, the SA's own voice, captured by the browser microphone, and surfaces the most relevant knowledge-base article in real time, highlighting the exact passage that matters. The SA naturally restates the customer's question aloud ("So you're asking how caching works on Fluid Compute…"), and that restatement is the retrieval trigger — never "let me check" or "I'll pull that up." Stalling phrases are the dead air k0 exists to delete: the card lands, and the conversation never pauses. No call-platform integration, no customer audio: just `getUserMedia` in the tab the SA already has open. Built on the Vercel KB for the demo; the KB is pluggable.

## Problem

In live customer conversations, the answer usually exists in the docs — but finding it mid-call means dead air or "I'll get back to you." Reps either wing it or stall; both cost trust and momentum. Two failure modes define the product:

- **Wrong info costs trust.**
- **No info costs the call.**

Every decision below answers to those two.

## Persona

Solutions Architect / support engineer / sales engineer on live calls. Enterprise buyer: VP Support running contact-center agent-assist; KPIs are handle time and new-hire ramp. The user is mid-sentence with a customer when they glance at k0. They get one glance.

## How It Works

**Streaming pipeline.** Audio becomes transcript becomes retrieval becomes a streamed passage. A moving stream from the SA's mouth to the SA's glance. An AudioWorklet downsamples the browser mic to 16kHz PCM and streams it over a WebSocket directly to Gladia — the session is minted server-side, the key never reaches the browser, and audio never passes through k0's own infrastructure. Partial and final transcripts stream back on the same socket. Each finalized utterance hits `/api/agent` (Vercel Functions, Fluid Compute), where an in-process embedding retrieves top-k passages from the committed index in ~66ms ahead of the model's first turn (`gpt-5.4-mini` via AI Gateway, throughput-sorted), and the card streams back over an HTTP stream with the agent's trace interleaved. Validated cards park in Vercel Blob under `after()` — a dropped connection cancels delivery, never the work. No polling, no batching the user can feel.

**Ideal Latency budget:**

| Stage | Budget |
|-------|--------|
| First streamed content | < 1s |
| Settled card | < 3s |

**Provenance is chrome.** Every surfaced passage permanently shows its source article, section, and last-updated date. A claim without a source is a bug, not a style choice.

**State is never hidden.** Listening, surfacing, degraded, reconnecting — a status dot + label always shows the connection truth. Disconnection is admitted on screen, calmly.

## Durable, Reliable, Secure

- **Session state lives in two layers, one session id.** Client: every settled turn write-through persists an atomic snapshot — transcript, cards, watermarks — to localStorage; a refresh or crash offers "Resume call." Server: the agent turn runs under `after()`, so a dropped client cancels delivery, never the work; validated cards park as per-turn blobs in private Vercel Blob (7-day TTL) and backfill on reconnect. State never lives only in the socket.
- **Disconnection costs nothing but time.** Turns in flight when the connection drops finish server-side and are retrievable on reconnect; a refresh restores the call. One honest boundary: words spoken while fully offline are never transcribed (speech-to-text is cloud) — and the UI says so, in a banner, at the moment it's true.
- **Fallback is a first-class code path.** Every rung is visible in the on-card trace: in-process embeddings fall back to gateway embeddings; a failed retriever re-enables MCP docs search for that request; a refusal against a high-confidence candidate retries once on a smarter judge (`gpt-5.4`); the gateway fails over same-family, so the verbatim-quote contract survives a provider outage. When the mic dies, the transcript says exactly what happened and what still works.
- **Secure by default.** Only the SA's own voice is captured — the customer is never recorded, which keeps consent single-party and compliance simple. Audio goes to exactly one processor: a server-minted, scoped Gladia session — the key never reaches the browser, and PCM never passes through k0's infrastructure. Transcripts go only to the retrieval-and-model pipeline. The two routes where a request converts into spend sit behind BotID and a WAF rate limit; parked cards are private-Blob, capability-URL gated. Mic capture starts and stops with an explicit on-screen control, state always visible.

## Evaluation

Lightweight, runs in CI, maps one-to-one onto the two failure modes:

- **Golden test set (no info → recall).** Fixed SA cue phrases with hand-verified gold pages, plus small-talk negative controls that must produce NONE. Append-only by rule: new phrases are new rows, never replacements — comparability over time is the point. The scorecard runs 100× per phrase against prod, reporting median/p95 time-to-card (cold starts split out), gold-link precision, and cost per insight; the retrieval layer gates separately offline on hit@1/hit@3.
- **Hallucination regression check (wrong info → precision).** k0 quotes the KB, it never paraphrases into the card — so the check is deterministic: ANCHOR must sit inside QUOTE (zod contract, validated on every response), and QUOTE must exist on the live source page, judged on rendered words (scorecard ground check). Runs as a CI gate against every PR's preview deployment; control false positives are zero-tolerance.
- **Corpus freshness gate (the KB can't rot silently).** A weekly action re-crawls every doc source, rebuilds both embedding indexes additively, and opens an artifacts PR only if the retrieval gates pass on both backends. (A confidence-calibration rubric — LLM-judge over badge honesty — is roadmap, pending the badges themselves.)

Order of investment matches risk: the zod contract is free and runs on every response; the ground check gates every PR; the full scorecard prices every approach change; the weekly gate keeps the corpus honest.

## Design

Geist throughout — Geist Sans for human speech and prose, Geist Mono for the machine voice (timestamps, paths, scores); color signals state, never decoration; gray ranks information, blue marks the interactive and the highlighted passage. Retrieval always renders skeleton → streaming passage → settled card — never a blocking spinner. Responsive cockpit: single column with cards an SA will open this on a phone.

The philosophy is enforced, not aspirational: `k0-design-skill`, the project's own design agent, encodes it — the Call Cockpit model, latency-as-material, provenance chrome, Geist color-step semantics and voice — as instructions the coding agent applies to every change. It governs all k0 code, not just UI: API routes, retrieval, streaming, and copy are built against the same rules a designer would review them by.

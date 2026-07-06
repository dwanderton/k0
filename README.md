# k0

k0 listens to your side of a live customer call and surfaces the right knowledge-base passage as you speak. Restate the customer's question aloud and the answer lands on screen, highlighted and sourced, before you say "let me check."

The original concept for k0 is described [here](concept.md).

## Repo

| where | what |
|---|---|
| [`concept.md`](concept.md) | the design doc — problem, persona, pipeline, durability, evaluation |
| [`web/`](web/README.md) | the app — setup, env, data pipeline, file map |
| [`scorecard/`](scorecard/SCORECARD.md) | quality history — append-only runs, method, gates |
| [`.github/workflows/`](.github/workflows/) | CI: per-PR hallucination gate · weekly corpus refresh |

Dev setup lives in [web/README.md](web/README.md)

## Discussion Topics
[scorecard/SCORECARD.md](scorecard/SCORECARD.md) carries the run-by-run evidence.

### Prompting

- **Why is the contract verbatim-quote-or-NONE?** It converts hallucination
  detection from an LLM-judge problem into a deterministic substring check. The whole eval strategy hangs off this one prompt rule.
  → [`SYSTEM` — route.ts#L125](web/app/api/agent/route.ts#L125-L171)
  
- **Why is FLOW a numbered decision procedure, not a persona?** And the
  experiment that lost: a model-as-selector prompt line tripled misses —
  it primes the pages it names. → recorded in
  [SCORECARD.md (PR #9)](scorecard/SCORECARD.md)

### Context selection

- **Why traditional RAG instead of handing the model a search tool?** 
  k0 initially shipped the other way first. I attempted to utilize the Vercel MCP Server's `search_vercel_documentation` tool. However, the scorecard killed it: 3.2s median cards (the decide → search → read → answer round-trips), with misrouting as the dominant defect, and a step cap that existed purely to stop search loops — even after prompt modification, models kept requesting the tool, relentlessly re-searching for a better result it wasn't going to provide.
  
  Pre-call retrieval made the decision infrastructure instead of tokens: every finalized utterance gets top-k injected before the first model turn — 1.1s median, gold 77%→100%, and the retrieval stage became offline-testable ([hit@1/hit@3 gate — eval-retriever.ts#L68](web/scripts/eval-retriever.ts#L68-L73)) independently of the model. The model keeps one tool (`read_vercel_doc`) for the case where judgment helps: the excerpt lacks the exact quotable sentence. → [pre-call retrieval — route.ts#L267](web/app/api/agent/route.ts#L267-L268), [the before/after runs — SCORECARD.md (PR #6 vs #8)](scorecard/SCORECARD.md)

- **Why not just use Vercel's MCP `search_vercel_documentation` tool?**
  Two disqualifiers, both structural. 
  1. Quality: MCP search returns synthesized snippet captions, not page text — a quote grounded in a caption never appears on the real page, so the `#:~:text=` highlight never lands, which breaks k0's contract of having a direct reference to the source of truth. 
  2. Latency: 0.5–1.5s RTT per call, inside a model turn, on a sub-second budget. It also misrouted, for example, the preview-deployments gold page is one MCP search never found across 100 probes. However, the MCP now acts as a fallback. A FAILED retriever (not an empty result) re-enables the Vercel MCP as the disaster-recovery search for that request. → [why captions can't quote — route.ts#L12](web/app/api/agent/route.ts#L12-L13), [the recovery rung — route.ts#L294](web/app/api/agent/route.ts#L294-L296)

- **Why does confidence shrink the context?** 
Above 0.95 relevance the second excerpt is approximately 900 tokens of dead prefill, measured at −74% on the dominant-retrieval phrase. Reducing the number of prompt tokens reduces latency → [route.ts#L283](web/app/api/agent/route.ts#L283-L285)

- **Why does the client garbage-collect the transcript?** 
A card or NONE consumes the transcript that was sent was sent; failures don't — so old topics never re-answer and failed lines retry on the next utterance. In the MVP topics would unexpectedly resurface at seemingly irrelevant points later in the conversation. → [`consumedRef` — use-call-session.ts#L43](web/app/_cockpit/use-call-session.ts#L43), [Consumed-GC — #L158](web/app/_cockpit/use-call-session.ts#L158-L162)

- **Why heading-based chunks (with a 3,200-char ceiling)?** 
Chunks follow the docs' own structure — each `#`/`##`/`###` section is one topic and usually contains one quotable passage, so retrieval returns semantically whole units rather than arbitrary windows - especially given the structured and well maintained nature of Vercel's documentation.
Two guardrails: sections greater than 3,200 chars (~800 tokens) are split on paragraphs so two candidates still fit a sub-second prefill budget, and stubs under 300 chars merge into their predecessor, heading kept inline, so tiny sections don't become noise rows. → [heading split — chunker.ts#L81](web/lib/chunker.ts#L81-L91), [`TARGET_MAX` ceiling — chunker.ts#L16](web/lib/chunker.ts#L16), [stub merge — chunker.ts#L93](web/lib/chunker.ts#L93-L104)

### Model choice

- **Why `openai/gpt-5.4-mini`?** The scorecard picked it, not a leaderboard. It's the one model that reliably runs retrieval → verbatim quote; others loop re-searching or fabricate. `openai/gpt-oss-20b` ended up looping infinitely with tool use, `alibaba/qwen3.7-plus` would routinely hallucinate and refuse to call tools, `zai/glm-4.7` was not surfacing the gold pages consistently.
  → [`MODEL` — route.ts#L92](web/app/api/agent/route.ts#L92-L103)

- **Why the gpt-5.4 family at all?** k0's task is obedience, not brilliance: follow a numbered procedure, copy sentences exactly, refuse when unsure. Candidates were auditioned against that contract and the 5.4 family held it. One family also makes the ladder coherent: `openai/gpt-5.4-mini` serves at ~$0.0015/card; `openai/gpt-5.4` stands behind it for outages and stubborn refusals with the same output behavior. One contract, two sizes, no prompt surgery at the failover boundary. Routed via AI Gateway, so if the audition result ever flips, the swap is a string. → [model ladder — route.ts#L92](web/app/api/agent/route.ts#L92-L103), [audition history — SCORECARD.md (PR #3–#9)](scorecard/SCORECARD.md)

- **Why is the retry a *different* model?** 
Re-rolling `openai/gpt-5.4-mini` on a refusal is the same coin flipped twice; `openai/gpt-5.4` runs only on the ~1–2% of turns mini already fumbled. Same-family only — cross-vendor fallbacks fabricated quotes. → [`ESCALATION_MODEL` — route.ts#L95](web/app/api/agent/route.ts#L92-L103), [`RETRY_FLOOR` — route.ts#L349](web/app/api/agent/route.ts#L349-L355)

- **Why `Xenova/bge-small-en-v1.5` for embeddings?**
MiniLM was auditioned first for the in-process embedding slot and failed (hit@1 3/5, hit@3 4/5, against floors of ≥4 and 5/5). It would have required significant tuning, whereas `Xenova/bge-small-en-v1.5`, untuned, was more effective at providing high-quality matches. → [the failed audition — SCORECARD.md (PR #9)](scorecard/SCORECARD.md)

- **Why two embedding models with two committed indexes?** 
In-process `Xenova/bge-small-en-v1.5` (~5ms, $0) serves; `openai/text-embedding-3-small` via the gateway is the fallback with its own index — different models with different dimensionality can't share vectors, and each gets its own empirically calibrated floors. → [`TUNING` — retriever.ts#L50](web/lib/retriever.ts#L50-L53)

### Cost / latency tradeoffs

- **Why does silence auto-stop the mic?** 
Unlike in-browser transcription, Gladia bills per listening minute; silence costs the same as speech. Ten idle minutes bounds the worst-case spend per session. Previously I used Chrome's in-browser transcription; Gladia was selected to add mobile support and to stop mishears of utterances that produced false NONE responses from the agent. → [`IDLE_CUTOFF_MS` — page.tsx#L26](web/app/page.tsx#L26), [cost model — SCORECARD.md](scorecard/SCORECARD.md)

- **Why is the big index int8 and the small one uncompressed?** Compression has a cost: CPU to decode. int8 shrank the high-dimension fallback index from 81→13MB, while brotli on float vectors saved only ~10% on size but cost ~300ms every cold start to load into memory. Therefore I ship the hot index raw. → [int8 dequant — retriever.ts#L126](web/lib/retriever.ts#L126-L128)

- **Why no vector DB?** 
Real-time means minimizing network hops. At just under 20k rows a brute-force scan over the committed in-memory index takes less than 25ms with perfect recall. A vector DB would add a network RTT larger than the entire search, on every single utterance. Approximate Nearest Neighbor search algos trades accuracy for speed both in vector dbs and locally. At this scale we don't need to make that trade. The whole retrieval hot path is zero-network: query embeds in-process (~5ms), index lives in instance memory. → [retriever.ts#L1](web/lib/retriever.ts#L1-L8)

- **Why is the entire docs corpus a file in the bundle?** Same principle, applied to page text: docs-cache.br ships inside the function, so  `read_vercel_doc` serves full pages from the filesystem instead of fetching vercel.com mid-call. Network is reserved for the one hop
  that earns it - the LLM. Freshness comes from weekly (arbitrary for demo) gated deploys, not runtime crawls. → [bundled cache — docs-cache.ts#L64](web/lib/docs-cache.ts#L64-L66), [cache-first read — route.ts#L59](web/app/api/agent/route.ts#L59-L67)

- **Why a warm-up ping?** 
The one-time cold start init of around 3-5s is paid during the dead air after the "Start Listening" click. This leads first card ~0.9s instead of ~6s. Cold starts are split out of every latency number (the ❄ discipline) so the tail never lies about the median. → [SCORECARD.md method](scorecard/SCORECARD.md)

- **Why not Vercel Workflows for the agent turn?** 
WDK's durability is bought with checkpoints — persisted state at every step boundary, on 100% of turns, to insure a crash that hits well under 0.01% of them — and step-oriented execution fights token streaming, which the sub-second card depends on. The hand-rolled equivalent covers the failure that actually happens: the agent loop lives outside the response stream, so a client disconnect cancels *delivery*, not *work*. The turn finishes under `after()` and the card parks for reconnect backfill (smoke tested by aborting a client 1.0s into a 2.4s turn). Workflows was also weighed for the weekly corpus pipeline and lost to a GitHub Action for a different reason: today the pipeline's outputs are git-LFS artifacts to keep in filesystem, and git lives on the Actions side. → [loop outside the stream — route.ts#L353](web/app/api/agent/route.ts#L353-L355), [finish-after-disconnect — route.ts#L551](web/app/api/agent/route.ts#L551-L553), [the pipeline that went to Actions instead — corpus-refresh.yml](.github/workflows/corpus-refresh.yml)

- **Why not build on Eve?** Eve thrives with long-lived sessions, rich tool orchestration, channels, subagents, and schedules. Today k0's agent is a slightly different shape: a sub-second, streaming, single-shot component inside a latency-critical UI — one retrieval, one generation, one escape-hatch tool. The entire agent is a single `streamText` call. However, fundatmentally this take home has proven the value that Eve is build to deliver, especially around step level agentic observability. Our hand-rolled agent using the AI SDK and Gateway falls short of what Eve could deliver out of the box. → [the whole agent — route.ts#L327](web/app/api/agent/route.ts#L327-L340)

### Safety

- **Where is the bot boundary, and why there?** 
BotID guards exactly the two routes where a request converts into spend (LLM tokens, transcription minutes); a WAF rule (30 req/60s per IP) handles volume; CI probes bypass both via a rotatable secret. → [checkBotId — route.ts#L233](web/app/api/agent/route.ts#L226-L238), [protected routes — instrumentation-client.ts](web/instrumentation-client.ts)

- **What stops a hallucinated card from shipping?** 
Two layers: zod checks the card's shape at stream finish, groundedness checks its truth. QUOTE must be verbatim on the real page, where fabricated sentences score ~0. CI fails any PR under 80%. → [`OutputSchema` — route.ts#L182](web/app/api/agent/route.ts#L182-L199), [pr-scorecard.yml](.github/workflows/pr-scorecard.yml), [`grounded()` — run.mjs#L200](scorecard/run.mjs#L200-L221) — the orchestrator: takes a card, extracts the docs path from its SOURCE, fetches the real `.md` page from vercel.com (cached per path), then requires both conditions: ANCHOR appears inside QUOTE, and QUOTE appears on the page.

- **Who can read a parked session?** The session id unlocks the parked session. An unguessable random UUID; production would scope this under SSO. → [session backfill — route.ts](web/app/api/session/%5Bid%5D/route.ts)

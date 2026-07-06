# k0

k0 listens to your side of a live customer call and surfaces the right knowledge-base passage as you speak. Restate the customer's question aloud and the answer lands on screen, highlighted and sourced, before you say "let me check."

## Repo

| where | what |
|---|---|
| [`web/`](web/README.md) | the app — setup, env, data pipeline, file map |
| [`scorecard/`](scorecard/SCORECARD.md) | quality history — append-only runs, method, gates |
| [`.github/workflows/`](.github/workflows/) | CI: per-PR hallucination gate · weekly corpus refresh |

Dev setup lives in [web/README.md](web/README.md)

## Design discussion — where the tradeoffs live

Each question links to the decision in code; the comment at that site
carries the reasoning, and [scorecard/SCORECARD.md](scorecard/SCORECARD.md)
carries the run-by-run evidence.

### Prompting

- **Why is the contract verbatim-quote-or-NONE?** It converts hallucination
  detection from an LLM-judge problem into a deterministic substring check. The whole eval strategy hangs off this one prompt rule.
  → [`SYSTEM` — route.ts#L125](web/app/api/agent/route.ts#L125-L171)
  
- **Why is FLOW a numbered decision procedure, not a persona?** And the
  experiment that lost: a model-as-selector prompt line tripled misses —
  it primes the pages it names. → recorded in
  [SCORECARD.md (PR #9)](scorecard/SCORECARD.md)

### Context selection

- **Why does confidence shrink the context?** Above 0.95 relevance the
  second excerpt is ~900 tokens of dead prefill — measured −74% on the
  dominant-retrieval phrase.
  → [route.ts#L283](web/app/api/agent/route.ts#L283-L285)
- **Why does the client garbage-collect the transcript?** A card or NONE
  consumes what was sent; failures don't — so old topics never re-answer
  and failed lines retry on the next utterance.
  → [`consumedRef` — use-call-session.ts#L43](web/app/_cockpit/use-call-session.ts#L43),
  [Consumed-GC — #L158](web/app/_cockpit/use-call-session.ts#L158-L162)
- **Why 3,200-char chunks?** Big enough that a passage answers a question
  whole, small enough that two candidates fit a sub-second prefill budget —
  the size the entire eval history was tuned at.
  → [`TARGET_MAX` — chunker.ts#L16](web/lib/chunker.ts#L16)

### Model choice

- **Why gpt-5.4-mini?** The scorecard picked it, not a leaderboard — it's
  the one model that reliably runs retrieval → verbatim quote; others loop
  re-searching or fabricate.
  → [`MODEL` — route.ts#L92](web/app/api/agent/route.ts#L92-L103)
- **Why is the retry a *different* model?** Re-rolling mini on a refusal is
  the same coin flipped twice; full gpt-5.4 runs only on the ~1–2% of turns
  mini already fumbled. Same-family only — cross-vendor fallbacks fabricated
  quotes. → [`ESCALATION_MODEL` — route.ts#L95](web/app/api/agent/route.ts#L92-L103),
  [`RETRY_FLOOR` — route.ts#L349](web/app/api/agent/route.ts#L349-L355)
- **Why two embedding models with two committed indexes?** In-process
  bge-small (~5ms, $0) serves; gateway te3 is the fallback with its own
  index — different models can't share vectors, and each gets its own
  empirically calibrated floors.
  → [`TUNING` — retriever.ts#L50](web/lib/retriever.ts#L50-L53)

### Cost / latency tradeoffs

- **Why does silence auto-stop the mic?** Transcription bills per listening
  minute — ~97% of marginal cost — so silence costs the same as speech; ten
  idle minutes bounds the worst-case spend per session.
  → [`IDLE_CUTOFF_MS` — page.tsx#L26](web/app/page.tsx#L26),
  [cost model — SCORECARD.md](scorecard/SCORECARD.md)
- **Why is the big index int8 and the small one uncompressed?** Compression
  has a third axis: decode CPU. int8 shrank the fallback index 81→13MB (a
  size gate), while brotli on float vectors saved only ~10% but cost ~300ms
  every cold start — so the hot index ships raw.
  → [int8 dequant — retriever.ts#L126](web/lib/retriever.ts#L126-L128)
- **Why no vector DB?** Real-time means minimizing network hops. At ~19k
  rows a brute-force scan over the committed in-memory index takes
  ~10–25ms with perfect recall — a vector DB would add a network RTT
  larger than the entire search, on every single utterance. The whole
  retrieval hot path is zero-network: query embeds in-process (~5ms),
  index lives in instance memory.
  → [retriever.ts#L1](web/lib/retriever.ts#L1-L8)
- **Why is the entire docs corpus a file in the bundle?** Same principle,
  applied to page text: docs-cache.br ships inside the function, so
  `read_vercel_doc` serves full pages from the filesystem instead of
  fetching vercel.com mid-call — the network is reserved for the one hop
  that earns it (the LLM). Freshness comes from weekly gated deploys, not
  runtime crawls.
  → [bundled cache — docs-cache.ts#L64](web/lib/docs-cache.ts#L64-L66),
  [cache-first read — route.ts#L59](web/app/api/agent/route.ts#L59-L67)
- **Why a warm-up ping?** The one-time init is paid during the dead air
  after Start Listening — first card ~0.9s instead of ~6s. Cold starts are
  split out of every latency number (the ❄ discipline) so the tail never
  lies about the median. → [SCORECARD.md method](scorecard/SCORECARD.md)

### Safety

- **Where is the bot boundary, and why there?** BotID guards exactly the two
  routes where a request converts into spend (LLM tokens, transcription
  minutes); a WAF rule (30 req/60s per IP — platform config, not visible in
  this repo) handles volume; CI probes bypass both via a rotatable secret.
  → [checkBotId — route.ts#L233](web/app/api/agent/route.ts#L226-L238),
  [protected routes — instrumentation-client.ts](web/instrumentation-client.ts)
- **What stops a hallucinated card from shipping?** Two layers: zod checks
  the card's shape at stream finish, groundedness checks its truth — QUOTE
  verbatim on the real page, where fabricated sentences score ~0. CI fails
  any PR under 80%.
  → [`OutputSchema` — route.ts#L182](web/app/api/agent/route.ts#L182-L199),
  [pr-scorecard.yml](.github/workflows/pr-scorecard.yml)
- **Who can read a parked session?** The session id is the capability —
  random UUID, unguessable, near-zero-cost route; production would scope
  this under SSO.
  → [session backfill — route.ts](web/app/api/session/%5Bid%5D/route.ts)

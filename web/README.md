# k0 — web

Live KB copilot for Vercel SAs. Mic → Gladia transcript → local retrieval → gpt-5.4-mini via AI Gateway → verbatim-quote card with `#:~:text=` highlight. Next.js 16, App Router, Vercel Functions Fluid compute.

## Run

```bash
pnpm install
pnpm dev        # http://localhost:3000
pnpm build      # prod build (Turbopack)
pnpm start      # serve prod build
```

Needs `.env.local` (gitignored, never committed):

| var | for |
|---|---|
| `GLADIA_API_KEY` | live transcription session mint |
| `VERCEL_MCP_TOKEN` | MCP search fallback when retrieval fails |
| `BLOB_READ_WRITE_TOKEN` | session card parking (`k0-sessions` store) |
| `SCORECARD_PROBE_SECRET` | scorecard bypass of BotID + rate limit |
| `AI_GATEWAY_API_KEY` | AI Gateway auth (falls back to `VERCEL_OIDC_TOKEN` if unset) |

Chrome/Safari + mic. BotID no-ops off-Vercel — local dev unaffected.

## Data pipeline

Committed artifacts (LFS) ship with deploys — runtime never crawls:

```bash
pnpm build:docs-cache              # additive crawl → docs-cache.br
REFRESH=1 pnpm build:docs-cache    # weekly mode — re-crawl all, prune dead pages
pnpm build:embeddings              # gateway index (te3-small, int8) — costs ~cents
pnpm build:embeddings-local        # in-process index (bge-small) — $0
node scripts/eval-retriever.ts     # gate: hit@1 ≥4/5, hit@3 5/5. Run after any index change
```

Weekly refresh runs itself: `.github/workflows/corpus-refresh.yml` crawls, embeds, gates, opens PR. Human merges.

## Quality

```bash
node ../scorecard/run.mjs                    # 10x per phrase vs prod
node ../scorecard/run.mjs http://localhost:3000
GATE=1 RUNS=5 node ../scorecard/run.mjs      # CI mode — exit 1 on groundedness/false-positive breach
```

History + method: `../scorecard/SCORECARD.md`. Append-only — every agent change gets a run.

## Map

- `app/page.tsx` — call cockpit: transcript, cards, session restore, offline banner
- `app/api/agent/route.ts` — retrieval → model → card; NONE-retry escalates to gpt-5.4; parks cards for reconnect
- `app/api/transcribe-session/route.ts` — Gladia session mint (key stays server-side)
- `app/api/session/[id]/route.ts` — backfill parked cards on resume
- `lib/retriever.ts` — brute-force cosine, two backends, no vector DB
- `lib/chunker.ts` — deterministic page → chunks; idx anchors additive rebuilds
- `lib/gladia-live.ts` — mic → 16kHz PCM worklet → WS
- `lib/session-store.ts` — Blob card parking

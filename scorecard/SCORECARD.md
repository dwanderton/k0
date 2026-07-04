# k0 agent latency scorecard

Tracks speed-to-response of `/api/agent` over time. Append one run block
per session; never edit old blocks — the history is the chart.

## Method

### Fixed phrase set — do not change between runs

Cue phrases (must produce a card), with hand-verified gold sources
(checked against live vercel.com/docs `.md`, 2026-07-03):

| cue phrase | gold source |
|---|---|
| So you are asking what is the AI gateway | `ai-gateway` |
| You want to know how to enable fluid compute for a single deployment | `fluid-compute` |
| Your question is how long can a Vercel function run before it times out | `functions/limitations` or `functions/configuring-functions/duration` |
| So you are asking how preview deployments work on Vercel | `deployments/environments` (`deployments/preview-deployments` is a 404) |
| You want to know how to add a custom domain to your project | `domains/working-with-domains/add-a-domain` |

Fixed negative controls (must produce NONE — a card is a false positive):

| control phrase |
|---|
| Thanks for joining, how was your weekend |
| Give me one second, someone is at the door |

Changing any phrase resets the history — comparability over time is the
whole point. Add new phrases as NEW rows alongside the old, never replace.

### Metrics

- `node scorecard/run.mjs` — 5 fixed cue phrases × 10 serial requests
  against prod (`k0-omega.vercel.app`).
- **ttfb** = first stream byte (MCP connect + gateway routing).
- **card** = first card byte (`DOC:` visible) — what the user actually waits for.
  This is the headline metric.
- **total** = stream close.
- Medians, not means — one cold start shouldn't own the number.
- Failures counted in `ok`, never dropped. `NONE` = agent judged no doc
  applies; that's a cue-phrase miss, not an API failure.
- **ground** = ANCHOR inside QUOTE *and* QUOTE on the real `.md` page —
  judged on rendered words (markdown links/backticks/pipes/table rows
  stripped from both sides), passing on direct substring or ≥80% coverage
  of the quote's word 8-grams (lets table-flattened quotes pass; fabricated
  sentences score ~0). A ground failure is a real card defect — most often
  an anchor picked from a table cell, which the browser highlight can't
  match.

### Embedding index cost (cumulative, also stored in embeddings-meta.json.br)

| date | event | tokens | cost |
|---|---|---|---|
| 2026-07-04 | initial build — 18,363 chunks from 2,732 cached pages (openai/text-embedding-3-small @ $0.02/M via gateway) | 5,544,997 | $0.1109 |

Additive rebuilds append rows here; the meta file carries the same running
total. Query-time embedding costs ride the per-run cost/insight column.

Falsifiers / caveats to check before trusting a run:
- Expired `VERCEL_MCP_TOKEN` → every request 500s (shows as `HTTP 500`).
- Wifi/network of the machine running the probe skews ttfb, not card-minus-ttfb.
- Model/prompt changes between runs are the thing being measured — note the
  deployed commit next to each run.

## Runs

<!-- append `node scorecard/run.mjs` output below, newest last -->

### PR #3 (k0 MVP) — agent: gpt-5.4-mini via AI Gateway (ttft) · Vercel MCP docs search + read_vercel_doc (.md fetch) · step cap 8

# run 2026-07-03 21:44 UTC · https://k0-omega.vercel.app · commit 0fc830c · 100x per phrase, conc 50

| phrase | ok | fail% | card med | card p95 | cost/insight | ground | gold hit | top link |
|---|---|---|---|---|---|---|---|---|
| So you are asking what is the AI gateway | 100/100 | 0% | 4.1s | 6.6s | $0.0025 | 5/5 | 84/100 | ai-gateway ×84 |
| You want to know how to enable fluid com | 100/100 | 0% | 3.2s | 4.1s | $0.0029 | 2/5 | 100/100 | fluid-compute ×100 |
| Your question is how long can a Vercel f | 91/100 (NONE) | 9% | 3.3s | 5.1s | $0.0061 | 3/5 | 89/91 | functions/configuring-functions/duration ×89 |
| So you are asking how preview deployment | 79/100 (NONE) | 21% | 3.3s | 4.6s | $0.0022 | 2/5 | 0/79 | deployments/rollback-production-deployment ×76 |
| You want to know how to add a custom dom | 99/100 (NONE) | 1% | 4.3s | 5.8s | $0.0032 | 5/5 | 9/99 | rest-api/projects/add-a-domain-to-a-project ×81 |

| control phrase (must be NONE) | NONE | false-pos% | med total |
|---|---|---|---|
| Thanks for joining, how was your weekend | 10/10 | 0% | 0.9s |
| Give me one second, someone is at the door | 9/10 | 0% | 1.0s |

**overall: 469/500 ok (6.2% fail) · median time-to-card 3.5s · p95 5.6s · median cost/insight $0.0029 · total spend $1.7658**
**gold-link precision: 282/469 (60%) · controls: 0/20 false positives**

### PR #4 (performance + DRY) — transcript GC + concurrent turns + MCP client reuse · prompt: Eve/unfamiliar-names rule, FINAL_STEP format re-injection, no-.md SOURCE · same model (gpt-5.4-mini, ttft)

# run 2026-07-03 23:02 UTC · https://k0-a00njj7ps-creatorplatform.vercel.app · commit 8e1ffab · 100x per phrase, conc 50

| phrase | ok | fail% | card med | card p95 | cost/insight | ground | gold hit | top link |
|---|---|---|---|---|---|---|---|---|
| So you are asking what is the AI gateway | 100/100 | 0% | 5.1s | 11.1s | $0.0026 | 5/5 | 70/100 | ai-gateway ×70 |
| You want to know how to enable fluid com | 100/100 | 0% | 3.2s | 5.1s | $0.0050 | 2/5 | 100/100 | fluid-compute ×100 |
| Your question is how long can a Vercel f | 100/100 | 0% | 3.2s | 4.7s | $0.0074 | 1/5 | 100/100 | functions/configuring-functions/duration ×100 |
| So you are asking how preview deployment | 100/100 | 0% | 3.0s | 4.2s | $0.0029 | 5/5 | 1/100 | deployments/rollback-production-deployment ×95 |
| You want to know how to add a custom dom | 99/100 (NONE) | 1% | 4.0s | 5.8s | $0.0040 | 5/5 | 2/99 | rest-api/projects/add-a-domain-to-a-project ×96 |

| control phrase (must be NONE) | NONE | false-pos% | med total |
|---|---|---|---|
| Thanks for joining, how was your weekend | 10/10 | 0% | 0.8s |
| Give me one second, someone is at the door | 10/10 | 0% | 0.6s |

**overall: 499/500 ok (0.2% fail) · median time-to-card 3.3s · p95 8.1s · median cost/insight $0.0043 · total spend $2.2907**
**gold-link precision: 273/499 (55%) · controls: 0/20 false positives**

vs the PR #3 run (same 100x/conc-50 method): fail rate 6.2% → 0.2% (the
preview-deployments 21%-NONE hole closed to 0%), ground sample 15/25 →
18/25, cost/insight $0.0029 → $0.0043 (+48% — FINAL_STEP re-injection and
fuller answers cost tokens). Gold precision dipped 60% → 55%: preview and
custom-domain phrases now almost always card but still cite the adjacent
page (rollback ×95, REST-API domain ×96) — misrouting is now THE dominant
defect, not failures. Note: run hit the PR #4 preview deployment (Vercel
Auth temporarily disabled for the probe, restored after).

### PR #6 (docs cache) — APPROACH CHANGE: committed 2,139-page local docs cache, read_vercel_doc is cache-first (network only on miss) · structured prompt (IDENTITY/FLOW, relevanceScore ≥ 0.75 gate) · zod card contract · same model (gpt-5.4-mini, ttft)

# run 2026-07-04 01:14 UTC · https://k0-qsvy93xn9-creatorplatform.vercel.app · commit cca028d · 100x per phrase, conc 50

| phrase | ok | fail% | card med | card p95 | cost/insight | ground | gold hit | top link |
|---|---|---|---|---|---|---|---|---|
| So you are asking what is the AI gateway | 97/100 (NONE) | 3% | 4.7s | 10.7s | $0.0031 | 5/5 | 72/97 | ai-gateway ×72 |
| You want to know how to enable fluid com | 100/100 | 0% | 3.0s | 3.7s | $0.0022 | 5/5 | 100/100 | fluid-compute ×100 |
| Your question is how long can a Vercel f | 100/100 | 0% | 3.1s | 4.3s | $0.0029 | 3/5 | 100/100 | functions/configuring-functions/duration ×100 |
| So you are asking how preview deployment | 98/100 (NONE) | 2% | 3.6s | 6.0s | $0.0037 | 5/5 | 8/98 | deployments/promote-preview-to-production ×65 |
| You want to know how to add a custom dom | 100/100 | 0% | 2.4s | 5.0s | $0.0019 | 1/5 | 0/100 | rest-api/projects/add-a-domain-to-a-project ×97 |

| control phrase (must be NONE) | NONE | false-pos% | med total |
|---|---|---|---|
| Thanks for joining, how was your weekend | 5/10 | 0% | 0.7s |
| Give me one second, someone is at the door | 10/10 | 0% | 0.7s |

**overall: 495/500 ok (1.0% fail) · median time-to-card 3.2s · p95 6.9s · median cost/insight $0.0028 · total spend $1.6517**
**gold-link precision: 280/495 (57%) · controls: 0/20 false positives**

vs PR #4: cost/insight $0.0043 → $0.0028 (−35% — cache-first reads +
structured prompt), p95 8.1s → 6.9s, median flat (3.3s → 3.2s: the .md
fetch was never the latency king — model turns are). Gold 55% → 57%;
preview-deployments now splits toward promote-preview (×65) instead of
rollback — closer, still not the environments page. Custom-domain still
misroutes to REST-API (×97). The relevanceScore gate introduced small
NONE leakage (3%/2% on two phrases). Weekend-control anomaly: 5/10 NONE
with 0 false positives — the other 5 returned neither NONE nor a card
(likely empty/format responses); watch next run. Misrouting remains the
dominant defect → next approach change: local embedding retrieval
(pre-call top-k injection), which this cache enables.


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


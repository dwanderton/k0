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
| You want to know how to add a custom domain to your project | `domains/working-with-domains/add-a-domain` or `domains/set-up-custom-domain` (co-gold added 2026-07-04 — canonical walkthrough, page-verified; runs before this date scored the single gold) |

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
- **Cold starts are split out** (2026-07-04 on): requests whose trace
  carries `❄ cold init Xms` (one-time model/index load on a fresh
  instance) are EXCLUDED from card med/p95 and reported on their own
  line (count · init median · cold-card median). Runs before this date
  blend cold into p95 — compare tails accordingly.
- Failures counted in `ok`, never dropped. `NONE` = agent judged no doc
  applies; that's a cue-phrase miss, not an API failure.
- **transcription $/hr** (PR #20 / Gladia-only onward) — a fixed known, not
  a probe measurement: Gladia real-time bills **$0.75/audio-hour** (list;
  volume tiers to ~$0.25) per LISTENING minute, independent of cards. The
  probe hits `/api/agent` directly, so cost/insight columns are LLM-only;
  on a realistic call transcription is ~97% of marginal cost (~$0.06/insight
  at 12 cards/hr vs ~$0.0015 LLM). Idle cutoff (10 min without a finalized
  utterance auto-stops the session) bounds the silence spend.
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
| 2026-07-04 | additive: description-led first chunks (1,395 changed) + root-only refinement (165 changed) | +99,511 | $0.1129 cumulative |
| 2026-07-04 | in-process index (bge-small, local model) — full builds ×2 | 0 (local) | $0 |
| 2026-07-05 | additive: nextjs-docs source (470 pages → 3,243 new chunks, 19,395 rows) | +867,464 | $0.1302 cumulative |
| 2026-07-05 | int8 requantize of gateway index (P002 size gate: 92.6MB br → 13.0MB) + local index stored raw — all vectors reused | 0 | $0.1302 cumulative |

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

### PR #8 (local embeddings) — APPROACH CHANGE: pre-call local retrieval replaces MCP search · brute-force cosine over committed chunk index (16,152 chunks, fp32@1536, LFS) + hybrid path/heading boosts · candidates injected before the first model turn · step cap 4 · same model (gpt-5.4-mini, ttft)

# run 2026-07-04 02:49 UTC · https://k0-prjsys4o3-creatorplatform.vercel.app · commit 5857233 · 100x per phrase, conc 50

| phrase | ok | fail% | card med | card p95 | cost/insight | ground | gold hit | top link |
|---|---|---|---|---|---|---|---|---|
| So you are asking what is the AI gateway | 95/100 (NONE) | 5% | 2.6s | 8.0s | $0.0015 | 2/5 | 77/95 | ai-gateway ×77 |
| You want to know how to enable fluid com | 100/100 | 0% | 1.8s | 3.8s | $0.0019 | 5/5 | 100/100 | fluid-compute ×100 |
| Your question is how long can a Vercel f | 100/100 | 0% | 1.0s | 1.7s | $0.0012 | 5/5 | 100/100 | functions/configuring-functions/duration ×97 |
| So you are asking how preview deployment | 99/100 (NONE) | 1% | 1.0s | 1.8s | $0.0010 | 5/5 | 98/99 | deployments/environments ×98 |
| You want to know how to add a custom dom | 100/100 | 0% | 1.0s | 1.4s | $0.0010 | 5/5 | 3/100 | domains/set-up-custom-domain ×95 |

| control phrase (must be NONE) | NONE | false-pos% | med total |
|---|---|---|---|
| Thanks for joining, how was your weekend | 10/10 | 0% | 1.1s |
| Give me one second, someone is at the door | 10/10 | 0% | 1.1s |

**overall: 494/500 ok (1.2% fail) · median time-to-card 1.1s · p95 6.8s · median cost/insight $0.0012 · total spend $0.6914**
**gold-link precision: 378/494 (77%) · controls: 0/20 false positives**

vs PR #6, all acceptance gates passed:
- **median time-to-card 3.2s → 1.1s (−66%)** — pre-call retrieval + one-turn
  fast path deleted the search turn; p95 6.9s → 6.8s (conc-50).
- **gold precision 57% → 77%** as measured — and the domain row scored
  under the OLD single gold: its top link (set-up-custom-domain ×95) was
  adjudicated co-gold the same day (see method table); rescoring that row
  puts the run at ~96%. **preview-deployments 8% → 98/99 gold to
  deployments/environments** — the page no lexical search ever found.
- **cost/insight $0.0028 → $0.0012 (−57%)**; run spend $1.77 → $0.69.
- **controls 10/10 + 10/10 NONE, 0 false positives** — the PR#6 weekend
  anomaly (5/10 neither-NONE-nor-card) did not recur: retrieval floor
  returns zero candidates on small talk and the model NONEs cleanly.
- Residuals: ai-gateway phrase leaks 5% NONE (top candidate present at
  0.805 — model-side judgment wobble) and its ground sample dipped (2/5,
  anchor wobble); fail% 1.2% ≤ 2% gate.
- One-off index cost: $0.1109 (see Embedding index cost table). Query-time
  embedding rides cost/insight (~$0.00001/query).

### PR #9 (in-process embeddings + clean chunk text) — bge-small query embedding in the function (gateway embed = fallback) · chunk #0 embeds a clean title lead instead of raw frontmatter YAML (the real relevance lever — noise removal), with "Title — description" on product-root pages only · rootBonus rule DELETED (overview pages now win on merit) · framework penalty generalized to SCOPED_SECTIONS (frameworks, platforms; exemption tests identity segments, not leaf slugs) · same model (gpt-5.4-mini, throughput sort)

# run 2026-07-04 05:57 UTC · https://k0-brhp6553n-creatorplatform.vercel.app · commit 8445e9f · 100x per phrase, conc 50
# (replaces the earlier PR #9 preview run at commit d124671 per review —
#  same branch, pre-merge; that run measured 93% gold / 0.8s median)

| phrase | ok | fail% | card med | card p95 | cost/insight | ground | gold hit | top link |
|---|---|---|---|---|---|---|---|---|
| So you are asking what is the AI gateway | 98/100 (NONE) | 2% | 2.2s | 8.8s | $0.0016 | 4/5 | 98/98 | ai-gateway ×98 |
| You want to know how to enable fluid com | 100/100 | 0% | 1.2s | 2.6s | $0.0023 | 3/5 | 100/100 | fluid-compute ×100 |
| Your question is how long can a Vercel f | 100/100 | 0% | 1.2s | 2.0s | $0.0015 | 5/5 | 100/100 | functions/limitations ×100 |
| So you are asking how preview deployment | 99/100 (NONE) | 1% | 0.7s | 1.3s | $0.0016 | 5/5 | 99/99 | deployments/environments ×99 |
| You want to know how to add a custom dom | 100/100 | 0% | 0.7s | 1.7s | $0.0010 | 4/5 | 100/100 | domains/working-with-domains/add-a-domain ×100 |

| control phrase (must be NONE) | NONE | false-pos% | med total |
|---|---|---|---|
| Thanks for joining, how was your weekend | 10/10 | 0% | 1.0s |
| Give me one second, someone is at the door | 10/10 | 0% | 0.7s |

**overall: 497/500 ok (0.6% fail) · median time-to-card 1.1s · p95 7.5s · median cost/insight $0.0016 · total spend $0.8585**
**gold-link precision: 497/497 (100%) · controls: 0/20 false positives**

vs PR #8: median 1.1s → 1.1s (retrieval 337→66ms; conc-50 cold starts
mask it here — serial steady-state ~1.2s total vs ~2.0s), fail 1.2% →
0.6%, gold 77%/≈96% → **100% — every card across all five phrases cited
a gold page**. The duration watch-item is RESOLVED: 100/100 (the
/docs/limits leak died with the YAML-noise removal + rootBonus
deletion). ai-gateway NONE leak 5% → 2%. Experiments recorded: the
model-as-selector prompt line was tried and REJECTED (misses worsened
1/20 → 3/20 — it primes the pages it names); the chunk-text fix was
kept. Rule count net −1.

### PR #10 (NONE-retry + dynamic k) — retry once when the model NONEs a >0.9 candidate · single candidate in prefill when top relevanceScore > 0.95 (gateway-phrase prefill 2,487 → 636 tokens) · same model (gpt-5.4-mini, throughput sort)

# run 2026-07-04 06:37 UTC · https://k0-m93vmq2my-creatorplatform.vercel.app · commit bf3c92b · 100x per phrase, conc 50

| phrase | ok | fail% | card med | card p95 | cost/insight | ground | gold hit | top link |
|---|---|---|---|---|---|---|---|---|
| So you are asking what is the AI gateway | 97/100 (NONE) | 3% | 6.8s | 8.2s | $0.0008 | 5/5 | 97/97 | ai-gateway ×97 |
| You want to know how to enable fluid com | 100/100 | 0% | 1.3s | 2.1s | $0.0021 | 4/5 | 100/100 | fluid-compute ×100 |
| Your question is how long can a Vercel f | 100/100 | 0% | 1.2s | 2.0s | $0.0013 | 3/5 | 100/100 | functions/limitations ×100 |
| So you are asking how preview deployment | 100/100 | 0% | 0.8s | 1.1s | $0.0015 | 5/5 | 100/100 | deployments/environments ×100 |
| You want to know how to add a custom dom | 100/100 | 0% | 0.7s | 1.4s | $0.0010 | 2/5 | 100/100 | domains/working-with-domains/add-a-domain ×100 |

| control phrase (must be NONE) | NONE | false-pos% | med total |
|---|---|---|---|
| Thanks for joining, how was your weekend | 10/10 | 0% | 0.7s |
| Give me one second, someone is at the door | 10/10 | 0% | 0.8s |

**overall: 497/500 ok (0.6% fail) · median time-to-card 0.8s · p95 7.3s · median cost/insight $0.0014 · total spend $0.7160**
**gold-link precision: 497/497 (100%) · controls: 0/20 false positives**

vs PR #9 (clean-chunks run): gold 100% HELD with a single candidate on
dominant retrievals — the second excerpt really was dead weight. Cost:
gateway phrase $0.0016 → $0.0008 (halved, the −74% prefill), blended
$0.0016 → $0.0014. preview-deployments 99/99 → 100/100. Fail flat at
0.6%; all 3 NONEs sit on the gateway phrase (3%, was 2%) — that is the
POST-retry rate (both attempts refused): either n=100 noise or the
leaner single-candidate prompt raises per-attempt refusal and the retry
nets it out; the probe can't decompose (⟲ lines live in traces it
doesn't keep). Net: cost win, zero regressions.

### PR #11 (cold-split observability) — ❄ trace tag on one-time init; card med/p95 are warm-path only, cold starts reported separately · no agent-behavior change (same code as PR #10 otherwise)

# run 2026-07-04 07:03 UTC · https://k0-pio85isr8-creatorplatform.vercel.app · commit bd38235 · 100x per phrase, conc 50

| phrase | ok | fail% | card med | card p95 | cost/insight | ground | gold hit | top link |
|---|---|---|---|---|---|---|---|---|
| So you are asking what is the AI gateway | 100/100 ❄50 | 0% | 0.7s | 1.7s | $0.0008 | 5/5 | 99/100 | ai-gateway ×99 |
| You want to know how to enable fluid com | 100/100 | 0% | 1.5s | 2.3s | $0.0021 | 4/5 | 100/100 | fluid-compute ×100 |
| Your question is how long can a Vercel f | 100/100 | 0% | 1.4s | 2.2s | $0.0015 | 5/5 | 100/100 | functions/limitations ×100 |
| So you are asking how preview deployment | 98/100 (NONE) | 2% | 0.8s | 1.2s | $0.0015 | 5/5 | 98/98 | deployments/environments ×98 |
| You want to know how to add a custom dom | 100/100 | 0% | 0.8s | 1.8s | $0.0011 | 4/5 | 100/100 | domains/working-with-domains/add-a-domain ×100 |

| control phrase (must be NONE) | NONE | false-pos% | med total |
|---|---|---|---|
| Thanks for joining, how was your weekend | 10/10 | 0% | 0.8s |
| Give me one second, someone is at the door | 10/10 | 0% | 0.7s |

**cold starts: 50/500 · init med 3.1s · cold card med 6.2s (excluded from table med/p95)**

**overall: 498/500 ok (0.4% fail) · median time-to-card 0.9s · p95 2.0s (warm) · median cost/insight $0.0015 · total spend $0.7090**
**gold-link precision: 497/498 (100%) · controls: 0/20 false positives**

The split's proof-of-work: exactly 50 cold starts, ALL absorbed by the
first phrase (the conc-50 burst spawns one fleet of fresh instances) —
its warm profile is 0.7s med / 1.7s p95, previously reported as
6.8s/8.2s blended. True warm p95 = 2.0s; the "long p95" of every prior
run was cold contamination, now priced separately (init med 3.1s, cold
cards ~6.2s). Best fail rate yet (0.4%); gateway phrase 0 NONEs this
run (retry earning its keep); preview phrase 2 NONEs — the residual
refusal wanders between phrases at ~2/500 scale.

### PR #16 (Next.js support) — nextjs-docs source added (470 pages, 3,243 chunks; corpus 16,152 → 19,395 rows) · gateway index int8-quantized (P002 size gate; 13.0MB br) · local index stored RAW (brotli only shaved ~10% off float vectors for ~300ms cold decompress) · read_vercel_doc accepts nextjs.org documentUris · same model (gpt-5.4-mini, throughput sort)

# run 2026-07-05 22:00 UTC · https://k0-ch24njszs-creatorplatform.vercel.app · commit a4280de · 100x per phrase, conc 100

| phrase | ok | fail% | card med | card p95 | cost/insight | ground | gold hit | top link |
|---|---|---|---|---|---|---|---|---|
| So you are asking what is the AI gateway | 100/100 ❄98 | 0% | 0.9s | 1.0s | $0.0008 | 5/5 | 99/100 | ai-gateway ×99 |
| You want to know how to enable fluid com | 100/100 ❄1 | 0% | 1.7s | 5.3s | $0.0018 | 5/5 | 100/100 | fluid-compute ×100 |
| Your question is how long can a Vercel f | 100/100 | 0% | 1.0s | 2.4s | $0.0012 | 4/5 | 100/100 | functions/limitations ×100 |
| So you are asking how preview deployment | 99/100 (NONE) | 1% | 0.8s | 1.9s | $0.0016 | 5/5 | 99/99 | deployments/environments ×99 |
| You want to know how to add a custom dom | 100/100 | 0% | 1.2s | 2.5s | $0.0015 | 5/5 | 100/100 | domains/working-with-domains/add-a-domain ×100 |

| control phrase (must be NONE) | NONE | false-pos% | med total |
|---|---|---|---|
| Thanks for joining, how was your weekend | 10/10 | 0% | 0.8s |
| Give me one second, someone is at the door | 10/10 | 0% | 0.8s |

**cold starts: 99/500 · init med 3.1s · cold card med 5.9s (excluded from table med/p95)**

**overall: 499/500 ok (0.2% fail) · median time-to-card 0.9s · p95 4.0s (warm) · median cost/insight $0.0015 · total spend $0.7403**
**gold-link precision: 498/499 (100%) · controls: 0/20 false positives**

vs PR #11: the risk was dilution — 3,243 new Next.js chunks competing in
the corpus — and it didn't happen: gold 100% held, 0/20 control false
positives, ground 24/25 (best yet), fail 0.4% → 0.2%. Cold init med
3.1s → 3.1s FLAT while boot-time corpus parsing grew 19% — the raw local
index (−~300ms decompress) paid for the Next.js expansion. Warm median
0.9s flat, cost flat. Note conc-100 here vs conc-50 prior: client
contention pads warm p95 (4.0s), compare p95 only at equal CONC. New
capability spot-checked separately: "use cache" cues retrieve
nextjs.org/docs at 0.956 relevance (no fixed Next.js phrase in the set
yet — add as NEW rows per method). Residual: preview-deployments NONE
1/100 here + 1/10 in a warm-up run (~1–2%) — top candidate sits nearest
the 0.9 retry floor; drop RETRY_FLOOR a notch if it recurs. A same-day
prod run (main, 10x serial) for reference: 50/50 ok, 0.9s med, gold
100%, ground 20/25, ❄2 init med 3.2s.

### PR #18 (mobile transcription + retry floor) — Gladia live transcription replaces browser SpeechRecognition on mobile (server-minted session, AudioWorklet 16kHz PCM over WS; agent path unchanged for this probe) · NONE-retry floor 0.9 → 0.85 · plural mishear tidy rules · same model (gpt-5.4-mini, throughput sort)

# run 2026-07-05 22:54 UTC · https://k0-qqu87ew67-creatorplatform.vercel.app · commit 0aa017d · 10x per phrase, conc 1

| phrase | ok | fail% | card med | card p95 | cost/insight | ground | gold hit | top link |
|---|---|---|---|---|---|---|---|---|
| So you are asking what is the AI gateway | 10/10 | 0% | 0.7s | 1.5s | $0.0009 | 5/5 | 9/10 | ai-gateway ×9 |
| You want to know how to enable fluid com | 10/10 | 0% | 0.9s | 1.3s | $0.0020 | 5/5 | 10/10 | fluid-compute ×10 |
| Your question is how long can a Vercel f | 9/10 (TimeoutError: The operation wa) | 10% | 1.2s | 1.7s | $0.0014 | 5/5 | 9/9 | functions/limitations ×9 |
| So you are asking how preview deployment | 9/10 (NONE) | 10% | 0.6s | 1.5s | $0.0016 | 5/5 | 9/9 | deployments/environments ×9 |
| You want to know how to add a custom dom | 10/10 ❄1 | 0% | 0.7s | 2.5s | $0.0014 | 4/5 | 10/10 | domains/working-with-domains/add-a-domain ×10 |

| control phrase (must be NONE) | NONE | false-pos% | med total |
|---|---|---|---|
| Thanks for joining, how was your weekend | 10/10 | 0% | 0.7s |
| Give me one second, someone is at the door | 10/10 | 0% | 0.7s |

**cold starts: 1/50 · init med 2.6s · cold card med 4.5s (excluded from table med/p95)**

**overall: 48/50 ok (4.0% fail) · median time-to-card 0.8s · p95 1.6s (warm) · median cost/insight $0.0016 · total spend $0.0756**
**gold-link precision: 47/48 (98%) · controls: 0/20 false positives**

An identical run minutes earlier (per-phrase table lost to a tail
filter; summary preserved): 50/50 ok, gold 50/50, ground 24/25, controls
0/20 FP, med 0.7s / p95 1.5s. Combined post-change: 98/100 ok, 0/40
control false positives. Verdict on the 0.85 floor: controls UNAFFECTED
(the risk being priced); the preview-deployments NONE still recurred
1/20 — that residual is POST-retry (both attempts refused), the same
~1–2% scale PR #10 documented. No-harm, unproven-gain. The
duration-phrase failure is a client-side 30s probe timeout, not a
server error. This probe hits /api/agent directly, so it measures the
agent path only — the Gladia mobile path feeds the same segments
pipeline upstream of it.

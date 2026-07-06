#!/usr/bin/env node
/**
 * k0 agent scorecard — latency, cost, groundedness, discrimination.
 *
 * Per cue phrase:
 *   ttfb   — ms to first stream byte
 *   card   — ms to first card byte (DOC:) — the headline metric
 *   cost   — $ per insight, from the gateway per-step trace lines
 *   fail%  — anything that isn't a parsed card (failures never dropped)
 *   link   — most frequent SOURCE (drift detector)
 *   ground — QUOTE verbatim on the real page AND ANCHOR inside QUOTE
 * Negative controls MUST return NONE — the false-positive rate.
 *
 * Usage:
 *   node scorecard/run.mjs                       # prod, RUNS per phrase
 *   RUNS=100 CONC=50 node scorecard/run.mjs      # full run, 50 in flight
 *   node scorecard/run.mjs http://localhost:3000 # local
 *
 * CONC>1: server latency unaffected (each request its own invocation) but
 * client contention pads the tail — compare p95 only at equal CONC.
 */

import { execSync } from "node:child_process";

const BASE = process.argv[2] ?? "https://k0-omega.vercel.app";
// the scorecard is a deliberate bot — SCORECARD_PROBE_SECRET bypasses BotID
const PROBE = process.env.SCORECARD_PROBE_SECRET;
const PROBE_HEADERS = PROBE ? { "x-k0-probe": PROBE } : {};
const RUNS = Number(process.env.RUNS ?? 10);
const CONC = Math.max(1, Number(process.env.CONC ?? 1));
const NEG_RUNS = Math.max(3, Math.min(RUNS, 10));
const GROUND_SAMPLE = Math.min(5, RUNS);
const TIMEOUT_MS = 30_000;
const NUL = "\u0000";

/** SA restating a customer question — each must cue a card. `gold` = the
 *  page(s) an SA would actually send, hand-verified against live docs
 *  (.md fetch, 2026-07-03). SOURCE matching gold = link precision; mode
 *  drifting from gold between runs = the model or index moved. */
const PHRASES = [
  {
    text: "So you are asking what is the AI gateway",
    gold: ["ai-gateway"],
  },
  {
    text: "You want to know how to enable fluid compute for a single deployment",
    gold: ["fluid-compute"],
  },
  {
    text: "Your question is how long can a Vercel function run before it times out",
    // both pages carry the maxDuration limits table
    gold: ["functions/limitations", "functions/configuring-functions/duration"],
  },
  {
    text: "So you are asking how preview deployments work on Vercel",
    // NB: deployments/preview-deployments is a 404 — environments page is
    // the canonical preview docs
    gold: ["deployments/environments"],
  },
  {
    text: "You want to know how to add a custom domain to your project",
    // set-up-custom-domain co-gold (page-verified 2026-07-04) — canonical
    // walkthrough; single gold was too narrow
    gold: [
      "domains/working-with-domains/add-a-domain",
      "domains/set-up-custom-domain",
    ],
  },
];

/** FIXED — change these and the false-positive rate stops comparing across
 *  runs. Zero Vercel content: must answer NONE; a card = false positive. */
const CONTROLS = [
  "Thanks for joining, how was your weekend",
  "Give me one second, someone is at the door",
];

function split(raw) {
  const debug = [];
  const parts = raw.split(NUL);
  let card = parts[0];
  for (let k = 1; k < parts.length; k++) {
    const nl = parts[k].indexOf("\n");
    if (nl === -1) continue;
    debug.push(parts[k].slice(0, nl));
    card += parts[k].slice(nl + 1);
  }
  return { card, debug };
}

const field = (card, k) =>
  card.match(new RegExp(`^${k}:\\s*(.*)$`, "mi"))?.[1]?.trim() ?? "";

async function probeMany(phrase, n) {
  const rs = new Array(n);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONC, n) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= n) return;
        rs[i] = await probe(phrase);
      }
    }),
  );
  return rs;
}

async function probe(phrase) {
  const t0 = performance.now();
  let ttfb = null;
  let cardAt = null;
  let raw = "";
  try {
    const res = await fetch(`${BASE}/api/agent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...PROBE_HEADERS },
      body: JSON.stringify({ transcript: phrase }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok || !res.body) {
      return { ok: false, error: `HTTP ${res.status}`, total: performance.now() - t0 };
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (ttfb === null) ttfb = performance.now() - t0;
      raw += dec.decode(value, { stream: true });
      if (cardAt === null && split(raw).card.includes("DOC:")) {
        cardAt = performance.now() - t0;
      }
    }
    raw += dec.decode();
    const { card, debug } = split(raw);
    const none = card.trim().toUpperCase().startsWith("NONE");
    const ok = card.includes("DOC:") && card.includes("QUOTE:");
    // gateway trace line shape: "✓ step N: stop · $0.00123"
    const cost = debug
      .map((l) => l.match(/\$([0-9.eE-]+)/)?.[1])
      .filter(Boolean)
      .reduce((s, c) => s + Number(c), 0);
    const cold = debug
      .map((l) => l.match(/❄ cold init (\d+)ms/)?.[1])
      .filter(Boolean)
      .map(Number)[0] ?? null;
    return {
      cold,
      ok,
      none,
      ttfb,
      card: cardAt,
      total: performance.now() - t0,
      cost: cost || null,
      quote: field(card, "QUOTE"),
      anchor: field(card, "ANCHOR"),
      source: field(card, "SOURCE"),
      error: ok || none ? undefined : "no card",
    };
  } catch (err) {
    return { ok: false, error: String(err?.cause ?? err).slice(0, 80), total: performance.now() - t0 };
  }
}

/** QUOTE verbatim on the real page + ANCHOR inside QUOTE. "Verbatim" =
 *  rendered words, not raw markdown (model renders as it READS; table quotes
 *  arrive flattened). Strip markdown furniture both sides, then substring
 *  hit OR ≥80% coverage of word 8-grams — lets table-shaped quotes pass
 *  while fabricated sentences still fail. */
const groundCache = new Map();
const strip = (s) =>
  s
    .toLowerCase()
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // [label](url) -> label
    .replace(/^\|?[\s|:-]+\|?$/gm, " ") // table separator rows
    .replace(/[|`*_#>]/g, " ") // pipes, bold, headers, quotes-blocks
    .replace(/["'‘’“”]/g, "")
    .replace(/\s+/g, " ")
    .trim();

function ngramCoverage(quote, page, n = 8) {
  const w = quote.split(" ");
  if (w.length <= n) return page.includes(quote) ? 1 : 0;
  let hit = 0, total = 0;
  for (let i = 0; i + n <= w.length; i += 1) {
    total++;
    if (page.includes(w.slice(i, i + n).join(" "))) hit++;
  }
  return total ? hit / total : 0;
}

async function grounded(r) {
  if (!r.ok || !r.source || !r.quote) return false;
  const path = r.source
    .replace(/^https?:\/\/vercel\.com\/docs\//, "")
    .replace(/[#?].*$/, "");
  if (!/^[a-z0-9/-]+$/i.test(path)) return false;
  let md = groundCache.get(path);
  if (md == null) {
    try {
      md = await (await fetch(`https://vercel.com/docs/${path}.md`, { signal: AbortSignal.timeout(15_000) })).text();
    } catch {
      md = "";
    }
    groundCache.set(path, md);
  }
  if (!md) return false;
  const anchorInQuote = !!r.anchor && strip(r.quote).includes(strip(r.anchor));
  const q = strip(r.quote);
  const page = strip(md);
  const onPage = page.includes(q) || ngramCoverage(q, page) >= 0.8;
  return anchorInQuote && onPage;
}

const med = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const p95 = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)];
};
const fmt = (ms) => (ms == null ? "—" : `${(ms / 1000).toFixed(1)}s`);
const fmt$ = (c) => (c == null ? "—" : `$${c.toFixed(4)}`);

let commit = "unknown";
try {
  commit = execSync("git rev-parse --short HEAD", { cwd: new URL("..", import.meta.url).pathname }).toString().trim();
} catch {}

const stamp = new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";
console.log(`# run ${stamp} · ${BASE} · commit ${commit} · ${RUNS}x per phrase, conc ${CONC}\n`);
console.log(`| phrase | ok | fail% | card med | card p95 | cost/insight | ground | gold hit | top link |`);
console.log(`|---|---|---|---|---|---|---|---|---|`);

const allCard = [];
const allCost = [];
const allCold = [];
let allOk = 0, allN = 0, allGold = 0;

const pagePath = (source) =>
  source.replace(/^https?:\/\/vercel\.com\/docs\//, "").replace(/[#?].*$/, "").replace(/\/+$/, "");

for (const { text: phrase, gold } of PHRASES) {
  const rs = await probeMany(phrase, RUNS);
  const oks = rs.filter((r) => r.ok);
  // cold starts are a separate metric, not tail noise in card med/p95
  const warmOks = oks.filter((r) => r.cold == null);
  const cards = warmOks.map((r) => r.card).filter((x) => x != null);
  const costs = oks.map((r) => r.cost).filter((x) => x != null);
  const colds = rs.filter((r) => r.cold != null);
  allCold.push(...colds.map((r) => ({ init: r.cold, card: r.ok ? r.card : null })));
  allCard.push(...cards);
  allCost.push(...costs);
  allOk += oks.length;
  allN += rs.length;

  const goldHits = oks.filter((r) => gold.includes(pagePath(r.source))).length;
  allGold += goldHits;

  // strip fragment — same page, different anchor = same link
  const links = new Map();
  for (const r of oks) {
    const l = r.source.replace(/#.*$/, "");
    if (!l) continue;
    links.set(l, (links.get(l) ?? 0) + 1);
  }
  const top = [...links.entries()].sort((a, b) => b[1] - a[1])[0];

  const sample = oks.slice(0, GROUND_SAMPLE);
  let g = 0;
  for (const r of sample) if (await grounded(r)) g++;

  const errs = [...new Set(rs.filter((r) => !r.ok).map((r) => (r.none ? "NONE" : r.error)))];
  const failPct = (((rs.length - oks.length) / rs.length) * 100).toFixed(0);
  console.log(
    `| ${phrase.slice(0, 40)} | ${oks.length}/${rs.length}${errs.length ? ` (${errs.join("; ").slice(0, 30)})` : ""}${colds.length ? ` ❄${colds.length}` : ""} | ${failPct}% | ${fmt(med(cards))} | ${fmt(p95(cards))} | ${fmt$(med(costs))} | ${g}/${sample.length} | ${oks.length ? `${goldHits}/${oks.length}` : "—"} | ${top ? `${top[0].replace("https://vercel.com/docs/", "")} ×${top[1]}` : "—"} |`,
  );
}

console.log(`\n| control phrase (must be NONE) | NONE | false-pos% | med total |`);
console.log(`|---|---|---|---|`);
let falsePos = 0, negN = 0;
for (const phrase of CONTROLS) {
  const rs = await probeMany(phrase, NEG_RUNS);
  const nones = rs.filter((r) => r.none);
  const fps = rs.filter((r) => r.ok).length;
  falsePos += fps;
  negN += rs.length;
  console.log(
    `| ${phrase} | ${nones.length}/${rs.length} | ${((fps / rs.length) * 100).toFixed(0)}% | ${fmt(med(rs.map((r) => r.total)))} |`,
  );
}

if (allCold.length) {
  const inits = allCold.map((c) => c.init);
  const coldCards = allCold.map((c) => c.card).filter((x) => x != null);
  console.log(
    `\n**cold starts: ${allCold.length}/${allN} · init med ${fmt(med(inits))} · cold card med ${fmt(med(coldCards))} (excluded from table med/p95)**`,
  );
}
console.log(`\n**overall: ${allOk}/${allN} ok (${(((allN - allOk) / allN) * 100).toFixed(1)}% fail) · median time-to-card ${fmt(med(allCard))} · p95 ${fmt(p95(allCard))} (warm) · median cost/insight ${fmt$(med(allCost))} · total spend ${fmt$(allCost.reduce((a, b) => a + b, 0))}**`);
console.log(`**gold-link precision: ${allOk ? `${allGold}/${allOk} (${((allGold / allOk) * 100).toFixed(0)}%)` : "—"} · controls: ${falsePos}/${negN} false positives**`);

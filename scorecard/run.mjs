#!/usr/bin/env node
/**
 * k0 agent scorecard — latency, cost, groundedness, discrimination.
 *
 * Per cue phrase (N serial runs each):
 *   ttfb   — ms to first stream byte (MCP connect + gateway routing)
 *   card   — ms to first card byte (DOC:) — the headline metric
 *   p95    — tail matters on a live call, not just the median
 *   cost   — $ per insight, parsed from the gateway's per-step trace lines
 *   fail%  — anything that isn't a parsed card (failures never dropped)
 *   link   — most frequently recommended SOURCE (drift detector)
 *   ground — QUOTE verbatim on the real .md page AND ANCHOR inside QUOTE
 *            (checked on a sample per phrase; hallucination regression)
 *
 * Negative controls: small-talk phrases that MUST return NONE — measures
 * over-triggering, the false-positive rate.
 *
 * Usage:
 *   node scorecard/run.mjs                       # prod, RUNS per phrase
 *   RUNS=100 CONC=50 node scorecard/run.mjs      # full run, 50 in flight
 *   node scorecard/run.mjs http://localhost:3000 # local
 *
 * CONC>1 runs requests through a worker pool. Server-side latency is
 * unaffected (each request is its own serverless invocation) but client
 * contention can pad the tail — compare p95 only against runs with the
 * same CONC.
 */

import { execSync } from "node:child_process";

const BASE = process.argv[2] ?? "https://k0-omega.vercel.app";
const RUNS = Number(process.env.RUNS ?? 10);
const CONC = Math.max(1, Number(process.env.CONC ?? 1));
const NEG_RUNS = Math.max(3, Math.min(RUNS, 10));
const GROUND_SAMPLE = Math.min(5, RUNS); // groundedness checks per phrase
const TIMEOUT_MS = 30_000;
const NUL = "\u0000";

/** SA restating a customer question — each must cue a card.
 *  `gold` = the docs page(s) a Vercel SA would actually send, verified by
 *  hand against live vercel.com/docs (.md fetch, 2026-07-03). The agent's
 *  SOURCE matching gold = link precision; the mode drifting from gold
 *  between runs = the model or search index moved. */
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
    gold: ["domains/working-with-domains/add-a-domain"],
  },
];

/** FIXED negative controls — never change these between runs, or the
 *  false-positive rate stops being comparable over time. Small talk with
 *  zero Vercel content: the agent must answer NONE. A card = false positive. */
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

/** Run `n` probes of `phrase` through a CONC-wide worker pool. */
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
      headers: { "Content-Type": "application/json" },
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
    // $ per step from the gateway trace lines: "✓ step N: stop · $0.00123"
    const cost = debug
      .map((l) => l.match(/\$([0-9.eE-]+)/)?.[1])
      .filter(Boolean)
      .reduce((s, c) => s + Number(c), 0);
    return {
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

/** QUOTE verbatim on the real page + ANCHOR inside QUOTE.
 *
 * "Verbatim" is judged on rendered words, not raw markdown: the model is
 * told to render the page as it READS (drop link syntax, backticks), and
 * quotes from tables arrive flattened (pipes and header rows gone). So:
 * strip ALL markdown furniture from both sides, then accept either a
 * direct substring hit or ≥80% coverage of the quote's word 8-grams —
 * the fallback that lets table-shaped quotes (row order kept, header row
 * skipped) pass while fabricated sentences still fail. */
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
let allOk = 0, allN = 0, allGold = 0;

const pagePath = (source) =>
  source.replace(/^https?:\/\/vercel\.com\/docs\//, "").replace(/[#?].*$/, "").replace(/\/+$/, "");

for (const { text: phrase, gold } of PHRASES) {
  const rs = await probeMany(phrase, RUNS);
  const oks = rs.filter((r) => r.ok);
  const cards = oks.map((r) => r.card).filter((x) => x != null);
  const costs = oks.map((r) => r.cost).filter((x) => x != null);
  allCard.push(...cards);
  allCost.push(...costs);
  allOk += oks.length;
  allN += rs.length;

  // link precision vs hand-verified gold source
  const goldHits = oks.filter((r) => gold.includes(pagePath(r.source))).length;
  allGold += goldHits;

  // link mode (strip fragment — same page, different anchor = same link)
  const links = new Map();
  for (const r of oks) {
    const l = r.source.replace(/#.*$/, "");
    if (!l) continue;
    links.set(l, (links.get(l) ?? 0) + 1);
  }
  const top = [...links.entries()].sort((a, b) => b[1] - a[1])[0];

  // groundedness on a sample of ok cards
  const sample = oks.slice(0, GROUND_SAMPLE);
  let g = 0;
  for (const r of sample) if (await grounded(r)) g++;

  const errs = [...new Set(rs.filter((r) => !r.ok).map((r) => (r.none ? "NONE" : r.error)))];
  const failPct = (((rs.length - oks.length) / rs.length) * 100).toFixed(0);
  console.log(
    `| ${phrase.slice(0, 40)} | ${oks.length}/${rs.length}${errs.length ? ` (${errs.join("; ").slice(0, 30)})` : ""} | ${failPct}% | ${fmt(med(cards))} | ${fmt(p95(cards))} | ${fmt$(med(costs))} | ${g}/${sample.length} | ${oks.length ? `${goldHits}/${oks.length}` : "—"} | ${top ? `${top[0].replace("https://vercel.com/docs/", "")} ×${top[1]}` : "—"} |`,
  );
}

// Fixed negative controls — reported per phrase, like the cue table.
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

console.log(`\n**overall: ${allOk}/${allN} ok (${(((allN - allOk) / allN) * 100).toFixed(1)}% fail) · median time-to-card ${fmt(med(allCard))} · p95 ${fmt(p95(allCard))} · median cost/insight ${fmt$(med(allCost))} · total spend ${fmt$(allCost.reduce((a, b) => a + b, 0))}**`);
console.log(`**gold-link precision: ${allOk ? `${allGold}/${allOk} (${((allGold / allOk) * 100).toFixed(0)}%)` : "—"} · controls: ${falsePos}/${negN} false positives**`);

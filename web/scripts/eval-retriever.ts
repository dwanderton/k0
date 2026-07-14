/**
 * P005 stage 1 — offline retriever eval against the FIXED scorecard
 * phrases + gold sources (scorecard/SCORECARD.md). No model, no route.
 *
 * GATE: hit@3 = 5/5 and hit@1 ≥ 4/5, including deployments/environments
 * for the preview phrase — the page lexical search never found.
 */
import { readFile } from "fs/promises";
import { join } from "path";
import { retrieve } from "../lib/retriever.ts";

const CASES: { phrase: string; gold: string[] }[] = [
  { phrase: "So you are asking what is the AI gateway", gold: ["/docs/ai-gateway"] },
  {
    phrase: "You want to know how to enable fluid compute for a single deployment",
    gold: ["/docs/fluid-compute"],
  },
  {
    phrase: "Your question is how long can a Vercel function run before it times out",
    gold: ["/docs/functions/limitations", "/docs/functions/configuring-functions/duration"],
  },
  {
    phrase: "So you are asking how preview deployments work on Vercel",
    gold: ["/docs/deployments/environments"],
  },
  {
    phrase: "You want to know how to add a custom domain to your project",
    // set-up-custom-domain co-gold (page-verified 2026-07-04) — canonical
    // walkthrough; single gold was too narrow
    gold: [
      "/docs/domains/working-with-domains/add-a-domain",
      "/docs/domains/set-up-custom-domain",
    ],
  },
];
const CONTROLS = [
  "Thanks for joining, how was your weekend",
  "Give me one second, someone is at the door",
];

/** kb-mode gate: docs-shaped questions, results must all be vercel-kb: */
const KB_CASES: { phrase: string; gold: string[] }[] = [
  {
    phrase: "They are asking whether Vercel supports Docker deployments",
    gold: ["/kb/guide/does-vercel-support-docker-deployments", "/kb/guide/docker"],
  },
  {
    phrase: "You want to know if serverless functions support WebSocket connections",
    gold: [
      "/kb/guide/do-vercel-serverless-functions-support-websocket-connections",
      "/kb/guide/real-time-chat-websockets",
    ],
  },
  {
    phrase: "So you are asking how to enable CORS on your API",
    gold: ["/kb/guide/how-to-enable-cors"],
  },
];

/** customers-mode gate: gold posts by product mention, plus the isolation
 *  invariant — every result must come from customers-manifest.json */
const CUSTOMER_CASES: { phrase: string; gold: string[] }[] = [
  {
    phrase: "They want an example of a customer building with v0",
    gold: [
      "/blog/how-stripe-built-a-game-changing-app-in-a-single-flight-with-v0",
      "/blog/how-zapier-scales-product-partnerships-with-v0",
      "/blog/How-avalara-turns-pipedreams-into-patent-pending-with-v0",
      "/blog/how-code-and-theory-cut-time-to-prototype-75-with-v0",
      "/blog/cutting-delivery-times-in-half-with-v0",
      "/blog/bridging-the-gap-between-design-and-code-with-v0",
    ],
  },
  {
    phrase: "So you are asking who runs untrusted code at scale with Vercel Sandbox",
    gold: [
      "/blog/notion-workers-vercel-sandbox",
      "/blog/how-conductor-moved-parallel-coding-agents-from-the-laptop-to-the-cloud-with-vercel-sandbox",
    ],
  },
  {
    phrase: "You want to know which customers built products with the AI SDK",
    gold: [
      "/blog/how-chatbase-scaled-rapidly-with-vercels-developer-experience-and-ai-sdk",
      "/blog/using-the-ai-sdk-to-build-sitecore-streams-ai-powered-brand-aware-assistant",
      "/blog/leveraging-vercel-and-the-ai-sdk-to-deliver-a-seamless-ai-powered-experience",
    ],
  },
];

const path = (uri: string) => new URL(uri).pathname;

let hit1 = 0;
let hit3 = 0;
for (const { phrase, gold } of CASES) {
  const t0 = performance.now();
  const cands = await retrieve(phrase, 3);
  const ms = (performance.now() - t0).toFixed(0);
  const paths = cands.map((c) => path(c.documentUri));
  const h1 = gold.includes(paths[0]);
  const h3 = paths.some((p) => gold.includes(p));
  hit1 += h1 ? 1 : 0;
  hit3 += h3 ? 1 : 0;
  console.log(`\n"${phrase.slice(0, 50)}…" (${ms}ms) hit@1=${h1} hit@3=${h3}`);
  for (const c of cands) {
    console.log(
      `  ${c.relevanceScore.toFixed(3)} (cos ${(1 - c.questionDistance).toFixed(3)}) ${path(c.documentUri)} · ${c.documentTitle.slice(0, 34)}`,
    );
  }
}

console.log("\n--- controls (want empty or very low scores) ---");
for (const phrase of CONTROLS) {
  const cands = await retrieve(phrase, 3);
  console.log(
    `"${phrase.slice(0, 40)}…" → ${cands.length === 0 ? "[] (below floor)" : cands.map((c) => `${c.relevanceScore.toFixed(3)} ${path(c.documentUri)}`).join(" · ")}`,
  );
}

console.log("\n--- customers mode (always 4 stories, no floor) ---");
const manifest = new Set<string>(
  (
    JSON.parse(
      await readFile(join(process.cwd(), "customers-manifest.json"), "utf8"),
    ) as { path: string }[]
  ).map((e) => e.path),
);
let cHit1 = 0;
let cHit4 = 0;
let leaked = 0;
let short = 0;
for (const { phrase, gold } of CUSTOMER_CASES) {
  const t0 = performance.now();
  const cands = await retrieve(phrase, 4, 1500, "customers");
  const ms = (performance.now() - t0).toFixed(0);
  // always-4 invariant: no single returns, no empty — the SA always gets
  // a menu of proof points
  if (cands.length !== 4) {
    short++;
    console.error(`  ✗ ALWAYS-4 VIOLATED: got ${cands.length} stories`);
  }
  const paths = cands.map((c) => path(c.documentUri));
  for (const p of paths) {
    if (!manifest.has(p)) {
      leaked++;
      console.error(`  ✗ MODE LEAK: ${p} not in customers-manifest.json`);
    }
  }
  const h1 = gold.includes(paths[0]);
  const h4 = paths.some((p) => gold.includes(p));
  cHit1 += h1 ? 1 : 0;
  cHit4 += h4 ? 1 : 0;
  console.log(`\n"${phrase.slice(0, 50)}…" (${ms}ms) hit@1=${h1} hit@4=${h4}`);
  for (const c of cands) {
    console.log(
      `  ${c.relevanceScore.toFixed(3)} (cos ${(1 - c.questionDistance).toFixed(3)}) ${path(c.documentUri)} · ${c.documentTitle.slice(0, 34)}`,
    );
  }
}

console.log("\n--- kb mode ---");
let kHit1 = 0;
let kHit3 = 0;
let kLeaked = 0;
for (const { phrase, gold } of KB_CASES) {
  const t0 = performance.now();
  const cands = await retrieve(phrase, 3, 1500, "kb");
  const ms = (performance.now() - t0).toFixed(0);
  const paths = cands.map((c) => path(c.documentUri));
  for (const p of paths) {
    if (!p.startsWith("/kb/guide/")) {
      kLeaked++;
      console.error(`  ✗ MODE LEAK: ${p} is not a KB guide`);
    }
  }
  const h1 = gold.includes(paths[0]);
  const h3 = paths.some((p) => gold.includes(p));
  kHit1 += h1 ? 1 : 0;
  kHit3 += h3 ? 1 : 0;
  console.log(`\n"${phrase.slice(0, 50)}…" (${ms}ms) hit@1=${h1} hit@3=${h3}`);
  for (const c of cands) {
    console.log(
      `  ${c.relevanceScore.toFixed(3)} (cos ${(1 - c.questionDistance).toFixed(3)}) ${path(c.documentUri)} · ${c.documentTitle.slice(0, 34)}`,
    );
  }
}

console.log(`\nGATE: hit@1 ${hit1}/5 (need ≥4) · hit@3 ${hit3}/5 (need 5)`);
console.log(
  `GATE (customers): hit@1 ${cHit1}/3 (need ≥2) · hit@4 ${cHit4}/3 (need 3) · leaks ${leaked} (need 0) · short returns ${short} (need 0)`,
);
console.log(
  `GATE (kb): hit@1 ${kHit1}/3 (need ≥2) · hit@3 ${kHit3}/3 (need 3) · leaks ${kLeaked} (need 0)`,
);
if (
  hit3 < 5 || hit1 < 4 ||
  cHit4 < 3 || cHit1 < 2 || leaked > 0 || short > 0 ||
  kHit3 < 3 || kHit1 < 2 || kLeaked > 0
) {
  console.error("✗ GATE FAILED — do not proceed to P004");
  process.exit(1);
}
console.log("✓ gate passed");

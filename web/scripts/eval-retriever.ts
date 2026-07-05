/**
 * P005 stage 1 — offline retriever eval against the FIXED scorecard
 * phrases + gold sources (scorecard/SCORECARD.md). No model, no route.
 *
 * GATE: hit@3 = 5/5 and hit@1 ≥ 4/5, including deployments/environments
 * for the preview phrase — the page lexical search never found.
 */
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

console.log(`\nGATE: hit@1 ${hit1}/5 (need ≥4) · hit@3 ${hit3}/5 (need 5)`);
if (hit3 < 5 || hit1 < 4) {
  console.error("✗ GATE FAILED — do not proceed to P004");
  process.exit(1);
}
console.log("✓ gate passed");

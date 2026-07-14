/**
 * KB-manifest build. Run from web/ AFTER build:docs-cache (it reads the
 * cached vercel-kb pages; there is no crawl step here). Needs gateway auth
 * for the enrichment pass:
 *
 *   pnpm build:kb-manifest
 *
 * Enriches every cached KB guide into the fine print an SA needs on a
 * call — value, trade-offs, limitations, comparisons vs alternatives —
 * one cheap structured-output call per guide, reused across runs while
 * the guide's content hash is unchanged.
 */
import { writeFile, readFile } from "fs/promises";
import { join } from "path";
import { createHash } from "crypto";
import { brotliDecompressSync } from "zlib";
import { generateObject } from "ai";
import { z } from "zod";
import { canonProducts } from "./product-canon.ts";
import type { KbGuide } from "../lib/kb-guides.ts";

const MANIFEST = join(process.cwd(), "kb-manifest.json");
const ENRICH_MODEL = "openai/gpt-5.4-mini";
const ENRICH_CONCURRENCY = 6;
/** bump when the prompt/schema/canonicalization changes — hash-cached
 *  entries from older versions re-enrich */
const ENRICH_VERSION = 1;

const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");

const GuideSchema = z.object({
  products: z
    .array(z.string())
    .describe("Vercel products/frameworks this guide is about, canonical names"),
  value: z
    .string()
    .describe(
      "What this capability delivers for the customer, one line ≤90 chars — " +
        "the reason an SA would bring it up",
    ),
  tradeoffs: z
    .array(z.string())
    .max(3)
    .describe(
      "Costs or compromises of this approach, one line each — empty if the " +
        "guide states none",
    ),
  limitations: z
    .array(z.string())
    .max(3)
    .describe(
      "Hard limits, unsupported cases, or plan constraints, one line each " +
        "with concrete numbers when the guide gives them — empty if none",
    ),
  comparisons: z
    .array(z.string())
    .max(3)
    .describe(
      "Explicit comparisons to non-Vercel alternatives the guide itself " +
        "makes, formatted 'vs <alternative>: <difference>' — empty if the " +
        "guide compares nothing",
    ),
});

const cache = JSON.parse(
  brotliDecompressSync(
    await readFile(join(process.cwd(), "docs-cache.br")),
  ).toString(),
) as Record<string, string>;
const pages = Object.entries(cache)
  .filter(([k]) => k.startsWith("vercel-kb:"))
  .map(([k, md]) => ({ path: k.slice(k.indexOf(":") + 1), md }))
  .sort((a, b) => a.path.localeCompare(b.path));
if (pages.length === 0) {
  throw new Error("no vercel-kb pages in docs-cache — run build:docs-cache first");
}
console.log(`${pages.length} KB guides in docs-cache`);

let previous = new Map<string, KbGuide>();
try {
  const old = JSON.parse(await readFile(MANIFEST, "utf8")) as KbGuide[];
  previous = new Map(old.map((e) => [e.path, e]));
} catch {
  // first run
}

const titleOf = (md: string) =>
  md.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? "";

let reused = 0;
let enriched = 0;
let failed = 0;
async function enrichOne(page: { path: string; md: string }): Promise<KbGuide | null> {
  const { path: p, md } = page;
  const hash = sha1(md);
  const prev = previous.get(p);
  if (prev && prev.hash === hash && prev.v === ENRICH_VERSION && prev.value) {
    reused++;
    // canon map fixes apply to reused entries too — no re-enrich needed
    return { ...prev, products: canonProducts(prev.products) };
  }
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const { object } = await generateObject({
        model: ENRICH_MODEL,
        schema: GuideSchema,
        prompt:
          "Extract the sales-call fine print from this Vercel Knowledge " +
          `Base guide (${p}). Only state trade-offs, limitations, and ` +
          "comparisons the guide itself makes — never infer your own.\n\n" +
          md.slice(0, 16000),
      });
      enriched++;
      return {
        path: p,
        title: titleOf(md),
        ...object,
        products: canonProducts(object.products),
        hash,
        v: ENRICH_VERSION,
      };
    } catch (err) {
      if (attempt === 2) {
        failed++;
        console.error(`  ✗ ${p} — enrichment failed: ${String(err).slice(0, 120)}`);
        // stale metadata beats a hole in the card; bare entry beats a miss
        return prev ?? {
          path: p,
          title: titleOf(md),
          products: [],
          value: "",
          tradeoffs: [],
          limitations: [],
          comparisons: [],
          hash,
          v: ENRICH_VERSION,
        };
      }
    }
  }
  return null;
}

console.log(`Enriching (${ENRICH_MODEL})…`);
const entries: KbGuide[] = [];
for (let i = 0; i < pages.length; i += ENRICH_CONCURRENCY) {
  const batch = pages.slice(i, i + ENRICH_CONCURRENCY);
  const results = await Promise.all(batch.map(enrichOne));
  for (const r of results) if (r) entries.push(r);
  if ((i / ENRICH_CONCURRENCY) % 10 === 0 || i + ENRICH_CONCURRENCY >= pages.length) {
    console.log(`  ${Math.min(i + ENRICH_CONCURRENCY, pages.length)}/${pages.length}`);
  }
}
entries.sort((a, b) => a.path.localeCompare(b.path));

await writeFile(MANIFEST, JSON.stringify(entries, null, 2) + "\n");
console.log(
  `\n✓ kb-manifest.json: ${entries.length} guides · ` +
    `${reused} reused · ${enriched} enriched · ${failed} failed`,
);

/**
 * Customers-manifest build. Run from web/ (needs gateway auth for the
 * enrichment pass):
 *
 *   pnpm build:customers-manifest
 *
 * Three stages:
 *   1. Crawl the vercel.com/blog/category/customers pagination — the
 *      category listing is the only source of "customers" membership.
 *   2. Backfill listed posts missing from docs-cache.br (the sitemap crawl
 *      misses some). A backfill changes chunk order — rebuild BOTH
 *      embedding indexes afterwards or the retriever refuses to load.
 *   3. Enrich every post into structured story metadata (customer,
 *      industry, vercelProducts, otherTech, outcome) — one cheap
 *      structured-output call per post, reused across runs while the
 *      post's content hash is unchanged.
 */
import { writeFile, readFile } from "fs/promises";
import { join } from "path";
import { createHash } from "crypto";
import { generateObject } from "ai";
import { z } from "zod";
import {
  fetchPageAsMarkdown,
  getCachedDoc,
  upsertPages,
} from "../lib/docs-cache.ts";
import type { CustomerStory } from "../lib/customers.ts";

const BASE = "https://vercel.com/blog/category/customers";
const MAX_PAGES = 30; // runaway guard — 9 pages as of 2026-07
const MANIFEST = join(process.cwd(), "customers-manifest.json");
const ENRICH_MODEL = "openai/gpt-5.4-mini";
const ENRICH_CONCURRENCY = 6;

const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");

// ---- 1. crawl category pagination -----------------------------------------

const found = new Set<string>();
for (let page = 1; page <= MAX_PAGES; page++) {
  const url = page === 1 ? BASE : `${BASE}/page/${page}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (res.status === 404) break; // one past the last page
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  const html = await res.text();
  const before = found.size;
  // relative + absolute hrefs; single path segment only, so category/nav
  // links never match
  for (const m of html.matchAll(
    /href="(?:https:\/\/vercel\.com)?(\/blog\/[^"/?#]+)"/g,
  )) {
    found.add(m[1]);
  }
  console.log(`page ${page}: +${found.size - before} posts (${found.size} total)`);
  await new Promise((r) => setTimeout(r, 300));
}
if (found.size === 0) throw new Error("no posts found — category markup changed?");
const paths = [...found].sort();
console.log(`\n✓ category crawl: ${paths.length} posts`);

// ---- 2. backfill posts the sitemap crawl missed ----------------------------

const fresh = new Map<string, string>();
const missing: string[] = [];
for (const p of paths) {
  if (!(await getCachedDoc(`vercel-blog:${p}`))) missing.push(p);
}
if (missing.length) {
  console.log(`\n${missing.length} posts missing from docs-cache — backfilling:`);
  for (const p of missing) {
    const md = await fetchPageAsMarkdown(`https://vercel.com${p}`);
    if (md) {
      fresh.set(`vercel-blog:${p}`, md);
      console.log(`  + ${p}`);
    } else {
      console.error(`  ✗ ${p} — fetch failed, retrieval will miss this post`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  await upsertPages(fresh);
  console.log(
    `✓ backfilled ${fresh.size}/${missing.length} — rebuild BOTH indexes:\n` +
      "  pnpm build:embeddings && pnpm build:embeddings-local",
  );
} else {
  console.log("✓ all posts already in docs-cache — no backfill, indexes stay valid");
}

// ---- 3. enrich — hash-cached structured extraction -------------------------

const StorySchema = z.object({
  customer: z
    .string()
    .describe("The featured company — the story's subject, never 'Vercel'"),
  industry: z
    .string()
    .describe(
      "1-3 words, e.g. 'Ecommerce', 'Fintech', 'Dev tools', 'Healthcare AI', 'Media'",
    ),
  vercelProducts: z
    .array(z.string())
    .describe(
      "Vercel products/frameworks shown in use, canonical names: v0, Sandbox, " +
        "AI SDK, AI Gateway, Fluid compute, Next.js, Turborepo, BotID, " +
        "Vercel Functions, Edge Middleware, ISR, Preview Deployments, " +
        "Workflow, Blob, Queues, Microfrontends",
    ),
  otherTech: z
    .array(z.string())
    .describe(
      "Non-Vercel products/tech named as part of their stack (Shopify, " +
        "Sitecore, Contentful, OpenAI, Sanity, …) — empty if none named",
    ),
  outcome: z
    .string()
    .describe(
      "One line, ≤90 chars, lead with the strongest metric, " +
        "e.g. '50% faster from demo request to code delivery'",
    ),
});

// legacy manifest was a plain string[] of paths — nothing reusable in it
let previous = new Map<string, CustomerStory>();
try {
  const old = JSON.parse(await readFile(MANIFEST, "utf8")) as
    | string[]
    | CustomerStory[];
  if (old.length && typeof old[0] === "object") {
    previous = new Map((old as CustomerStory[]).map((e) => [e.path, e]));
  }
} catch {
  // first run
}

let reused = 0;
let enriched = 0;
let failed = 0;
async function enrichOne(p: string): Promise<CustomerStory | null> {
  const md = fresh.get(`vercel-blog:${p}`) ?? (await getCachedDoc(`vercel-blog:${p}`));
  if (!md) {
    console.error(`  ✗ ${p} — not in cache, skipping`);
    return null;
  }
  const hash = sha1(md);
  const prev = previous.get(p);
  if (prev && prev.hash === hash && prev.customer) {
    reused++;
    return prev;
  }
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const { object } = await generateObject({
        model: ENRICH_MODEL,
        schema: StorySchema,
        prompt:
          "Extract structured metadata from this Vercel customer-story " +
          `blog post (${p}). Only name products the story actually shows ` +
          "in use.\n\n" +
          md.slice(0, 12000),
      });
      enriched++;
      return { path: p, ...object, hash };
    } catch (err) {
      if (attempt === 2) {
        failed++;
        console.error(`  ✗ ${p} — enrichment failed: ${String(err).slice(0, 120)}`);
        // stale metadata beats a hole in the card; bare entry beats a miss
        return prev ?? {
          path: p,
          customer: "",
          industry: "",
          vercelProducts: [],
          otherTech: [],
          outcome: "",
          hash,
        };
      }
    }
  }
  return null;
}

console.log(`\nEnriching ${paths.length} posts (${ENRICH_MODEL})…`);
const entries: CustomerStory[] = [];
for (let i = 0; i < paths.length; i += ENRICH_CONCURRENCY) {
  const batch = paths.slice(i, i + ENRICH_CONCURRENCY);
  const results = await Promise.all(batch.map(enrichOne));
  for (const r of results) if (r) entries.push(r);
  console.log(`  ${Math.min(i + ENRICH_CONCURRENCY, paths.length)}/${paths.length}`);
}
entries.sort((a, b) => a.path.localeCompare(b.path));

await writeFile(MANIFEST, JSON.stringify(entries, null, 2) + "\n");
console.log(
  `\n✓ customers-manifest.json: ${entries.length} stories · ` +
    `${reused} reused · ${enriched} enriched · ${failed} failed`,
);

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
import { chunkPage } from "../lib/chunker.ts";
import type { CustomerStory } from "../lib/customers.ts";

const BASE = "https://vercel.com/blog/category/customers";
const MAX_PAGES = 30; // runaway guard — 9 pages as of 2026-07
const MANIFEST = join(process.cwd(), "customers-manifest.json");
const ENRICH_MODEL = "openai/gpt-5.4-mini";
const ENRICH_CONCURRENCY = 6;
/** bump when the prompt/schema/canonicalization changes — hash-cached
 *  entries from older versions re-enrich */
const ENRICH_VERSION = 3;

/** the model free-texts product names ("Vercel Monitoring", "Content
 *  Delivery", "previews") — collapse to one canonical vocabulary so chips
 *  are consistent and the agent's VERCEL-list matching actually matches */
const PRODUCT_CANON: Record<string, string> = {
  "functions": "Vercel Functions",
  "serverless functions": "Vercel Functions",
  "edge functions": "Edge Functions",
  "middleware": "Edge Middleware",
  "edge middleware": "Edge Middleware",
  "routing middleware": "Edge Middleware",
  "preview deployments": "Preview Deployments",
  "previews": "Preview Deployments",
  "cdn": "CDN",
  "content delivery": "CDN",
  "edge network": "CDN",
  "web analytics": "Web Analytics",
  "analytics": "Web Analytics",
  "observability": "Observability",
  "monitoring": "Observability",
  "logs": "Observability",
  "log drains": "Observability",
  "speed insights": "Speed Insights",
  "feature flags": "Feature Flags",
  "flags": "Feature Flags",
  "firewall": "Firewall",
  "waf": "Firewall",
  "ddos mitigation": "Firewall",
  "bot management": "Firewall",
  "botid": "BotID",
  "isr": "ISR",
  "incremental static regeneration": "ISR",
  "fluid": "Fluid compute",
  "fluid compute": "Fluid compute",
  "ai sdk": "AI SDK",
  "ai gateway": "AI Gateway",
  "sandbox": "Sandbox",
  "blob": "Blob",
  "queues": "Queues",
  "edge config": "Edge Config",
  "cron": "Cron Jobs",
  "cron jobs": "Cron Jobs",
  "workflow": "Workflow",
  "workflows": "Workflow",
  "workflow sdk": "Workflow",
  "workflow devkit": "Workflow",
  "nextjs": "Next.js",
  "next.js": "Next.js",
  "toolbar": "Vercel Toolbar",
  "comments": "Vercel Toolbar",
  "for platforms": "Vercel for Platforms",
  "multi-tenant": "Vercel for Platforms",
  "domains": "Domains",
  "domains api": "Domains",
  "data cache": "Data Cache",
  "agent": "Vercel Agent",
};

function canonProducts(raw: string[]): string[] {
  const out: string[] = [];
  for (const r of raw) {
    const k = r.trim().toLowerCase().replace(/^vercel\s+/, "");
    // "Vercel" alone is the platform, not a product feature
    if (!k || k === "platform" || k === "vercel") continue;
    const c = PRODUCT_CANON[k] ?? r.trim();
    if (!out.includes(c)) out.push(c);
  }
  return out;
}

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
      "Vercel products/frameworks the story's PROSE shows in use — never " +
        "products that merely appear in nav/footer menus. Use EXACTLY these " +
        "names when applicable: v0, Sandbox, AI SDK, AI Gateway, " +
        "Fluid compute, Next.js, Turborepo, BotID, Firewall, Observability, " +
        "Web Analytics, Speed Insights, Vercel Functions, Edge Middleware, " +
        "ISR, Preview Deployments, Feature Flags, Edge Config, Cron Jobs, " +
        "Workflow, Blob, Queues, Microfrontends, Vercel for Platforms, " +
        "Domains, CDN, Vercel Toolbar, Instant Rollbacks",
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
  journey: z
    .object({
      before: z
        .string()
        .describe("Where they were: situation/stack/pain before Vercel, one sentence"),
      goal: z
        .string()
        .describe("Where they were going: the ambition or milestone they were driving toward, one sentence"),
      change: z
        .string()
        .describe("What needed to change: the specific blocker standing in the way, one sentence"),
      solution: z
        .string()
        .describe("How Vercel satisfied that need: name the products that removed the blocker, one sentence"),
    })
    .describe("The story as a four-beat arc an SA can retell"),
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
  if (prev && prev.hash === hash && prev.v === ENRICH_VERSION && prev.customer) {
    reused++;
    // canon map fixes apply to reused entries too — no re-enrich needed
    return { ...prev, vercelProducts: canonProducts(prev.vercelProducts) };
  }
  // the chunker's nav-noise filter strips the product mega-nav that tops
  // every cached blog page — raw markdown taught the model every product
  // "appears" in every story, and chrome ate the prompt budget
  const clean = chunkPage(`vercel-blog:${p}`, md)
    .map((c) => c.text)
    .join("\n\n");
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const { object } = await generateObject({
        model: ENRICH_MODEL,
        schema: StorySchema,
        prompt:
          "Extract structured metadata from this Vercel customer-story " +
          `blog post (${p}). Only name products the story actually shows ` +
          "in use.\n\n" +
          clean.slice(0, 16000),
      });
      enriched++;
      return {
        path: p,
        ...object,
        vercelProducts: canonProducts(object.vercelProducts),
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
          customer: "",
          industry: "",
          vercelProducts: [],
          otherTech: [],
          outcome: "",
          journey: { before: "", goal: "", change: "", solution: "" },
          hash,
          v: ENRICH_VERSION,
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

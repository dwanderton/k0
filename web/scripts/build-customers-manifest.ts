/**
 * Customers-manifest build. Run from web/:
 *
 *   pnpm build:customers-manifest
 *
 * Crawls the vercel.com/blog/category/customers pagination into
 * customers-manifest.json — the post pathnames customer-stories mode
 * retrieves from. The category listing is the only source of "customers"
 * membership: posts carry no category marker in their content or URL.
 *
 * Then backfills any listed post missing from docs-cache.br (the sitemap
 * crawl misses some). A backfill changes chunk order — rebuild BOTH
 * embedding indexes afterwards or the retriever refuses to load
 * (corpus-drift guard).
 */
import { writeFile } from "fs/promises";
import { join } from "path";
import {
  fetchPageAsMarkdown,
  getCachedDoc,
  upsertPages,
} from "../lib/docs-cache.ts";

const BASE = "https://vercel.com/blog/category/customers";
const MAX_PAGES = 30; // runaway guard — 9 pages as of 2026-07

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
await writeFile(
  join(process.cwd(), "customers-manifest.json"),
  JSON.stringify(paths, null, 2) + "\n",
);
console.log(`\n✓ customers-manifest.json: ${paths.length} posts`);

const missing: string[] = [];
for (const p of paths) {
  if (!(await getCachedDoc(`vercel-blog:${p}`))) missing.push(p);
}
if (missing.length === 0) {
  console.log("✓ all posts already in docs-cache — no backfill, indexes stay valid");
  process.exit(0);
}

console.log(`\n${missing.length} posts missing from docs-cache — backfilling:`);
const add = new Map<string, string>();
for (const p of missing) {
  const md = await fetchPageAsMarkdown(`https://vercel.com${p}`);
  if (md) {
    add.set(`vercel-blog:${p}`, md);
    console.log(`  + ${p}`);
  } else {
    console.error(`  ✗ ${p} — fetch failed, retrieval will miss this post`);
  }
  await new Promise((r) => setTimeout(r, 300));
}
await upsertPages(add);
console.log(
  `\n✓ backfilled ${add.size}/${missing.length} — now rebuild BOTH indexes:\n` +
    "  pnpm build:embeddings && pnpm build:embeddings-local",
);

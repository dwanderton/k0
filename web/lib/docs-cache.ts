/**
 * Documentation cache — sitemap-crawled markdown, brotli-compressed on disk.
 *
 * Build (ADDITIVE — `pnpm build:docs-cache` locally, no cron): crawl each
 * active source's sitemap, fetch every page as markdown (`<url>.md` twin
 * when the site serves one, HTML→md otherwise), merge into whatever the
 * cache already holds. A source with pages already cached is skipped
 * entirely; the cache checkpoints to disk after every source, and a source
 * that fails consistently is abandoned WITHOUT losing the pages fetched so
 * far. The .br file is committed to the repo — deploys never build it.
 *
 * Load: decompress once per warm instance. The agent's read_vercel_doc
 * checks this cache before hitting the network.
 */
import { writeFile, readFile } from "fs/promises";
import { join } from "path";
// Native brotli via node:zlib — same compress/decompress shape as the
// `brotli` npm package, no extra dependency.
import { brotliCompress, brotliDecompress } from "zlib";
import { promisify } from "util";
// html-to-md exports the converter as its default (no named `convert`).
import convert from "html-to-md";

const compress = promisify(brotliCompress);
const decompress = promisify(brotliDecompress);

const DOCUMENTATION_SOURCES = [
  {
    name: 'vercel-docs',
    baseUrl: 'https://vercel.com/docs',
    sitemapUrl: 'https://vercel.com/sitemap.xml',
  },
  {
    name: 'vercel-blog',
    baseUrl: 'https://vercel.com/blog',
    // /blog/sitemap.xml 404s — use the root sitemap; fetchSource keeps
    // only locs under baseUrl (same pattern as vercel-docs).
    sitemapUrl: 'https://vercel.com/sitemap.xml',
  },
  // {
  //   name: 'vercel-kb',
  //   baseUrl: 'https://vercel.com/kb',
  //   sitemapUrl: 'https://vercel.com/kb/sitemap.xml',
  // },
  // {
  //   name: 'vercel-changelog',
  //   baseUrl: 'https://vercel.com/changelog',
  //   sitemapUrl: 'https://vercel.com/changelog/sitemap.xml',
  // },
  {
    name: 'ai-sdk-docs',
    baseUrl: 'https://ai-sdk.dev/docs',
    sitemapUrl: 'https://ai-sdk.dev/sitemap.xml',
  },
  {
    name: 'chat-sdk-docs',
    baseUrl: 'https://chat-sdk.dev/docs',
    sitemapUrl: 'https://chat-sdk.dev/sitemap.xml',
  },
  {
    name: "workflows-docs",
    baseUrl: "https://workflow-sdk.dev/docs",
    sitemapUrl: "https://workflow-sdk.dev/sitemap.xml",
  },
  {
    name: "eve-docs",
    baseUrl: "https://eve.dev/docs",
    sitemapUrl: "https://eve.dev/sitemap.xml",
  },
  // {
  //   name: 'nextjs-docs',
  //   baseUrl: 'https://nextjs.org/docs',
  //   sitemapUrl: 'https://nextjs.org/sitemap.xml',
  // },
];

/** /tmp is the only writable path on Vercel; CWD is fine locally. */
const CACHE_FILE = process.env.VERCEL
  ? "/tmp/docs-cache.br"
  : join(process.cwd(), "docs-cache.br");

/** The cache file is COMMITTED for the demo so deploys never start
 *  cold: reads fall back to the repo-bundled copy when /tmp has no fresher
 *  rebuild. Traced into the function bundle via outputFileTracingIncludes. */
const BUNDLED_CACHE_FILE = join(process.cwd(), "docs-cache.br");

async function fetchSitemap(sitemapUrl: string): Promise<string[]> {
  try {
    const response = await fetch(sitemapUrl, {
      signal: AbortSignal.timeout(15000),
    });
    const xml = await response.text();
    const urls = xml.match(/<loc>(.*?)<\/loc>/g) || [];
    return urls.map((loc) => loc.replace(/<\/?loc>/g, ""));
  } catch (error) {
    console.error(`Failed to fetch sitemap ${sitemapUrl}:`, error);
    return [];
  }
}

/** Prefer the page's markdown twin (`<url>.md` — vercel.com and
 *  workflow-sdk.dev serve one); fall back to converting the raw HTML to
 *  markdown (eve.dev serves no twin). The converted page is sliced to its
 *  <main> element first so nav/footer chrome doesn't pollute the quotes. */
async function fetchPageAsMarkdown(url: string): Promise<string> {
  try {
    const md = await fetch(`${url}.md`, { signal: AbortSignal.timeout(15000) });
    if (md.ok) {
      const text = await md.text();
      if (!text.trimStart().startsWith("<!DOCTYPE")) return text;
    }
    const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) return "";
    const html = await response.text();
    const main = html.match(/<main[\s>][\s\S]*?<\/main>/i)?.[0] ?? html;
    const markdown = convert(main);
    return markdown;
  } catch (error) {
    console.error(`Failed to fetch ${url}:`, error);
    return "";
  }
}

/** Crawl one source's pages into `allPages`. Aborts after
 *  MAX_CONSECUTIVE_FAILURES page failures in a row (site down, rate-limited)
 *  — everything fetched up to that point stays in the map. */
async function fetchSource(
  source: (typeof DOCUMENTATION_SOURCES)[number],
  allPages: Map<string, string>,
): Promise<{ fetched: number; failed: number; aborted: boolean }> {
  const MAX_CONCURRENT = 5; // Max 5 parallel fetches
  const MAX_CONSECUTIVE_FAILURES = 20;

  // Root sitemaps carry the whole site — keep only this source's pages.
  const urls = (await fetchSitemap(source.sitemapUrl)).filter((u) =>
    u.startsWith(source.baseUrl),
  );
  console.log(`  Found ${urls.length} pages`);

  let fetched = 0;
  let failed = 0;
  let consecutive = 0;

  for (let i = 0; i < urls.length; i += MAX_CONCURRENT) {
    const batch = urls.slice(i, i + MAX_CONCURRENT);

    const results = await Promise.allSettled(
      batch.map((url) => fetchPageAsMarkdown(url)),
    );

    for (let j = 0; j < results.length; j++) {
      const result = results[j];
      if (result.status === "fulfilled" && result.value.length > 0) {
        const key = `${source.name}:${new URL(batch[j]).pathname}`;
        allPages.set(key, result.value);
        fetched++;
        consecutive = 0;
      } else {
        failed++;
        consecutive++;
      }
    }

    if (consecutive >= MAX_CONSECUTIVE_FAILURES) {
      console.error(
        `  ✗ ${source.name}: ${consecutive} consecutive failures — aborting source, keeping ${fetched} pages`,
      );
      return { fetched, failed, aborted: true };
    }

    // Wait between batches
    if (i + MAX_CONCURRENT < urls.length) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  return { fetched, failed, aborted: false };
}

async function saveCache(allPages: Map<string, string>): Promise<void> {
  const json = JSON.stringify(Object.fromEntries(allPages));
  const compressed = await compress(Buffer.from(json));
  await writeFile(CACHE_FILE, compressed);
  console.log(
    `  ✓ checkpoint: ${allPages.size} pages, ${(compressed.length / 1024).toFixed(0)}K on disk`,
  );
}

/** ADDITIVE build: start from whatever the cache already holds, skip any
 *  source that's already present, checkpoint to disk after every source.
 *  A consistently-failing source is abandoned without losing prior work. */
export async function buildAndSaveCache(): Promise<void> {
  console.log("Building documentation cache (additive)...");
  const startTime = Date.now();
  const DELAY_BETWEEN_SOURCES = 1000; // 1 second between source starts

  const allPages = await loadCache();
  console.log(`Starting from ${allPages.size} cached pages`);

  for (const source of DOCUMENTATION_SOURCES) {
    const already = [...allPages.keys()].some((k) =>
      k.startsWith(`${source.name}:`),
    );
    if (already) {
      console.log(`\n${source.name}: already cached — skipping`);
      continue;
    }

    console.log(`\nFetching ${source.name}...`);
    const { fetched, failed, aborted } = await fetchSource(source, allPages);
    console.log(
      `  ${source.name}: +${fetched} pages, ${failed} failed${aborted ? " (aborted early)" : ""}`,
    );

    // Checkpoint after every source — a later source dying costs nothing.
    await saveCache(allPages);

    // Wait between sources
    await new Promise((resolve) => setTimeout(resolve, DELAY_BETWEEN_SOURCES));
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n✓ Cache complete: ${allPages.size} pages in ${elapsed}s`);
}

async function loadCache(): Promise<Map<string, string>> {
  console.log("Loading documentation cache...");
  const startTime = Date.now();

  // Freshest first: a cron rebuild lands in CACHE_FILE (/tmp on Vercel);
  // otherwise the repo-committed copy shipped with the deploy.
  for (const file of [CACHE_FILE, BUNDLED_CACHE_FILE]) {
    try {
      const compressed = await readFile(file);
      const decompressed = await decompress(compressed);
      const json = JSON.parse(decompressed.toString()) as Record<
        string,
        string
      >;
      const cache = new Map(Object.entries(json));

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(3);
      console.log(`✓ Cache loaded: ${cache.size} pages in ${elapsed}s (${file})`);

      return cache;
    } catch {
      // try the next location
    }
  }

  // No cache anywhere. NEVER auto-crawl inside a serverless request path —
  // that's minutes of fetching on someone's live call. The cron endpoint
  // owns rebuilds; until one runs, lookups just miss and the agent falls
  // back to fetching pages directly.
  console.warn("No docs cache on disk — lookups miss until a rebuild runs.");
  return new Map();
}

// On startup
let docsCache: Map<string, string> | null = null;
let loading: Promise<Map<string, string>> | null = null;

export async function initializeCache(): Promise<void> {
  loading ??= loadCache();
  docsCache = await loading;
}

// Lookup function
export function getDocumentation(key: string): string | null {
  return docsCache?.get(key) ?? null;
}

/** Lazy one-liner for request paths: ensure loaded, then look up. */
export async function getCachedDoc(key: string): Promise<string | null> {
  if (!docsCache) await initializeCache();
  return getDocumentation(key);
}

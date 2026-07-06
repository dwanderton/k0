/**
 * Sitemap-crawled markdown docs cache, brotli on disk. Build is ADDITIVE
 * (`pnpm build:docs-cache`, local, no cron): cached sources skipped,
 * checkpoint after every source, a consistently-failing source abandoned
 * WITHOUT losing fetched pages. The .br is committed — deploys never build
 * it. Load: decompress once per warm instance.
 */
import { writeFile, readFile } from "fs/promises";
import { join } from "path";
// node:zlib brotli — same shape as the `brotli` npm package, no extra dep
import { brotliCompress, brotliDecompress } from "zlib";
import { promisify } from "util";
// html-to-md exports the converter as default — no named `convert`
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
    sitemapUrl: 'https://vercel.com/sitemap.xml',
  },
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
  {
    name: "nextjs-docs",
    baseUrl: "https://nextjs.org/docs",
    sitemapUrl: "https://nextjs.org/sitemap.xml",
  },
];

/** /tmp is the only writable path on Vercel; CWD is fine locally. */
const CACHE_FILE = process.env.VERCEL
  ? "/tmp/docs-cache.br"
  : join(process.cwd(), "docs-cache.br");

/** committed copy — fallback when /tmp has no fresher rebuild; traced into
 *  the function bundle via outputFileTracingIncludes */
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

/** Prefer the `<url>.md` twin (vercel.com, workflow-sdk.dev); else HTML→md
 *  (eve.dev has no twin), sliced to <main> so nav/footer chrome doesn't
 *  pollute quotes. */
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

/** Aborts after MAX_CONSECUTIVE_FAILURES in a row (site down, rate-limited)
 *  — everything fetched up to that point stays in the map. */
async function fetchSource(
  source: (typeof DOCUMENTATION_SOURCES)[number],
  allPages: Map<string, string>,
): Promise<{ fetched: number; failed: number; aborted: boolean }> {
  const MAX_CONCURRENT = 5;
  const MAX_CONSECUTIVE_FAILURES = 20;

  // root sitemaps carry the whole site — keep only this source's pages
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

export async function buildAndSaveCache(
  opts: { refresh?: boolean } = {},
): Promise<void> {
  const { refresh = false } = opts;
  console.log(`Building documentation cache (${refresh ? "refresh" : "additive"})...`);
  const startTime = Date.now();
  const DELAY_BETWEEN_SOURCES = 1000;

  const allPages = await loadCache();
  console.log(`Starting from ${allPages.size} cached pages`);

  for (const source of DOCUMENTATION_SOURCES) {
    const already = [...allPages.keys()].some((k) =>
      k.startsWith(`${source.name}:`),
    );
    if (already && !refresh) {
      console.log(`\n${source.name}: already cached — skipping`);
      continue;
    }

    console.log(`\nFetching ${source.name}...`);
    // refresh re-crawls into a fresh map: on success the source's pages are
    // REPLACED wholesale (dead pages drop out); an aborted crawl keeps the
    // old pages — a flaky site never nukes its corpus
    const target = refresh ? new Map<string, string>() : allPages;
    const { fetched, failed, aborted } = await fetchSource(source, target);
    console.log(
      `  ${source.name}: +${fetched} pages, ${failed} failed${aborted ? " (aborted early)" : ""}`,
    );
    if (refresh) {
      const prevCount = [...allPages.keys()].filter((k) =>
        k.startsWith(`${source.name}:`),
      ).length;
      // replace only when the fresh crawl looks healthy: a few stragglers
      // are normal, but a partial crawl (sitemap glitch, mid-run outage)
      // must never nuke a section, and a too-strict failed>0 rule would
      // silently freeze refresh forever on one flaky page
      const healthy =
        !aborted &&
        fetched > 0 &&
        failed <= Math.max(3, Math.ceil(fetched * 0.05)) &&
        fetched >= Math.floor(prevCount * 0.8);
      if (!healthy) {
        console.log(
          `  ${source.name}: crawl unhealthy (${fetched} fetched, ${failed} failed, had ${prevCount}) — keeping previous pages`,
        );
      } else {
        for (const k of [...allPages.keys()]) {
          if (k.startsWith(`${source.name}:`)) allPages.delete(k);
        }
        for (const [k, v] of target) allPages.set(k, v);
      }
    }

    // checkpoint after every source — a later source dying costs nothing
    await saveCache(allPages);

    await new Promise((resolve) => setTimeout(resolve, DELAY_BETWEEN_SOURCES));
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n✓ Cache complete: ${allPages.size} pages in ${elapsed}s`);
}

async function loadCache(): Promise<Map<string, string>> {
  console.log("Loading documentation cache...");
  const startTime = Date.now();

  // freshest first: /tmp rebuild, else the repo-committed copy
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

  // NEVER auto-crawl in a request path — minutes of fetching on someone's
  // live call. Until a rebuild runs, lookups miss and the agent fetches
  // pages directly.
  console.warn("No docs cache on disk — lookups miss until a rebuild runs.");
  return new Map();
}

let docsCache: Map<string, string> | null = null;
let loading: Promise<Map<string, string>> | null = null;

export async function initializeCache(): Promise<void> {
  loading ??= loadCache();
  docsCache = await loading;
}

export function getDocumentation(key: string): string | null {
  return docsCache?.get(key) ?? null;
}

export async function getCachedDoc(key: string): Promise<string | null> {
  if (!docsCache) await initializeCache();
  return getDocumentation(key);
}

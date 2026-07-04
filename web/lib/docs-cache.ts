/**
 * Documentation cache — sitemap-crawled markdown, brotli-compressed on disk.
 *
 * Build: crawl each active source's sitemap, fetch every page as markdown
 * (`<url>.md` twin when the site serves one, raw body otherwise), compress
 * the whole map to one .br file. Load: decompress once per warm instance.
 * The agent's read_vercel_doc checks this cache before hitting the network.
 *
 * Serverless reality: the filesystem is read-only except /tmp, and /tmp is
 * per-instance — a cron rebuild warms ITS instance's disk, not the fleet's.
 * Good enough for local dev and single-instance previews; the durable move
 * (Vercel Blob / KV) is a follow-up.
 */
import { writeFile, readFile } from "fs/promises";
import { join } from "path";
// Native brotli via node:zlib — same compress/decompress shape as the
// `brotli` npm package, no extra dependency.
import { brotliCompress, brotliDecompress } from "zlib";
import { promisify } from "util";

const compress = promisify(brotliCompress);
const decompress = promisify(brotliDecompress);

const DOCUMENTATION_SOURCES = [
  // {
  //   name: 'vercel-docs',
  //   baseUrl: 'https://vercel.com/docs',
  //   sitemapUrl: 'https://vercel.com/docs/sitemap.xml',
  // },
  // {
  //   name: 'vercel-blog',
  //   baseUrl: 'https://vercel.com/blog',
  //   sitemapUrl: 'https://vercel.com/blog/sitemap.xml',
  // },
  // {
  //   name: 'vercel-kb',
  //   baseUrl: 'https://vercel.com/kb/guide',
  //   sitemapUrl: 'https://vercel.com/kb/sitemap.xml',
  // },
  // {
  //   name: 'vercel-changelog',
  //   baseUrl: 'https://vercel.com/changelog',
  //   sitemapUrl: 'https://vercel.com/changelog/sitemap.xml',
  // },
  // {
  //   name: 'ai-sdk-docs',
  //   baseUrl: 'https://ai-sdk.dev/docs',
  //   sitemapUrl: 'https://ai-sdk.dev/sitemap.xml',
  // },
  // {
  //   name: 'sdk-vercel-ai',
  //   baseUrl: 'https://sdk.vercel.ai/docs',
  //   sitemapUrl: 'https://sdk.vercel.ai/sitemap.xml',
  // },
  // {
  //   name: 'chat-sdk-docs',
  //   baseUrl: 'https://chat-sdk.dev/docs',
  //   sitemapUrl: 'https://chat-sdk.dev/sitemap.xml',
  // },
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

/** The cache file is COMMITTED for the demo (588K br) so deploys never start
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
 *  workflow-sdk.dev serve one); fall back to the raw body (eve.dev has no
 *  twin, so its pages cache as HTML — imperfect for quoting, still useful). */
async function fetchPageAsMarkdown(url: string): Promise<string> {
  try {
    const md = await fetch(`${url}.md`, { signal: AbortSignal.timeout(15000) });
    if (md.ok) {
      const text = await md.text();
      if (!text.trimStart().startsWith("<!DOCTYPE")) return text;
    }
    const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) return "";
    const markdown = await response.text();
    return markdown;
  } catch (error) {
    console.error(`Failed to fetch ${url}:`, error);
    return "";
  }
}

async function fetchAllDocs(): Promise<Map<string, string>> {
  const allPages = new Map<string, string>();
  let totalFetched = 0;
  let totalFailed = 0;

  const MAX_CONCURRENT = 5; // Max 5 parallel fetches
  const DELAY_BETWEEN_SOURCES = 1000; // 1 second between source starts

  for (const source of DOCUMENTATION_SOURCES) {
    console.log(`\nFetching ${source.name}...`);

    const urls = await fetchSitemap(source.sitemapUrl);
    console.log(`  Found ${urls.length} pages`);

    // Fetch with concurrency limit
    for (let i = 0; i < urls.length; i += MAX_CONCURRENT) {
      const batch = urls.slice(i, i + MAX_CONCURRENT);

      try {
        const results = await Promise.allSettled(
          batch.map((url) => fetchPageAsMarkdown(url)),
        );

        for (let j = 0; j < results.length; j++) {
          const result = results[j];
          if (result.status === "fulfilled" && result.value.length > 0) {
            const url = batch[j];
            const key = `${source.name}:${new URL(url).pathname}`;
            allPages.set(key, result.value);
            totalFetched++;
          } else {
            totalFailed++;
          }
        }
      } catch (error) {
        console.error(`  Batch failed:`, error);
        totalFailed += batch.length;
      }

      // Wait between batches
      if (i + MAX_CONCURRENT < urls.length) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }

    // Wait between sources
    await new Promise((resolve) => setTimeout(resolve, DELAY_BETWEEN_SOURCES));
  }

  console.log(`\n✓ Total fetched: ${totalFetched}, Failed: ${totalFailed}`);
  return allPages;
}

export async function buildAndSaveCache(): Promise<void> {
  console.log("Building documentation cache...");
  const startTime = Date.now();

  const allPages = await fetchAllDocs();

  // Serialize to JSON
  const json = JSON.stringify(Object.fromEntries(allPages));
  console.log(`\nJSON size: ${json.length / 1024 / 1024}MB`);

  // Compress
  const compressed = await compress(Buffer.from(json));
  const compressedSize = compressed.length / 1024 / 1024;
  const compressionRatio = (
    (1 - compressedSize / (json.length / 1024 / 1024)) *
    100
  ).toFixed(1);

  // Save to disk
  await writeFile(CACHE_FILE, compressed);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(
    `✓ Cache saved: ${compressedSize.toFixed(1)}MB (${compressionRatio}% compression)`,
  );
  console.log(`✓ Build time: ${elapsed}s`);
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

/** Map a cache key back to the live page URL, for SOURCE links. */
export function keyToUrl(key: string): string | null {
  const [source, pathname] = key.split(/:(.+)/);
  const origin = DOCUMENTATION_SOURCES.find((s) => s.name === source)?.baseUrl;
  if (!origin || !pathname) return null;
  return new URL(pathname, origin).toString();
}

/** Search the cached SDK docs (the sources MCP search can't see —
 *  workflow-sdk.dev, eve.dev). Scores pages by query-token hits, path
 *  matches weighted over body matches. Returns keys + a matching line. */
export async function searchCache(
  query: string,
  limit = 5,
): Promise<{ key: string; url: string | null; snippet: string }[]> {
  if (!docsCache) await initializeCache();
  const tokens = query.toLowerCase().split(/\W+/).filter((t) => t.length > 2);
  if (tokens.length === 0) return [];
  const scored: { key: string; score: number; snippet: string }[] = [];
  for (const [key, content] of docsCache!) {
    const keyLc = key.toLowerCase();
    const bodyLc = content.toLowerCase();
    let score = 0;
    for (const t of tokens) {
      if (keyLc.includes(t)) score += 5; // path hit ≫ body hit
      else if (bodyLc.includes(t)) score += 1;
    }
    if (score === 0) continue;
    // First line containing any token, as the snippet.
    const line =
      content
        .split("\n")
        .find((l) => tokens.some((t) => l.toLowerCase().includes(t)))
        ?.trim()
        .slice(0, 160) ?? "";
    scored.push({ key, score, snippet: line });
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ key, snippet }) => ({ key, url: keyToUrl(key), snippet }));
}

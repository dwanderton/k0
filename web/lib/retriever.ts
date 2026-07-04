/**
 * Local hybrid retriever — brute-force cosine over the committed embedding
 * index, plus a path/heading keyword boost. No vector DB: at ~18k rows an
 * exact scan is ~20ms with perfect recall; a DB would add a network RTT
 * larger than the whole search.
 *
 * Index + corpus load once per warm instance (same pattern as docs-cache).
 * The only network hop is embedding the query (~100–150ms via gateway).
 */
import { readFile } from "fs/promises";
import { join } from "path";
import { brotliDecompress } from "zlib";
import { promisify } from "util";
import { embedMany } from "ai";
import { chunkAll, type Chunk } from "./chunker.ts";

const decompress = promisify(brotliDecompress);

export interface Candidate {
  content: string;
  documentTitle: string;
  documentUri: string;
  chunkIndex: number;
  source: string;
  relevanceScore: number;
  questionDistance: number;
}

interface Meta {
  model: string;
  dims: number;
  rows: number;
  chunks: { key: string; idx: number; heading: string; title: string; hash: string }[];
}

/** Score floor — retrieval-level NONE. Tuned by scripts/eval-retriever.ts:
 *  small-talk controls peak ~0.38, weakest gold top-1 ≥ 0.66. */
const FLOOR = 0.45;
const PATH_BOOST = 0.1;
const HEADING_BOOST = 0.05;
/** Framework guides and blog posts restate concepts owned by concept pages
 *  (every framework page has a "Preview Deployments" section) — deprioritize
 *  them so the canonical page wins unless the query names them. */
const FRAMEWORK_PENALTY = 0.06;
const BLOG_PENALTY = 0.03;

const STOPWORDS = new Set([
  "the", "and", "for", "you", "your", "are", "how", "what", "which", "does",
  "can", "will", "with", "that", "this", "asking", "question", "know",
  "want", "wondering", "about", "work", "works", "use", "using",
]);

const ORIGINS: Record<string, string> = {
  "vercel-docs": "https://vercel.com",
  "vercel-blog": "https://vercel.com",
  "ai-sdk-docs": "https://ai-sdk.dev",
  "chat-sdk-docs": "https://chat-sdk.dev",
  "workflows-docs": "https://workflow-sdk.dev",
  "eve-docs": "https://eve.dev",
};

function keyToUri(key: string): string {
  const [source, pathname] = key.split(/:(.+)/);
  return `${ORIGINS[source] ?? "https://vercel.com"}${pathname}`;
}

let index: Promise<{ meta: Meta; matrix: Float32Array; texts: string[] }> | null = null;

function load() {
  index ??= (async () => {
    const dir = process.cwd();
    const [metaRaw, binRaw, cacheRaw] = await Promise.all([
      readFile(join(dir, "embeddings-meta.json.br")),
      readFile(join(dir, "embeddings.bin.br")),
      readFile(join(dir, "docs-cache.br")),
    ]);
    const meta: Meta = JSON.parse((await decompress(metaRaw)).toString());
    const matrix = new Float32Array((await decompress(binRaw)).buffer as ArrayBuffer);
    if (matrix.length !== meta.rows * meta.dims) {
      throw new Error(`index mismatch: bin ${matrix.length} != rows×dims`);
    }
    const cache = new Map<string, string>(
      Object.entries(JSON.parse((await decompress(cacheRaw)).toString())),
    );
    // Chunker is deterministic — row i of the matrix IS chunk i of chunkAll.
    const chunks: Chunk[] = chunkAll(cache);
    if (chunks.length !== meta.rows) {
      throw new Error(`corpus drift: ${chunks.length} chunks vs ${meta.rows} rows — rebuild embeddings`);
    }
    return { meta, matrix, texts: chunks.map((c) => c.text) };
  })().catch((err) => {
    index = null; // next call retries rather than caching the failure
    throw err;
  });
  return index;
}

const tokens = (s: string) =>
  s.toLowerCase().split(/\W+/).filter((t) => t.length > 2 && !STOPWORDS.has(t));

export async function retrieve(
  utterance: string,
  k = 3,
  embedTimeoutMs = 1500,
): Promise<Candidate[]> {
  // Index load is NOT under the timeout: the first request per instance
  // pays the one-time decompress (seconds); racing it misfires "retrieval
  // failed" on every cold start. Only the network hop gets the deadline.
  const { meta, matrix, texts } = await load();
  const { dims } = meta;

  const { embeddings } = await Promise.race([
    embedMany({ model: meta.model, values: [utterance] }),
    new Promise<never>((_, rej) =>
      setTimeout(() => rej(new Error(`embed timeout (${embedTimeoutMs}ms)`)), embedTimeoutMs),
    ),
  ]);
  const q = new Float32Array(embeddings[0]);
  let ss = 0;
  for (let d = 0; d < dims; d++) ss += q[d] * q[d];
  const inv = 1 / Math.sqrt(ss);
  for (let d = 0; d < dims; d++) q[d] *= inv;

  const qTokens = tokens(utterance);
  const scored: { i: number; rel: number; cos: number }[] = [];
  for (let i = 0; i < meta.rows; i++) {
    let dot = 0;
    const off = i * dims;
    for (let d = 0; d < dims; d++) dot += q[d] * matrix[off + d];
    const c = meta.chunks[i];
    // Boosts match the PATHNAME, never the full key — every key carries the
    // source prefix ("vercel-docs:…"), so matching the key makes the token
    // "vercel" hit everything.
    const pathname = c.key.slice(c.key.indexOf(":") + 1).toLowerCase();
    let pathHit = 0;
    let headingHit = 0;
    if (qTokens.length) {
      const headLc = c.heading.toLowerCase();
      let ph = 0;
      let hh = 0;
      for (const t of qTokens) {
        if (pathname.includes(t)) ph++;
        if (headLc.includes(t)) hh++;
      }
      pathHit = ph / qTokens.length;
      headingHit = hh / qTokens.length;
    }
    let rel = dot + PATH_BOOST * pathHit + HEADING_BOOST * headingHit;
    // Penalty lifts only when the query names the framework itself.
    const fw = pathname.split("/frameworks/")[1];
    if (fw !== undefined && !qTokens.some((t) => fw.includes(t))) {
      rel -= FRAMEWORK_PENALTY;
    }
    if (c.key.startsWith("vercel-blog:")) rel -= BLOG_PENALTY;
    scored.push({ i, rel, cos: dot });
  }
  scored.sort((a, b) => b.rel - a.rel);

  // Top-k PAGES (best chunk per page), not top-k chunks of one page.
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const s of scored) {
    if (s.rel < FLOOR) break;
    const c = meta.chunks[s.i];
    if (seen.has(c.key)) continue;
    seen.add(c.key);
    out.push({
      content: texts[s.i],
      documentTitle: c.title || c.key.split("/").pop() || c.key,
      documentUri: keyToUri(c.key),
      chunkIndex: c.idx,
      source: c.key.split(":")[0],
      relevanceScore: +s.rel.toFixed(4),
      questionDistance: +(1 - s.cos).toFixed(4),
    });
    if (out.length >= k) break;
  }
  return out;
}

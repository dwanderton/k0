/**
 * Local hybrid retriever — brute-force cosine over a committed embedding
 * index, plus a path/heading keyword boost. No vector DB: at ~16k rows an
 * exact scan is ~10–25ms with perfect recall; a DB would add a network RTT
 * larger than the whole search.
 *
 * Two backends, tried in order:
 *   in-process — bge-small query embedding (~5ms, zero network) against
 *                embeddings-local.bin.br
 *   gateway    — text-embedding-3-small via the AI Gateway (~320ms hop)
 *                against embeddings.bin.br. The FALLBACK when the local
 *                model or its index can't load/execute.
 *
 * Indexes and corpus load once per warm instance (docs-cache pattern).
 */
import { readFile } from "fs/promises";
import { join } from "path";
import { brotliDecompress } from "zlib";
import { promisify } from "util";
import { embedMany } from "ai";
import { chunkAll, type Chunk } from "./chunker.ts";
import { embedLocal } from "./local-embedder.ts";

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

export type Backend = "in-process" | "gateway";

interface Meta {
  model: string;
  dims: number;
  rows: number;
  chunks: { key: string; idx: number; heading: string; title: string; hash: string }[];
}

interface Index {
  meta: Meta;
  matrix: Float32Array;
  texts: string[];
}

/** Per-model calibration — score DISTRIBUTIONS differ between embedding
 *  models (bge runs hot: controls peak ~0.56 where te3 controls peak ~0.38),
 *  so floors and penalties are empirical per backend, set by
 *  scripts/eval-retriever.ts control/gold separation. Boost weights are
 *  shared. rootBonus: concept queries belong to product ROOT pages; bge
 *  over-scores deep sub-pages, so roots get a nudge. */
const TUNING: Record<
  Backend,
  { floor: number; blogPenalty: number; rootBonus: number }
> = {
  gateway: { floor: 0.45, blogPenalty: 0.03, rootBonus: 0 },
  "in-process": {
    floor: 0.68,
    blogPenalty: 0.08,
    // Env override exists for offline A/B evals (RETRIEVER_ROOT_BONUS=0).
    rootBonus:
      process.env.RETRIEVER_ROOT_BONUS != null
        ? Number(process.env.RETRIEVER_ROOT_BONUS)
        : 0.03,
  },
};
const PATH_BOOST = 0.1;
const HEADING_BOOST = 0.05;
/** Framework guides restate concepts owned by concept pages (every framework
 *  page has a "Preview Deployments" section) — deprioritize them so the
 *  canonical page wins unless the query names them. */
const FRAMEWORK_PENALTY = 0.06;

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

const FILES: Record<Backend, { bin: string; meta: string }> = {
  "in-process": { bin: "embeddings-local.bin.br", meta: "embeddings-local-meta.json.br" },
  gateway: { bin: "embeddings.bin.br", meta: "embeddings-meta.json.br" },
};

let corpus: Promise<string[]> | null = null;
const indexes: Partial<Record<Backend, Promise<Index>>> = {};

function loadCorpusTexts() {
  corpus ??= (async () => {
    const cacheRaw = await readFile(join(process.cwd(), "docs-cache.br"));
    const cache = new Map<string, string>(
      Object.entries(JSON.parse((await decompress(cacheRaw)).toString())),
    );
    // Chunker is deterministic — row i of every index IS chunk i of chunkAll.
    return chunkAll(cache).map((c: Chunk) => c.text);
  })().catch((err) => {
    corpus = null;
    throw err;
  });
  return corpus;
}

function loadIndex(backend: Backend) {
  indexes[backend] ??= (async () => {
    const dir = process.cwd();
    const [metaRaw, binRaw, texts] = await Promise.all([
      readFile(join(dir, FILES[backend].meta)),
      readFile(join(dir, FILES[backend].bin)),
      loadCorpusTexts(),
    ]);
    const meta: Meta = JSON.parse((await decompress(metaRaw)).toString());
    const matrix = new Float32Array((await decompress(binRaw)).buffer as ArrayBuffer);
    if (matrix.length !== meta.rows * meta.dims) {
      throw new Error(`${backend} index mismatch: bin ${matrix.length} != rows×dims`);
    }
    if (texts.length !== meta.rows) {
      throw new Error(
        `corpus drift: ${texts.length} chunks vs ${meta.rows} rows — rebuild ${backend} embeddings`,
      );
    }
    return { meta, matrix, texts };
  })().catch((err) => {
    indexes[backend] = undefined; // next call retries
    throw err;
  });
  return indexes[backend]!;
}

const tokens = (s: string) =>
  s.toLowerCase().split(/\W+/).filter((t) => t.length > 2 && !STOPWORDS.has(t));

async function embedQuery(
  backend: Backend,
  utterance: string,
  model: string,
  timeoutMs: number,
): Promise<Float32Array> {
  if (backend === "in-process") {
    const [v] = await embedLocal([utterance], { isQuery: true });
    return v; // already unit-normalized by the pipeline
  }
  const { embeddings } = await Promise.race([
    embedMany({ model, values: [utterance] }),
    new Promise<never>((_, rej) =>
      setTimeout(() => rej(new Error(`embed timeout (${timeoutMs}ms)`)), timeoutMs),
    ),
  ]);
  const q = new Float32Array(embeddings[0]);
  let ss = 0;
  for (let d = 0; d < q.length; d++) ss += q[d] * q[d];
  const inv = 1 / Math.sqrt(ss);
  for (let d = 0; d < q.length; d++) q[d] *= inv;
  return q;
}

function scan(
  index: Index,
  q: Float32Array,
  utterance: string,
  k: number,
  tuning: { floor: number; blogPenalty: number; rootBonus: number },
) {
  const { meta, matrix, texts } = index;
  const { dims } = meta;
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
    if (c.key.startsWith("vercel-blog:")) rel -= tuning.blogPenalty;
    // Product-root pages (/docs/<product>) carry the concept answers.
    if (/^\/docs\/[^/]+$/.test(pathname)) rel += tuning.rootBonus;
    scored.push({ i, rel, cos: dot });
  }
  scored.sort((a, b) => b.rel - a.rel);

  // Top-k PAGES (best chunk per page), not top-k chunks of one page.
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const s of scored) {
    if (s.rel < tuning.floor) break;
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

export interface RetrievalResult {
  candidates: Candidate[];
  backend: Backend;
}

/** Force a backend (evals); default order is in-process → gateway. */
const FORCED = process.env.RETRIEVER_BACKEND as Backend | undefined;

export async function retrieveWithInfo(
  utterance: string,
  k = 3,
  embedTimeoutMs = 1500,
): Promise<RetrievalResult> {
  const order: Backend[] = FORCED
    ? [FORCED]
    : ["in-process", "gateway"];
  let lastErr: unknown;
  for (const backend of order) {
    try {
      // Index load is NOT under the timeout: the first request per instance
      // pays the one-time decompress; racing it misfires the fallback on
      // every cold start. Only the gateway network hop gets the deadline.
      const index = await loadIndex(backend);
      const q = await embedQuery(backend, utterance, index.meta.model, embedTimeoutMs);
      return {
        candidates: scan(index, q, utterance, k, TUNING[backend]),
        backend,
      };
    } catch (err) {
      lastErr = err;
      console.error(`retriever backend ${backend} failed:`, err);
    }
  }
  throw lastErr;
}

export async function retrieve(
  utterance: string,
  k = 3,
  embedTimeoutMs = 1500,
): Promise<Candidate[]> {
  return (await retrieveWithInfo(utterance, k, embedTimeoutMs)).candidates;
}

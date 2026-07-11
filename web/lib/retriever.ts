/**
 * Local hybrid retriever — brute-force cosine over a committed index +
 * path/heading keyword boost. No vector DB: ~16k rows scan in ~10–25ms with
 * perfect recall; a DB adds a network RTT larger than the whole search.
 * Backends in order: in-process bge-small (~5ms, zero network) → gateway
 * text-embedding-3-small (~320ms hop) as fallback. Indexes and corpus load
 * once per warm instance.
 */
// fs + the ONNX chain must never reach a client bundle — poison client imports at build time
import "server-only";
import { readFile } from "fs/promises";
import { join } from "path";
import { brotliDecompress } from "zlib";
import { promisify } from "util";
import { embedMany } from "ai";
import { chunkAll, type Chunk } from "./chunker.ts";
import { embedLocal } from "./local-embedder.ts";
import { loadCustomerStories } from "./customers.ts";
import type { KbMode } from "./call-shared.ts";

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
  quant?: "int8"; // absent = float32 bin
  chunks: { key: string; idx: number; heading: string; title: string; hash: string }[];
}

interface Index {
  meta: Meta;
  matrix: Float32Array;
  texts: string[];
}

/** Per-model calibration — score distributions differ (bge runs hot:
 *  controls peak ~0.56 vs te3 ~0.38); floors/penalties set empirically by
 *  scripts/eval-retriever.ts control/gold separation. Boost weights shared.
 *  customersFloor is 0: proof points always surface, k of them, whatever
 *  the confidence — the agent prompt gates NONE, and scores still ride
 *  the stories frame so weakness is visible, not hidden. */
const TUNING: Record<
  Backend,
  { floor: number; blogPenalty: number; customersFloor: number }
> = {
  gateway: { floor: 0.45, blogPenalty: 0.03, customersFloor: 0 },
  "in-process": { floor: 0.68, blogPenalty: 0.08, customersFloor: 0 },
};
const PATH_BOOST = 0.1;
const HEADING_BOOST = 0.05;
/** Scoped sections restate concepts owned by canonical pages (every
 *  framework guide has a "Preview Deployments" section) — deprioritize
 *  unless the query names the section. */
const SCOPED_SECTIONS = ["/docs/frameworks/", "/docs/platforms/"];
const SCOPED_PENALTY = 0.06;

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
  "nextjs-docs": "https://nextjs.org",
};

function keyToUri(key: string): string {
  const [source, pathname] = key.split(/:(.+)/);
  return `${ORIGINS[source] ?? "https://vercel.com"}${pathname}`;
}

// local bin is RAW float32 — brotli shaves ~10% off float vectors but cost
// ~300ms decompress on every cold start; text/meta stay compressed
const FILES: Record<Backend, { bin: string; meta: string }> = {
  "in-process": { bin: "embeddings-local.bin", meta: "embeddings-local-meta.json.br" },
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
    // chunker is deterministic — row i of every index IS chunk i of chunkAll
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
    const binBuf = FILES[backend].bin.endsWith(".br")
      ? await decompress(binRaw)
      : binRaw;
    const bin = binBuf.buffer.slice(
      binBuf.byteOffset,
      binBuf.byteOffset + binBuf.byteLength,
    );
    let matrix: Float32Array;
    if (meta.quant === "int8") {
      // int8 bin (P002 size gate) — dequant + renorm fused: q/√Σq² equals
      // the renormalized q/127, and integer math keeps cold load ~100ms
      // where a Float32Array.from callback cost ~1.5s
      const q = new Int8Array(bin);
      matrix = new Float32Array(q.length);
      for (let r = 0; r < meta.rows; r++) {
        const off = r * meta.dims;
        let ss = 0;
        for (let d = 0; d < meta.dims; d++) ss += q[off + d] * q[off + d];
        const inv = ss > 0 ? 1 / Math.sqrt(ss) : 0;
        for (let d = 0; d < meta.dims; d++) matrix[off + d] = q[off + d] * inv;
      }
    } else {
      matrix = new Float32Array(bin);
    }
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

/** product names shorter than the length filter — a mention of "v0" must
 *  still hit path/heading boosts */
const SHORT_PRODUCTS = new Set(["v0"]);

const tokens = (s: string) =>
  s
    .toLowerCase()
    .split(/\W+/)
    .filter(
      (t) => (t.length > 2 || SHORT_PRODUCTS.has(t)) && !STOPWORDS.has(t),
    );

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
  tuning: { floor: number; blogPenalty: number },
  allow: Set<string> | null,
) {
  const { meta, matrix, texts } = index;
  const { dims } = meta;
  const qTokens = tokens(utterance);
  const scored: { i: number; rel: number; cos: number }[] = [];
  for (let i = 0; i < meta.rows; i++) {
    const c = meta.chunks[i];
    if (allow && !allow.has(c.key)) continue;
    let dot = 0;
    const off = i * dims;
    for (let d = 0; d < dims; d++) dot += q[d] * matrix[off + d];
    // boosts match the PATHNAME, never the key — the key's source prefix
    // ("vercel-docs:…") makes the token "vercel" hit everything
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
    // penalty lifts only when the query names the scoped section itself
    for (const section of SCOPED_SECTIONS) {
      const rest = pathname.split(section)[1];
      if (rest === undefined) continue;
      const sectionName = section.split("/")[2]; // "frameworks" | "platforms"
      // exemption tests section IDENTITY (name + product/framework segments),
      // never the leaf slug — a slug echoing the query self-exempts
      // (add-custom-domain did)
      const identity = rest.split("/").slice(0, 2);
      const named = qTokens.some(
        (t) => sectionName.includes(t) || identity.some((seg) => seg.includes(t)),
      );
      if (!named) rel -= SCOPED_PENALTY;
      break;
    }
    // no blog penalty under an allow-list — the whole scope IS blog posts
    if (!allow && c.key.startsWith("vercel-blog:")) rel -= tuning.blogPenalty;
    scored.push({ i, rel, cos: dot });
  }
  scored.sort((a, b) => b.rel - a.rel);

  // top-k PAGES (best chunk per page), not top-k chunks of one page
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
  /** set when THIS request paid one-time init — trace tags cold starts so
   *  metrics split them from warm-path timing */
  coldInitMs?: number;
}

/** Force a backend (evals); default order is in-process → gateway. */
const FORCED = process.env.RETRIEVER_BACKEND as Backend | undefined;

export async function retrieveWithInfo(
  utterance: string,
  k = 3,
  embedTimeoutMs = 1500,
  mode: KbMode = "all",
): Promise<RetrievalResult> {
  const order: Backend[] = FORCED
    ? [FORCED]
    : ["in-process", "gateway"];
  // missing manifest throws — a silent fall-open to the full KB would break
  // the mode's promise without anyone noticing
  const allow =
    mode === "customers"
      ? new Set((await loadCustomerStories()).keys())
      : null;
  let lastErr: unknown;
  for (const backend of order) {
    try {
      // cold = this request creates the index promise; the in-process model
      // loads inside the first embed, so timing the pair captures full init
      const cold = indexes[backend] === undefined;
      const t0 = cold ? performance.now() : 0;
      // index load NOT under the timeout — first request pays the one-time
      // decompress; racing it misfires the fallback on every cold start.
      // Only the gateway network hop gets the deadline.
      const index = await loadIndex(backend);
      const q = await embedQuery(backend, utterance, index.meta.model, embedTimeoutMs);
      const t = TUNING[backend];
      const tuning = allow ? { ...t, floor: t.customersFloor } : t;
      const result: RetrievalResult = {
        candidates: scan(index, q, utterance, k, tuning, allow),
        backend,
      };
      if (cold) result.coldInitMs = Math.round(performance.now() - t0);
      return result;
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
  mode: KbMode = "all",
): Promise<Candidate[]> {
  return (await retrieveWithInfo(utterance, k, embedTimeoutMs, mode)).candidates;
}

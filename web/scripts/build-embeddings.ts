/**
 * P002 — build the committed embedding index from docs-cache.br.
 *
 * ADDITIVE: rows align to the current chunk order; a chunk whose text hash
 * already exists in the old meta reuses its old vector (handles deletions
 * and reorders too — the index is rebuilt row-aligned every run, only NEW
 * text hits the API). Run: pnpm build:embeddings
 *
 * Output (committed, shipped with deploys):
 *   web/embeddings.bin.br       brotli'd Float32Array, row i = chunk i,
 *                               unit-normalized at build time
 *   web/embeddings-meta.json.br {model, dims, rows, usage, costUSD, chunks[]}
 *
 * Cost rides in the meta (cumulative across additive runs) — SCORECARD.md
 * records it per the eval discipline.
 */
import { readFile, writeFile } from "fs/promises";
import { brotliCompressSync, brotliDecompressSync } from "zlib";
import { createHash } from "crypto";
import { embedMany } from "ai";
import { chunkAll, type Chunk } from "../lib/chunker.ts";

const MODEL = "openai/text-embedding-3-small";
const DIMS = 1536;
const PRICE_PER_TOKEN = 0.00000002; // gateway-listed 2026-07-04
const BATCH = 512;

const root = new URL("..", import.meta.url);
const binPath = new URL("embeddings.bin.br", root);
const metaPath = new URL("embeddings-meta.json.br", root);

interface Meta {
  model: string;
  dims: number;
  rows: number;
  usageTokens: number;
  costUSD: number;
  chunks: { key: string; idx: number; heading: string; title: string; hash: string }[];
}

const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");

const cache = new Map<string, string>(
  Object.entries(
    JSON.parse(brotliDecompressSync(await readFile(new URL("docs-cache.br", root))).toString()),
  ),
);
const chunks: Chunk[] = chunkAll(cache);
console.log(`chunks: ${chunks.length}`);

// Old index → hash-keyed vector lookup for reuse.
let oldVectors = new Map<string, Float32Array>();
let priorTokens = 0;
let priorCost = 0;
try {
  const oldMeta: Meta = JSON.parse(brotliDecompressSync(await readFile(metaPath)).toString());
  const oldBin = new Float32Array(
    brotliDecompressSync(await readFile(binPath)).buffer as ArrayBuffer,
  );
  if (oldMeta.model === MODEL && oldMeta.dims === DIMS) {
    oldMeta.chunks.forEach((c, i) => {
      oldVectors.set(c.hash, oldBin.subarray(i * DIMS, (i + 1) * DIMS));
    });
    priorTokens = oldMeta.usageTokens ?? 0;
    priorCost = oldMeta.costUSD ?? 0;
    console.log(`reusing up to ${oldVectors.size} existing vectors`);
  }
} catch {
  console.log("no existing index — full build");
}

const hashes = chunks.map((c) => sha1(c.text));
const missing = chunks.filter((_, i) => !oldVectors.has(hashes[i]));
console.log(`to embed: ${missing.length} new chunks`);

const embedded = new Map<string, Float32Array>();
let newTokens = 0;
for (let i = 0; i < missing.length; i += BATCH) {
  const batch = missing.slice(i, i + BATCH);
  const { embeddings, usage } = await embedMany({
    model: MODEL,
    values: batch.map((c) => c.text),
    maxParallelCalls: 2,
  });
  newTokens += usage?.tokens ?? 0;
  embeddings.forEach((e, j) => {
    const v = new Float32Array(e);
    let ss = 0;
    for (let d = 0; d < DIMS; d++) ss += v[d] * v[d];
    const inv = 1 / Math.sqrt(ss);
    for (let d = 0; d < DIMS; d++) v[d] *= inv;
    embedded.set(sha1(batch[j].text), v);
  });
  console.log(
    `  embedded ${Math.min(i + BATCH, missing.length)}/${missing.length} (tokens so far: ${newTokens})`,
  );
}

const out = new Float32Array(chunks.length * DIMS);
chunks.forEach((_, i) => {
  const v = oldVectors.get(hashes[i]) ?? embedded.get(hashes[i]);
  if (!v || v.length !== DIMS) throw new Error(`missing vector for row ${i}`);
  out.set(v, i * DIMS);
});

const newCost = newTokens * PRICE_PER_TOKEN;
const meta: Meta = {
  model: MODEL,
  dims: DIMS,
  rows: chunks.length,
  usageTokens: priorTokens + newTokens,
  costUSD: +(priorCost + newCost).toFixed(4),
  chunks: chunks.map((c, i) => ({
    key: c.key,
    idx: c.idx,
    heading: c.heading,
    title: c.title,
    hash: hashes[i],
  })),
};

const rawBin = Buffer.from(out.buffer);
const binBr = brotliCompressSync(rawBin);
await writeFile(binPath, binBr);
await writeFile(metaPath, brotliCompressSync(Buffer.from(JSON.stringify(meta))));

const mb = (n: number) => (n / 1048576).toFixed(1) + "MB";
console.log(`rows: ${meta.rows} · raw ${mb(rawBin.length)} → br ${mb(binBr.length)}`);
console.log(
  `this run: ${newTokens} tokens ≈ $${newCost.toFixed(4)} · cumulative: ${meta.usageTokens} tokens ≈ $${meta.costUSD}`,
);
if (binBr.length > 90 * 1048576) {
  console.error("✗ SIZE GATE: .br > 90MB — int8 fallback required (P002)");
  process.exit(1);
}

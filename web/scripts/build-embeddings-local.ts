/**
 * Build the IN-PROCESS embedding index (separate files from the gateway
 * index — the two must never mix: different models, different dims).
 *
 *   web/embeddings-local.bin.br        brotli'd Float32Array, 384 dims
 *   web/embeddings-local-meta.json.br  same chunk table shape as gateway meta
 *
 * Additive by chunk hash like the gateway build. Cost: $0 — the model runs
 * locally. Run: pnpm build:embeddings-local
 */
import { readFile, writeFile } from "fs/promises";
import { brotliCompressSync, brotliDecompressSync } from "zlib";
import { createHash } from "crypto";
import { chunkAll, type Chunk } from "../lib/chunker.ts";
import { embedLocal, LOCAL_MODEL, LOCAL_DIMS } from "../lib/local-embedder.ts";

const BATCH = 64;
const root = new URL("..", import.meta.url);
const binPath = new URL("embeddings-local.bin.br", root);
const metaPath = new URL("embeddings-local-meta.json.br", root);

interface Meta {
  model: string;
  dims: number;
  rows: number;
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

let oldVectors = new Map<string, Float32Array>();
try {
  const oldMeta: Meta = JSON.parse(brotliDecompressSync(await readFile(metaPath)).toString());
  const oldBin = new Float32Array(
    brotliDecompressSync(await readFile(binPath)).buffer as ArrayBuffer,
  );
  if (oldMeta.model === LOCAL_MODEL && oldMeta.dims === LOCAL_DIMS) {
    oldMeta.chunks.forEach((c, i) => {
      oldVectors.set(c.hash, oldBin.subarray(i * LOCAL_DIMS, (i + 1) * LOCAL_DIMS));
    });
    console.log(`reusing up to ${oldVectors.size} existing vectors`);
  }
} catch {
  console.log("no existing local index — full build");
}

const hashes = chunks.map((c) => sha1(c.text));
const missing = chunks.filter((_, i) => !oldVectors.has(hashes[i]));
console.log(`to embed: ${missing.length} chunks (in-process, $0)`);

const embedded = new Map<string, Float32Array>();
const t0 = Date.now();
for (let i = 0; i < missing.length; i += BATCH) {
  const batch = missing.slice(i, i + BATCH);
  const vectors = await embedLocal(batch.map((c) => c.text));
  vectors.forEach((v, j) => embedded.set(sha1(batch[j].text), v));
  if ((i / BATCH) % 20 === 0 || i + BATCH >= missing.length) {
    console.log(`  embedded ${Math.min(i + BATCH, missing.length)}/${missing.length}`);
  }
}
console.log(`embedding time: ${((Date.now() - t0) / 1000).toFixed(1)}s`);

const out = new Float32Array(chunks.length * LOCAL_DIMS);
chunks.forEach((_, i) => {
  const v = oldVectors.get(hashes[i]) ?? embedded.get(hashes[i]);
  if (!v || v.length !== LOCAL_DIMS) throw new Error(`missing vector for row ${i}`);
  out.set(v, i * LOCAL_DIMS);
});

const meta: Meta = {
  model: LOCAL_MODEL,
  dims: LOCAL_DIMS,
  rows: chunks.length,
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

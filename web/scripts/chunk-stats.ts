/** P001 verification: chunk counts, length distribution, determinism hash. */
import { readFile } from "fs/promises";
import { brotliDecompressSync } from "zlib";
import { createHash } from "crypto";
import { chunkAll } from "../lib/chunker.ts";

const raw = await readFile(new URL("../docs-cache.br", import.meta.url));
const cache = new Map<string, string>(
  Object.entries(JSON.parse(brotliDecompressSync(raw).toString())),
);

const chunks = chunkAll(cache);
const bySource = new Map<string, number>();
const perPage = new Map<string, number>();
const lens: number[] = [];
for (const c of chunks) {
  const src = c.key.split(":")[0];
  bySource.set(src, (bySource.get(src) ?? 0) + 1);
  perPage.set(c.key, (perPage.get(c.key) ?? 0) + 1);
  lens.push(c.text.length);
}
lens.sort((a, b) => a - b);
const pageCounts = [...perPage.values()].sort((a, b) => a - b);
const pct = (arr: number[], p: number) => arr[Math.floor(arr.length * p)];

console.log("pages:", cache.size, "→ chunks:", chunks.length);
console.log("by source:", Object.fromEntries(bySource));
console.log(
  `chunks/page min=${pageCounts[0]} med=${pct(pageCounts, 0.5)} max=${pageCounts[pageCounts.length - 1]}`,
);
console.log(
  `chars/chunk p50=${pct(lens, 0.5)} p95=${pct(lens, 0.95)} max=${lens[lens.length - 1]}`,
);
const hash = createHash("sha1");
for (const c of chunks) hash.update(`${c.key}#${c.idx}\n${c.text}\n`);
console.log("determinism sha1:", hash.digest("hex"));

for (const i of [0, Math.floor(chunks.length / 2), chunks.length - 1]) {
  const c = chunks[i];
  console.log(`\n--- sample [${i}] ${c.key}#${c.idx} (${c.text.length} chars)`);
  console.log(c.text.slice(0, 200).replace(/\n/g, " ⏎ "));
}

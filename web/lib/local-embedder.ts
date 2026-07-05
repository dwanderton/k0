/**
 * In-process embedder — bge-small (384 dims, int8 ONNX) via transformers.js.
 * ~3ms local CPU vs the ~320ms gateway hop, after a one-time ~1.3s load per
 * warm instance. Model files VENDORED at web/models/, remote fetch disabled
 * — a deploy must never depend on the HF CDN at cold start.
 */
import { pipeline, env } from "@huggingface/transformers";
import { join } from "path";

export const LOCAL_MODEL = "Xenova/bge-small-en-v1.5";
export const LOCAL_DIMS = 384;

type FeatureExtractor = (
  texts: string | string[],
  opts: { pooling: "mean"; normalize: boolean },
) => Promise<{ data: Float32Array; dims: number[] }>;

let extractor: Promise<FeatureExtractor> | null = null;

function load() {
  extractor ??= (async () => {
    env.localModelPath = join(process.cwd(), "models");
    env.allowRemoteModels = false;
    return (await pipeline("feature-extraction", LOCAL_MODEL, {
      dtype: "q8",
    })) as unknown as FeatureExtractor;
  })().catch((err) => {
    extractor = null; // next call retries instead of caching the failure
    throw err;
  });
  return extractor;
}

/** BGE convention: queries carry the instruction prefix, passages don't —
 *  prefixing chunks too hurts ranking */
const QUERY_PREFIX =
  "Represent this sentence for searching relevant passages: ";

/** unit-normalized, one vector per input */
export async function embedLocal(
  texts: string[],
  opts: { isQuery?: boolean } = {},
): Promise<Float32Array[]> {
  const fe = await load();
  const inputs = opts.isQuery ? texts.map((t) => QUERY_PREFIX + t) : texts;
  const out = await fe(inputs, { pooling: "mean", normalize: true });
  const [rows, dims] = out.dims.length === 2 ? out.dims : [1, out.dims[0]];
  const vectors: Float32Array[] = [];
  for (let i = 0; i < rows; i++) {
    vectors.push(out.data.slice(i * dims, (i + 1) * dims));
  }
  return vectors;
}

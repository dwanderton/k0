import type { NextConfig } from "next";
import { withBotId } from "botid/next/config";

const nextConfig: NextConfig = {
  // pin root to web/ — a stray repo-root lockfile makes Turbopack infer the
  // wrong root and node_modules fails to resolve
  turbopack: {
    root: import.meta.dirname,
  },
  // committed caches must ship in the serverless bundles — tracing follows
  // imports, not runtime readFile paths
  outputFileTracingIncludes: {
    "/api/agent": [
      "./docs-cache.br",
      "./customers-manifest.json",
      "./kb-manifest.json",
      "./embeddings.bin.br",
      "./embeddings-meta.json.br",
      "./embeddings-local.bin",
      "./embeddings-local-meta.json.br",
      "./models/**",
      // onnxruntime-node's .node binding dlopens sibling libs nft can't
      // follow — CPU libs only (CUDA/TensorRT: hundreds of MB, unused)
      "./node_modules/.pnpm/onnxruntime-node@*/node_modules/onnxruntime-node/bin/napi-v6/linux/x64/libonnxruntime.so*",
      "./node_modules/.pnpm/onnxruntime-node@*/node_modules/onnxruntime-node/bin/napi-v6/linux/x64/libonnxruntime_providers_shared.so",
    ],
  },
};

export default withBotId(nextConfig);

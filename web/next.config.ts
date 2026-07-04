import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin the workspace root to web/. Without this, a stray repo-root lockfile
  // makes Turbopack infer the wrong root and node_modules fails to resolve.
  turbopack: {
    root: import.meta.dirname,
  },
  // The committed docs cache must ship inside the serverless bundles —
  // file tracing only follows imports, not runtime readFile paths.
  outputFileTracingIncludes: {
    "/api/agent": [
      "./docs-cache.br",
      "./embeddings.bin.br",
      "./embeddings-meta.json.br",
      "./embeddings-local.bin.br",
      "./embeddings-local-meta.json.br",
      "./models/**",
      // onnxruntime-node's traced .node binding dlopens sibling shared
      // libraries nft doesn't follow — include the CPU libs explicitly
      // (NOT the CUDA/TensorRT providers: hundreds of MB, unused on CPU).
      "./node_modules/.pnpm/onnxruntime-node@*/node_modules/onnxruntime-node/bin/napi-v6/linux/x64/libonnxruntime.so*",
      "./node_modules/.pnpm/onnxruntime-node@*/node_modules/onnxruntime-node/bin/napi-v6/linux/x64/libonnxruntime_providers_shared.so",
    ],
  },
};

export default nextConfig;

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
    ],
  },
};

export default nextConfig;

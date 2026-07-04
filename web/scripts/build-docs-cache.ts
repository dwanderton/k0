/**
 * Additive docs-cache build. Run from web/:
 *
 *   pnpm build:docs-cache
 *
 * Skips sources already in docs-cache.br, checkpoints after each source,
 * keeps partial progress when a source fails consistently. Commit the
 * refreshed docs-cache.br afterwards — deploys ship it, they never build it.
 */
import { buildAndSaveCache } from "../lib/docs-cache.ts";

await buildAndSaveCache();

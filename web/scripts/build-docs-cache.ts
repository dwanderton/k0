/**
 * Docs-cache build. Run from web/:
 *
 *   pnpm build:docs-cache              # additive — skips cached sources
 *   REFRESH=1 pnpm build:docs-cache    # re-crawl all sources, replace
 *                                      # per-source on success (weekly job)
 *
 * Checkpoints after each source; an aborted source keeps its old pages.
 * Commit the refreshed docs-cache.br afterwards — deploys ship it, they
 * never build it.
 */
import { buildAndSaveCache } from "../lib/docs-cache.ts";

await buildAndSaveCache({ refresh: process.env.REFRESH === "1" });

/**
 * Enriched KB manifest — build-time fine print (value, trade-offs,
 * limitations, comparisons) extracted offline by build:kb-manifest.
 * Runtime only reads; a call never pays for live inference of any of this.
 */
// fs must never reach a client bundle — poison client imports at build time
import "server-only";
import { readFile } from "fs/promises";
import { join } from "path";

export interface KbGuide {
  path: string;
  title: string;
  products: string[];
  value: string;
  tradeoffs: string[];
  limitations: string[];
  comparisons: string[];
  /** sha1 of the cached guide markdown — enrichment reuse key */
  hash: string;
  /** enrichment schema/prompt version — bumping forces re-enrichment */
  v: number;
}

let guides: Promise<Map<string, KbGuide>> | null = null;

/** keyed `vercel-kb:<path>` to match corpus keys; once per warm instance */
export function loadKbGuides(): Promise<Map<string, KbGuide>> {
  guides ??= readFile(join(process.cwd(), "kb-manifest.json"))
    .then((raw) => {
      const entries = JSON.parse(raw.toString()) as KbGuide[];
      return new Map(entries.map((e) => [`vercel-kb:${e.path}`, e]));
    })
    .catch((err) => {
      guides = null;
      throw err;
    });
  return guides;
}

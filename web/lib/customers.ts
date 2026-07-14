/**
 * Enriched customers manifest — build-time story metadata (customer,
 * industry, stack, outcome) extracted offline by build:customers-manifest.
 * Runtime only reads; a call never pays for live inference of any of this.
 */
// fs must never reach a client bundle — poison client imports at build time
import "server-only";
import { readFile } from "fs/promises";
import { join } from "path";

/** the story as a four-beat arc — the pitch skeleton an SA retells */
export interface StoryJourney {
  /** where they were */
  before: string;
  /** where they were going */
  goal: string;
  /** what needed to change */
  change: string;
  /** how Vercel satisfied that need */
  solution: string;
}

export interface CustomerStory {
  path: string;
  customer: string;
  industry: string;
  vercelProducts: string[];
  otherTech: string[];
  outcome: string;
  journey: StoryJourney;
  /** sha1 of the cached post markdown — enrichment reuse key */
  hash: string;
  /** enrichment schema/prompt version — bumping forces re-enrichment */
  v: number;
}

let stories: Promise<Map<string, CustomerStory>> | null = null;

/** keyed `vercel-blog:<path>` to match corpus keys; once per warm instance */
export function loadCustomerStories(): Promise<Map<string, CustomerStory>> {
  stories ??= readFile(join(process.cwd(), "customers-manifest.json"))
    .then((raw) => {
      const entries = JSON.parse(raw.toString()) as CustomerStory[];
      return new Map(entries.map((e) => [`vercel-blog:${e.path}`, e]));
    })
    .catch((err) => {
      stories = null;
      throw err;
    });
  return stories;
}

/**
 * Delete parked session cards older than PRUNE_MAX_AGE_DAYS (default 7).
 * Blob has no native TTL — this runs weekly from corpus-refresh.yml.
 * Sessions are "resumable for a week"; DRY_RUN=1 reports without deleting.
 */
import { list, del } from "@vercel/blob";

const MAX_AGE_DAYS = Number(process.env.PRUNE_MAX_AGE_DAYS ?? 7);
const DRY = process.env.DRY_RUN === "1";
const cutoff = Date.now() - MAX_AGE_DAYS * 86_400_000;

let cursor;
let total = 0;
const stale = [];
do {
  const page = await list({ prefix: "sessions/", cursor, limit: 1000 });
  total += page.blobs.length;
  for (const b of page.blobs) {
    if (new Date(b.uploadedAt).getTime() < cutoff) stale.push(b.pathname);
  }
  cursor = page.cursor;
} while (cursor);

console.log(
  `${total} session blobs · ${stale.length} older than ${MAX_AGE_DAYS}d${DRY ? " (dry run — not deleting)" : ""}`,
);
if (!DRY && stale.length > 0) {
  for (let i = 0; i < stale.length; i += 100) {
    await del(stale.slice(i, i + 100));
  }
  console.log(`deleted ${stale.length}`);
}

/**
 * Server-side card parking — the durability layer localStorage can't be.
 * A client that drops mid-stream cancels the response, but the turn keeps
 * running under after(); the validated card lands here, keyed by session,
 * and the client backfills from GET /api/session/[id] on reconnect.
 * Store is private Vercel Blob — one JSON blob per turn, no
 * read-modify-write races between concurrent turns.
 */
// blob token must never reach a client bundle — poison client imports at build time
import "server-only";
import { put, list } from "@vercel/blob";
import type { KbGuideRef, StoryRef } from "./call-shared";

export interface ParkedCard {
  turn: number;
  at: string;
  heard: string;
  text: string;
  debug: string[];
  /** customers mode: the 4 retrieved stories behind this card */
  stories?: StoryRef[];
  /** kb mode: the retrieved guides behind this card */
  guides?: KbGuideRef[];
}

const SESSION_ID_RE = /^[a-z0-9-]{8,64}$/i;

export function isValidSessionId(id: unknown): id is string {
  return typeof id === "string" && SESSION_ID_RE.test(id);
}

const path = (sessionId: string, turn: number) =>
  `sessions/${sessionId}/${String(turn).padStart(4, "0")}.json`;

export async function parkCard(sessionId: string, card: ParkedCard): Promise<void> {
  await put(path(sessionId, card.turn), JSON.stringify(card), {
    access: "private", // anonymous blob fetch 403s — cards only readable via our authed GET
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json",
  });
}

export async function listParkedCards(sessionId: string): Promise<ParkedCard[]> {
  const { blobs } = await list({ prefix: `sessions/${sessionId}/`, limit: 100 });
  const cards = await Promise.all(
    blobs.map(async (b) => {
      try {
        const res = await fetch(b.url, {
          headers: { authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}` },
          signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) return null;
        return (await res.json()) as ParkedCard;
      } catch {
        return null;
      }
    }),
  );
  return cards
    .filter((c): c is ParkedCard => c !== null && typeof c.turn === "number")
    .sort((a, b) => a.turn - b.turn);
}

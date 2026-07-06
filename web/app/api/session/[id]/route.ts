import { listParkedCards, isValidSessionId } from "@/lib/session-store";

/** Backfill: cards the server finished after the client dropped. */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!isValidSessionId(id)) {
    return Response.json({ error: "invalid session id" }, { status: 400 });
  }
  const cards = await listParkedCards(id);
  return Response.json({ cards }, { headers: { "Cache-Control": "no-store" } });
}

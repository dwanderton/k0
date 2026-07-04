import { buildAndSaveCache } from "@/lib/docs-cache";

export const maxDuration = 300; // 5 minutes max

export async function GET(req: Request) {
  // Verify cron secret to prevent unauthorized calls
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    console.log("Starting docs cache rebuild...");
    const startTime = Date.now();

    await buildAndSaveCache();

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`✓ Cache rebuild completed in ${elapsed}s`);

    return new Response(
      JSON.stringify({
        success: true,
        message: `Cache rebuilt in ${elapsed}s`,
        timestamp: new Date().toISOString(),
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  } catch (error) {
    console.error("Cache rebuild failed:", error);

    return new Response(
      JSON.stringify({
        success: false,
        error: String(error),
        timestamp: new Date().toISOString(),
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
}

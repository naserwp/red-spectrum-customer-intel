import { NextResponse } from "next/server";
import { rebuildAnalyticsCacheBatch } from "@/lib/analyticsCache";
import { connectToDatabase } from "@/lib/mongodb";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const started = Date.now();
  await connectToDatabase();
  const body = await request.json().catch(() => ({})) as { limit?: number; offset?: number };
  const result = await rebuildAnalyticsCacheBatch({ limit: body.limit ?? 100, offset: body.offset ?? 0, maxRuntimeMs: 8000 });
  return NextResponse.json({
    ok: true,
    customersProcessed: result.customersProcessed,
    rankingUpdated: result.rankingUpdated,
    summaryUpdated: result.summaryUpdated,
    subscriptionMetricsUpdated: result.subscriptionMetricsUpdated,
    hasMore: result.hasMore,
    nextOffset: result.nextOffset,
    generatedAt: result.generatedAt,
    totalMs: Date.now() - started,
    message: result.hasMore ? "Partial analytics rebuild completed. Continue next batch." : `Rebuilt dashboard analytics cache for ${result.rankingUpdated} ranked customers.`,
  });
}

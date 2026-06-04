import { NextResponse } from "next/server";
import { rebuildFundingIntelligenceBatch } from "@/lib/fundingRebuildBatch";
import { connectToDatabase } from "@/lib/mongodb";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const started = Date.now();
  await connectToDatabase();
  const body = await request.json().catch(() => ({})) as { limit?: number; offset?: number; dryRun?: boolean; email?: string };
  const result = await rebuildFundingIntelligenceBatch({
    limit: body.limit ?? 100,
    offset: body.offset ?? 0,
    dryRun: Boolean(body.dryRun),
    email: body.email ?? "",
  });
  return NextResponse.json({
    ...result,
    totalMs: Date.now() - started,
  });
}

import { NextResponse } from "next/server";
import { repairSubscriptionSchedules } from "@/lib/subscriptionSchedules";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as { dryRun?: boolean; limit?: number; cursor?: string | null };
  const result = await repairSubscriptionSchedules({
    dryRun: body.dryRun !== false,
    limit: body.limit,
    cursor: body.cursor ?? null,
  });
  return NextResponse.json({ success: true, ...result });
}

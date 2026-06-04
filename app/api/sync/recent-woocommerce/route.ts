import { NextResponse } from "next/server";
import { syncRecentWooCommerce } from "@/lib/liveWooSync";
import { connectToDatabase } from "@/lib/mongodb";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  await connectToDatabase();
  const body = await request.json().catch(() => ({})) as { hours?: number; maxPages?: number; orderIds?: Array<string | number> };
  const result = await syncRecentWooCommerce({
    hours: Math.min(168, Math.max(1, Number(body.hours ?? 72))),
    maxPages: Math.min(10, Math.max(1, Number(body.maxPages ?? 5))),
    orderIds: body.orderIds ?? [],
  });
  if (result.error) return NextResponse.json({ success: false, ...result }, { status: 400 });
  return NextResponse.json({ success: true, ...result });
}

import { NextResponse } from "next/server";
import { syncRecentWooCommerce } from "@/lib/liveWooSync";
import { connectToDatabase } from "@/lib/mongodb";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  await connectToDatabase();
  const { searchParams } = new URL(request.url);
  const hours = Math.min(168, Math.max(1, Number(searchParams.get("hours") ?? 24)));
  const maxPages = Math.min(10, Math.max(1, Number(searchParams.get("maxPages") ?? 3)));
  const result = await syncRecentWooCommerce({ hours, maxPages });
  if (result.error) return NextResponse.json({ success: false, ...result }, { status: 400 });
  return NextResponse.json({ success: true, mode: "manual-cron-endpoint", ...result });
}

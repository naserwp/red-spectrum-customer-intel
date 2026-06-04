import { NextResponse } from "next/server";
import { syncRecentWooCommerce } from "@/lib/liveWooSync";
import { connectToDatabase } from "@/lib/mongodb";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  await connectToDatabase();
  const body = await request.json().catch(() => ({})) as { id?: number | string; order_id?: number | string; number?: number | string };
  const orderId = body.id ?? body.order_id ?? body.number;
  const result = await syncRecentWooCommerce({ hours: 24, maxPages: 2, orderIds: orderId ? [orderId] : [] });
  if (result.error) return NextResponse.json({ success: false, ...result }, { status: 400 });
  return NextResponse.json({ success: true, webhook: "woocommerce.order", orderId: orderId ?? "", ...result });
}

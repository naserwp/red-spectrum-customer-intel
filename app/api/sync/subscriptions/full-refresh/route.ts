import { NextResponse } from "next/server";
import { fullRefreshSubscriptions } from "@/lib/subscriptionSync";

export const dynamic = "force-dynamic";

function safeSource(value: unknown): "woocommerce" | "authorizeNet" | "all" {
  const text = String(value ?? "all").trim();
  return text === "woocommerce" || text === "authorizeNet" || text === "all" ? text : "all";
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as { source?: string; dryRun?: boolean };
  const result = await fullRefreshSubscriptions({
    source: safeSource(body.source),
    dryRun: body.dryRun === true,
  });
  return NextResponse.json({ success: true, ...result });
}

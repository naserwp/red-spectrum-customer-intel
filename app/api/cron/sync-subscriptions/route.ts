import { NextResponse } from "next/server";
import { fullRefreshSubscriptions } from "@/lib/subscriptionSync";

export const dynamic = "force-dynamic";

function safeSource(value: unknown): "woocommerce" | "authorizeNet" | "all" {
  const text = String(value ?? "all").trim();
  return text === "woocommerce" || text === "authorizeNet" || text === "all" ? text : "all";
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const source = safeSource(url.searchParams.get("source"));
  const data = await fullRefreshSubscriptions({ source, dryRun: false });
  return NextResponse.json({
    mode: "manual-cron-endpoint",
    ...data,
  });
}

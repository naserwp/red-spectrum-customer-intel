import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const hours = Math.min(24 * 60, Math.max(1, Number(url.searchParams.get("hours") ?? 24) || 24));
  const syncUrl = new URL("/api/sync/recent-stripe", url.origin);
  const response = await fetch(syncUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hours, dryRun: false }),
    cache: "no-store",
  });
  const data = await response.json().catch(() => ({}));
  return NextResponse.json({
    mode: "manual-cron-endpoint",
    ...data,
  }, { status: response.status });
}

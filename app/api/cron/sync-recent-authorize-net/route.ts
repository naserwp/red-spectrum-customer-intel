import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const hours = Math.min(24 * 14, Math.max(1, Number(url.searchParams.get("hours") ?? 24) || 24));
  const syncUrl = new URL("/api/sync/recent-authorize-net", url.origin);
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

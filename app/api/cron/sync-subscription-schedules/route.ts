import { NextResponse } from "next/server";
import { repairSubscriptionSchedules } from "@/lib/subscriptionSchedules";

export const dynamic = "force-dynamic";

export async function GET() {
  let cursor: string | null = null;
  const repairTotals = {
    checked: 0,
    staleNextPayment: 0,
    recomputedFromWoo: 0,
    recomputedFromAuthorizeNet: 0,
    recomputedFromInterval: 0,
    unableToCompute: 0,
    sampleFixed: [] as Array<Record<string, unknown>>,
  };
  for (let page = 0; page < 20; page += 1) {
    const batch = await repairSubscriptionSchedules({ dryRun: false, limit: 500, cursor });
    repairTotals.checked += batch.checked;
    repairTotals.staleNextPayment += batch.staleNextPayment;
    repairTotals.recomputedFromWoo += batch.recomputedFromWoo;
    repairTotals.recomputedFromAuthorizeNet += batch.recomputedFromAuthorizeNet;
    repairTotals.recomputedFromInterval += batch.recomputedFromInterval;
    repairTotals.unableToCompute += batch.unableToCompute;
    repairTotals.sampleFixed.push(...batch.sampleFixed.slice(0, Math.max(0, 10 - repairTotals.sampleFixed.length)));
    cursor = batch.cursor ?? null;
    if (!batch.hasMore) break;
  }
  return NextResponse.json({
    success: true,
    mode: "subscription-schedule-cron",
    note: "Run /api/cron/sync-subscriptions?source=all before this endpoint when a full WooCommerce/Authorize.net source refresh is needed.",
    repair: repairTotals,
  });
}

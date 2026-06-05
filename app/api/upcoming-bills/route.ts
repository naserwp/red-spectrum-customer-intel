import { NextResponse } from "next/server";
import { buildStateOptions } from "@/lib/customerBusinessResolver";
import { readAnalyticsSnapshot } from "@/lib/analyticsCache";
import { normalizedStateParam, paging } from "@/lib/customerTableQuery";
import { connectToDatabase } from "@/lib/mongodb";
import { buildUpcomingBillsSnapshot, businessDateKey, enrichUpcomingRows, validUpcomingDate } from "@/lib/subscriptionSchedules";

export async function GET(request: Request) {
  const started = Date.now();
  await connectToDatabase();
  const dbStarted = Date.now();
  const { searchParams } = new URL(request.url);
  const { page, limit, skip } = paging(searchParams, 100);
  const state = normalizedStateParam(searchParams.get("state"));
  const snapshot = await readAnalyticsSnapshot<Record<string, unknown>>("dashboard_analytics", {
    upcomingRows: [],
    recurringCandidates: [],
    totalUpcomingThisMonth: 0,
    totalUpcomingAmountThisMonth: 0,
    upcomingToday: 0,
    upcomingNext7Days: 0,
  });
  const liveUpcoming = await buildUpcomingBillsSnapshot();
  let rows = (liveUpcoming.upcomingRows as Array<Record<string, unknown>>)
    .filter((row) => String(row.status ?? "") === "active" || String(row.status ?? "") === "estimated_recurring")
    .filter((row) => validUpcomingDate(String(row.nextBillingDate ?? ""), new Date()));
  rows = await enrichUpcomingRows(rows);
  const allRows = rows;
  rows = state ? allRows.filter((row) => row.stateCode === state) : allRows;
  const todayKey = businessDateKey(new Date());
  const next7 = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate() + 7, 23, 59, 59, 999);
  const revenueTotal = rows.reduce((sum, row) => sum + Number(row.amount ?? 0), 0);
  const payload = {
    page,
    limit,
    total: rows.length,
    rows: rows.slice(skip, skip + limit),
    state,
    stateOptions: buildStateOptions(allRows),
    recurringCandidates: Array.isArray(snapshot.recurringCandidates) ? snapshot.recurringCandidates : [],
    highRiskCount: rows.filter((row) => row.churnRisk === "high").length,
    estimatedUpcomingRevenue: revenueTotal,
    upcomingCustomerCountThisMonth: rows.length,
    upcomingRevenueThisMonth: revenueTotal,
    upcomingToday: rows.filter((row) => businessDateKey(row.nextBillingDate) === todayKey).length,
    upcomingNext7Days: rows.filter((row) => validUpcomingDate(String(row.nextBillingDate ?? ""), new Date(), next7)).length,
    message: snapshot.analyticsCacheReady ? "" : "Analytics cache is rebuilding...",
  };
  if (process.env.NODE_ENV === "development") {
    console.log(`[api] upcoming-bills durationMs=${Date.now() - started} mongoMs=${Date.now() - dbStarted} cache=stored responseBytes=${JSON.stringify(payload).length}`);
  }
  return NextResponse.json(payload);
}

import { NextResponse } from "next/server";
import { readAnalyticsSnapshot } from "@/lib/analyticsCache";
import { connectToDatabase } from "@/lib/mongodb";
import { Customer } from "@/models/Customer";

export const dynamic = "force-dynamic";

export async function GET() {
  const started = Date.now();
  await connectToDatabase();
  const dbStarted = Date.now();
  const snapshot = await readAnalyticsSnapshot("dashboard_analytics", {
    currentMonthRevenue: 0,
    previousMonthRevenue: 0,
    monthGrowthPercent: 0,
    currentYearRevenue: 0,
    rolling12MonthRevenue: 0,
    activeMRR: 0,
    recurringCustomerCount: 0,
    totalSubscriptions: 0,
    activeWooSubscriptions: 0,
    activeGatewayRecurringCustomers: 0,
    totalActiveRecurringCustomers: 0,
    totalMonthlyRecurringRevenue: 0,
    totalUpcomingThisMonth: 0,
    totalUpcomingAmountThisMonth: 0,
    upcomingRevenueThisMonth: 0,
    upcomingCustomerCountThisMonth: 0,
  });
  let payload: Record<string, unknown> = snapshot;
  if (!snapshot.analyticsCacheReady) {
    const fallback = await Customer.aggregate<{ _id: null; paidRevenue: number; activeGatewayRecurringCustomers: number; activeMRR: number }>([
      {
        $group: {
          _id: null,
          paidRevenue: { $sum: { $ifNull: ["$lifetimeValue", { $ifNull: ["$rankingPaidTotal", { $ifNull: ["$paidTotal", "$totalPaid"] }] }] } },
          activeGatewayRecurringCustomers: { $sum: { $cond: ["$isGatewayRecurring", 1, 0] } },
          activeMRR: { $sum: { $cond: ["$isGatewayRecurring", { $ifNull: ["$recurringAmount", 0] }, 0] } },
        },
      },
    ]);
    payload = {
      ...snapshot,
      currentYearRevenue: Number(fallback[0]?.paidRevenue ?? 0),
      rolling12MonthRevenue: Number(fallback[0]?.paidRevenue ?? 0),
      activeMRR: Number(fallback[0]?.activeMRR ?? 0),
      recurringCustomerCount: Number(fallback[0]?.activeGatewayRecurringCustomers ?? 0),
      activeGatewayRecurringCustomers: Number(fallback[0]?.activeGatewayRecurringCustomers ?? 0),
      totalActiveRecurringCustomers: Number(fallback[0]?.activeGatewayRecurringCustomers ?? 0),
      totalMonthlyRecurringRevenue: Number(fallback[0]?.activeMRR ?? 0),
      message: "Analytics cache is rebuilding...",
    };
  }
  if (process.env.NODE_ENV === "development") {
    console.log(`[api] revenue-overview durationMs=${Date.now() - started} mongoMs=${Date.now() - dbStarted} cache=${payload.analyticsCacheReady ? "stored" : "fallback"} responseBytes=${JSON.stringify(payload).length}`);
  }
  return NextResponse.json(payload);
}

import { highValueThreshold } from "@/lib/businessMetrics";
import { readAnalyticsSnapshot } from "@/lib/analyticsCache";
import { connectToDatabase } from "@/lib/mongodb";
import { Customer } from "@/models/Customer";
import { CustomerRanking } from "@/models/CustomerRanking";
import { SyncJob } from "@/models/SyncJob";

export const dynamic = "force-dynamic";

export async function GET() {
  const started = Date.now();
  await connectToDatabase();
  const dbStarted = Date.now();
  const [customerCount, highValueCustomers, lastJob, snapshot, fallbackAgg] = await Promise.all([
    Customer.estimatedDocumentCount(),
    CustomerRanking.countDocuments({ lifetimeSpent: { $gte: highValueThreshold } }),
    SyncJob.findOne({}).sort({ finishedAt: -1, updatedAt: -1 }).lean<{ finishedAt?: string; updatedAt?: Date | string } | null>(),
    readAnalyticsSnapshot<Record<string, unknown>>("dashboard_analytics", {}),
    Customer.aggregate<{ _id: null; paidRevenue: number; attemptedRevenue: number; activeSubscriptions: number; activeGatewayRecurringCustomers: number; monthlyRecurringRevenue: number; highValueCustomers: number }>([
      {
        $group: {
          _id: null,
          paidRevenue: { $sum: { $ifNull: ["$lifetimeValue", { $ifNull: ["$rankingPaidTotal", { $ifNull: ["$paidTotal", "$totalPaid"] }] }] } },
          attemptedRevenue: { $sum: { $ifNull: ["$attemptedTotal", 0] } },
          activeSubscriptions: { $sum: { $ifNull: ["$activeSubscriptions", 0] } },
          activeGatewayRecurringCustomers: { $sum: { $cond: ["$isGatewayRecurring", 1, 0] } },
          monthlyRecurringRevenue: { $sum: { $cond: ["$isGatewayRecurring", { $ifNull: ["$recurringAmount", 0] }, 0] } },
          highValueCustomers: { $sum: { $cond: [{ $gte: [{ $ifNull: ["$lifetimeValue", { $ifNull: ["$rankingPaidTotal", { $ifNull: ["$paidTotal", "$totalPaid"] }] }] }, highValueThreshold] }, 1, 0] } },
        },
      },
    ]),
  ]);
  const fallback = fallbackAgg[0];
  const cacheReady = Boolean(snapshot.analyticsCacheReady);
  const fallbackPaidRevenue = Number(fallback?.paidRevenue ?? 0);
  const fallbackActiveSubscriptions = Number(fallback?.activeSubscriptions ?? 0) + Number(fallback?.activeGatewayRecurringCustomers ?? 0);
  const fallbackMrr = Number(fallback?.monthlyRecurringRevenue ?? 0);
  const payload = {
    customerCount,
    totalRevenue: Number(snapshot.currentYearRevenue ?? fallbackPaidRevenue),
    paidRevenue: Number(snapshot.rolling12MonthRevenue ?? snapshot.currentYearRevenue ?? fallbackPaidRevenue),
    attemptedRevenue: Number(snapshot.attemptedRevenue ?? fallback?.attemptedRevenue ?? 0),
    totalSubscriptions: Number(snapshot.totalSubscriptions ?? 0),
    activeWooSubscriptions: Number(snapshot.activeWooSubscriptions ?? 0),
    activeGatewayRecurringCustomers: Number(snapshot.activeGatewayRecurringCustomers ?? fallback?.activeGatewayRecurringCustomers ?? 0),
    totalActiveRecurringCustomers: Number(snapshot.totalActiveRecurringCustomers ?? fallbackActiveSubscriptions),
    activeSubscriptions: Number(snapshot.totalActiveRecurringCustomers ?? fallbackActiveSubscriptions),
    monthlyRecurringRevenue: Number(snapshot.totalMonthlyRecurringRevenue ?? snapshot.activeMRR ?? fallbackMrr),
    totalMonthlyRecurringRevenue: Number(snapshot.totalMonthlyRecurringRevenue ?? snapshot.activeMRR ?? fallbackMrr),
    subscriptionCandidates: 0,
    subscriptionNote: cacheReady ? "Cached subscription analytics" : "Analytics cache is rebuilding...",
    upcomingBills30d: Number(snapshot.totalUpcomingThisMonth ?? 0),
    estimatedUpcomingRevenue30d: Number(snapshot.totalUpcomingAmountThisMonth ?? 0),
    paidRevenueThisMonth: Number(snapshot.currentMonthRevenue ?? 0),
    attemptedPipelineThisMonth: 0,
    checkoutAttemptsThisMonth: 0,
    highValueCustomers: cacheReady ? highValueCustomers : Number(fallback?.highValueCustomers ?? 0),
    highValueCustomersThisMonth: 0,
    failedPaymentsThisMonth: 0,
    newCustomersThisMonth: 0,
    newPaidCustomersThisMonth: 0,
    newHotLeadsThisMonth: 0,
    sourceBreakdown: { woocommerce: Number(snapshot.totalMonthlyRecurringRevenue ?? 0) },
    salesHistoryUpdatedAt: String(snapshot.analyticsGeneratedAt ?? ""),
    lastSyncAt: String(lastJob?.finishedAt || lastJob?.updatedAt || snapshot.analyticsGeneratedAt || ""),
    analyticsCacheReady: cacheReady,
    message: cacheReady ? "" : "Analytics cache is rebuilding...",
  };
  if (process.env.NODE_ENV === "development") {
    console.log(`[api] customers-summary durationMs=${Date.now() - started} mongoMs=${Date.now() - dbStarted} cache=stored responseBytes=${JSON.stringify(payload).length}`);
  }
  return Response.json(payload);
}

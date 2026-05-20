import { dateInRange, monthEnd, monthStart, monthsBetween, wooSubscriptionMrr } from "@/lib/revenueAnalytics";
import { AnalyticsSnapshot } from "@/models/AnalyticsSnapshot";
import { Customer, type CustomerDocument } from "@/models/Customer";
import { CustomerRanking } from "@/models/CustomerRanking";
import { WooCommerceSubscriptionRecord, type WooCommerceSubscriptionDocument } from "@/models/WooCommerceSubscription";

type LeanWooSubscription = WooCommerceSubscriptionDocument & { _id: unknown };

function category(lifetimeSpent: number, attemptedPipeline: number) {
  if (lifetimeSpent >= 2000) return "VIP Paid Customer";
  if (lifetimeSpent > 0) return "Paying Customer";
  if (attemptedPipeline > 0) return "Hot Lead";
  return "Cold Lead";
}

function paidValue(customer: Partial<CustomerDocument>) {
  return Number(customer.lifetimeValue ?? customer.rankingPaidTotal ?? customer.paidTotal ?? customer.totalPaid ?? 0);
}

export async function readAnalyticsSnapshot<T extends Record<string, unknown>>(key: string, fallback: T) {
  const snapshot = await AnalyticsSnapshot.findOne({ key }).lean<{ payload?: T; generatedAt?: string; warnings?: string[] } | null>().exec();
  return {
    ...fallback,
    ...(snapshot?.payload ?? {}),
    analyticsGeneratedAt: snapshot?.generatedAt ?? "",
    analyticsCacheReady: Boolean(snapshot),
    warnings: snapshot?.warnings ?? [],
  };
}

export async function rebuildAnalyticsCacheBatch({ limit = 100, offset = 0, maxRuntimeMs = 8000 }: { limit?: number; offset?: number; maxRuntimeMs?: number } = {}) {
  const started = Date.now();
  const generatedAt = new Date().toISOString();
  const now = new Date();
  const currentMonthStart = monthStart(now);
  const currentMonthEnd = monthEnd(now);
  const currentYearStart = new Date(now.getFullYear(), 0, 1);
  const safeLimit = Math.min(100, Math.max(1, Math.floor(limit)));
  const safeOffset = Math.max(0, Math.floor(offset));
  const [customers, totalCustomers, subscriptions, summaryAgg] = await Promise.all([
    Customer.find({}, {
      name: 1, email: 1, normalizedEmail: 1, phone: 1, attemptedTotal: 1, attemptedOrderCount: 1, firstPaidDate: 1, firstOrderDate: 1, lastPaidDate: 1, lastOrderDate: 1,
      activeSubscriptions: 1, isGatewayRecurring: 1, recurringAmount: 1, recurringNextEstimatedPayment: 1, recurringLastPayment: 1, paidMonths: 1, stayWithUsMonths: 1, riskLevel: 1,
      lifetimeValue: 1, rankingPaidTotal: 1, paidTotal: 1, totalPaid: 1,
    }).sort({ lifetimeValue: -1, rankingPaidTotal: -1, paidTotal: -1 }).skip(safeOffset).limit(safeLimit).lean<Array<CustomerDocument & { _id: unknown }>>(),
    Customer.estimatedDocumentCount(),
    WooCommerceSubscriptionRecord.find({}).lean<LeanWooSubscription[]>(),
    Customer.aggregate<{ _id: null; paidRevenue: number; attemptedRevenue: number; activeGatewayRecurringCustomers: number; gatewayMrr: number; highValueCustomers: number }>([
      {
        $group: {
          _id: null,
          paidRevenue: { $sum: { $ifNull: ["$lifetimeValue", { $ifNull: ["$rankingPaidTotal", { $ifNull: ["$paidTotal", "$totalPaid"] }] }] } },
          attemptedRevenue: { $sum: { $ifNull: ["$attemptedTotal", 0] } },
          activeGatewayRecurringCustomers: { $sum: { $cond: ["$isGatewayRecurring", 1, 0] } },
          gatewayMrr: { $sum: { $cond: ["$isGatewayRecurring", { $ifNull: ["$recurringAmount", 0] }, 0] } },
          highValueCustomers: { $sum: { $cond: [{ $gte: [{ $ifNull: ["$lifetimeValue", { $ifNull: ["$rankingPaidTotal", { $ifNull: ["$paidTotal", "$totalPaid"] }] }] }, 2000] }, 1, 0] } },
        },
      },
    ]),
  ]);
  const summary = summaryAgg[0];
  const rankingRows = [];
  for (const customer of customers) {
    if (Date.now() - started > maxRuntimeMs - 500) break;
    const lifetimeSpent = paidValue(customer);
    const firstPaidDate = customer.firstPaidDate || customer.firstOrderDate || "";
    const latestPaidDate = customer.lastPaidDate || customer.lastOrderDate || "";
    const attemptedPipeline = Number(customer.attemptedTotal ?? 0);
    rankingRows.push({
      customerId: String(customer._id),
      name: customer.name,
      email: customer.email,
      phone: customer.phone,
      lifetimeSpent,
      periodSpent: lifetimeSpent,
      monthlySpent: dateInRange(latestPaidDate, currentMonthStart, now) ? lifetimeSpent : 0,
      yearlySpent: dateInRange(latestPaidDate, currentYearStart, now) ? lifetimeSpent : 0,
      paidMonths: Number(customer.paidMonths ?? 0),
      firstPaidDate,
      latestPaidDate,
      activeSubscriptionCount: Number(customer.activeSubscriptions ?? 0) + (customer.isGatewayRecurring ? 1 : 0),
      estimatedMRR: Number(customer.recurringAmount ?? 0),
      stayWithUsMonths: Math.max(monthsBetween(firstPaidDate), Number(customer.stayWithUsMonths ?? 0)),
      attemptedPipeline,
      category: category(lifetimeSpent, attemptedPipeline),
      generatedAt,
    });
  }
  const filteredRankingRows = rankingRows.filter((row) => row.lifetimeSpent > 0 || row.attemptedPipeline > 0);

  if (filteredRankingRows.length) {
    await CustomerRanking.bulkWrite(filteredRankingRows.map((row) => ({
      updateOne: { filter: { customerId: row.customerId }, update: { $set: row }, upsert: true },
    })), { ordered: false });
  }

  const activeWooSubscriptions = subscriptions.filter((subscription) => subscription.status === "active");
  const gatewayRecurringCustomers = customers.filter((customer) => customer.isGatewayRecurring);
  const upcomingWooRows = activeWooSubscriptions.filter((subscription) => dateInRange(subscription.nextPaymentDate ?? "", currentMonthStart, currentMonthEnd)).map((record) => ({
    _id: String(record._id),
    subscriptionId: String(record.wooSubscriptionId),
    subscriptionNumber: record.subscriptionNumber,
    source: "woocommerce",
    customerEmail: record.customerEmail,
    customerName: record.customerName,
    customerPhone: record.customerPhone,
    status: record.status,
    amount: Number(record.recurringTotal ?? record.amount ?? 0),
    monthlyRecurringRevenue: Number(record.recurringTotal ?? record.amount ?? 0),
    billingInterval: [record.billingInterval, record.billingPeriod].filter(Boolean).join(" "),
    nextBillingDate: record.nextPaymentDate,
    lastBillingDate: record.lastPaymentDate,
    startDate: record.startDate,
    paymentMethodTitle: record.paymentMethodTitle || record.paymentMethod,
    productNames: record.productNames,
    sourceStatus: "real",
    recordType: "subscription",
    churnRisk: "low",
    action: "Review subscription renewal",
  }));
  const upcomingGatewayRows = gatewayRecurringCustomers.filter((customer) => dateInRange(customer.recurringNextEstimatedPayment ?? "", currentMonthStart, currentMonthEnd)).map((customer) => ({
    _id: String(customer._id),
    subscriptionId: `authorize-net-${String(customer._id)}`,
    subscriptionNumber: "",
    source: "authorize_net",
    customerEmail: customer.email,
    customerName: customer.name,
    customerPhone: customer.phone,
    status: "estimated_recurring",
    amount: Number(customer.recurringAmount ?? 0),
    monthlyRecurringRevenue: Number(customer.recurringAmount ?? 0),
    billingInterval: "monthly",
    nextBillingDate: customer.recurringNextEstimatedPayment,
    lastBillingDate: customer.recurringLastPayment,
    startDate: "",
    paymentMethodTitle: "Credit Card Payment",
    productNames: ["Authorize.net Recurring Payment"],
    sourceStatus: "gateway_estimated",
    recordType: "gateway_recurring",
    churnRisk: customer.riskLevel ?? "low",
    action: "Review Authorize.net recurring payment",
  }));
  const upcomingRows = [...upcomingWooRows, ...upcomingGatewayRows].sort((a, b) => String(a.nextBillingDate ?? "").localeCompare(String(b.nextBillingDate ?? "")));
  const activeMRR = wooSubscriptionMrr(subscriptions) + Number(summary?.gatewayMrr ?? 0);
  const payload = {
    currentMonthRevenue: rankingRows.reduce((sum, row) => sum + Number(row.monthlySpent ?? 0), 0),
    previousMonthRevenue: 0,
    currentYearRevenue: Number(summary?.paidRevenue ?? 0),
    rolling12MonthRevenue: Number(summary?.paidRevenue ?? 0),
    paidRevenue: Number(summary?.paidRevenue ?? 0),
    attemptedRevenue: Number(summary?.attemptedRevenue ?? 0),
    activeMRR,
    monthlyRecurringRevenue: activeMRR,
    totalMonthlyRecurringRevenue: activeMRR,
    totalSubscriptions: subscriptions.length,
    activeWooSubscriptions: activeWooSubscriptions.length,
    activeGatewayRecurringCustomers: Number(summary?.activeGatewayRecurringCustomers ?? 0),
    totalActiveRecurringCustomers: activeWooSubscriptions.length + Number(summary?.activeGatewayRecurringCustomers ?? 0),
    activeSubscriptions: activeWooSubscriptions.length + Number(summary?.activeGatewayRecurringCustomers ?? 0),
    totalUpcomingThisMonth: upcomingRows.length,
    totalUpcomingAmountThisMonth: upcomingRows.reduce((sum, row) => sum + Number(row.amount ?? 0), 0),
    upcomingRevenueThisMonth: upcomingRows.reduce((sum, row) => sum + Number(row.amount ?? 0), 0),
    upcomingCustomerCountThisMonth: upcomingRows.length,
    upcomingToday: upcomingRows.filter((row) => String(row.nextBillingDate ?? "").slice(0, 10) === now.toISOString().slice(0, 10)).length,
    upcomingNext7Days: upcomingRows.filter((row) => dateInRange(String(row.nextBillingDate ?? ""), now, new Date(now.getTime() + 7 * 86400000))).length,
    upcomingRows,
    highValueCustomers: Number(summary?.highValueCustomers ?? 0),
    totalCustomers,
  };
  const previousMonthRevenue = Number(payload.previousMonthRevenue ?? 0);
  const currentMonthRevenue = Number(payload.currentMonthRevenue ?? 0);
  await AnalyticsSnapshot.updateOne(
    { key: "dashboard_analytics" },
    {
      $set: {
        payload: {
          ...payload,
          monthGrowthPercent: previousMonthRevenue > 0 ? ((currentMonthRevenue - previousMonthRevenue) / previousMonthRevenue) * 100 : currentMonthRevenue > 0 ? 100 : 0,
        },
        generatedAt,
        status: safeOffset + rankingRows.length < totalCustomers ? "partial" : rankingRows.length ? "ready" : "empty",
        warnings: safeOffset + rankingRows.length < totalCustomers ? ["Partial analytics rebuild completed. Continue next batch."] : [],
      },
    },
    { upsert: true }
  );
  const customersProcessed = rankingRows.length;
  const hasMore = safeOffset + customersProcessed < totalCustomers;
  return {
    customersProcessed,
    rankingUpdated: filteredRankingRows.length,
    summaryUpdated: true,
    subscriptionMetricsUpdated: true,
    hasMore,
    nextOffset: safeOffset + customersProcessed,
    generatedAt,
    partial: hasMore,
  };
}

export async function rebuildAnalyticsCache() {
  return rebuildAnalyticsCacheBatch({ limit: 500, offset: 0 });
}

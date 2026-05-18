import { NextResponse } from "next/server";
import { highValueThreshold, isInRange, isRealSubscriptionRecord, monthStart, rollingDaysStart } from "@/lib/businessMetrics";
import { connectToDatabase } from "@/lib/mongodb";
import { Customer, type CustomerDocument } from "@/models/Customer";
import { SalesHistory, type SalesHistoryDocument } from "@/models/SalesHistory";
import { Subscription, type SubscriptionDocument } from "@/models/Subscription";

export async function GET() {
  await connectToDatabase();
  const [customers, subs, salesHistory] = await Promise.all([
    Customer.find({}).lean<CustomerDocument[]>(),
    Subscription.find({}).lean<SubscriptionDocument[]>(),
    SalesHistory.findOne({ source: "woocommerce" }).lean<SalesHistoryDocument | null>(),
  ]);

  const now = new Date();
  const startOfMonth = monthStart(now);
  const last30 = rollingDaysStart(30, now);
  const next30 = new Date(now.getTime() + 30 * 86400000);
  const realSubs = subs.filter(isRealSubscriptionRecord);
  const subscriptionCandidates = subs.filter((s) => !s.isPlaceholder && s.recordType === "subscription_candidate");
  const activeSubs = realSubs.filter((s) => s.status === "active");
  const upcomingActiveSubs30d = activeSubs.filter((s) => isInRange(s.nextBillingDate ?? "", now, next30));
  const failedSubs = realSubs.filter((s) => (s.failedPaymentCount ?? 0) > 0 || s.lastPaymentStatus === "failed");
  const failedSubsThisMonth = failedSubs.filter((s) => isInRange(s.lastBillingDate ?? s.lastSyncedAt ?? "", startOfMonth, now));
  const failedSubsLast30Days = failedSubs.filter((s) => isInRange(s.lastBillingDate ?? s.lastSyncedAt ?? "", last30, now));
  const currentMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const currentMonthSales = salesHistory?.monthly?.find((m) => m.period === currentMonthKey);

  const paidRevenue = customers.reduce((a, c) => a + (c.paidTotal ?? c.totalPaid ?? 0), 0);
  const attemptedRevenue = customers.reduce((a, c) => a + (c.attemptedTotal ?? 0), 0);
  const newCustomersThisMonth = customers.filter((c) => isInRange(c.firstOrderDate ?? "", startOfMonth, now)).length;
  const newPaidCustomersThisMonth = customers.filter((c) => (c.paidTotal ?? c.totalPaid ?? 0) > 0 && isInRange(c.firstOrderDate ?? "", startOfMonth, now)).length;
  const newHotLeadsThisMonth = customers.filter((c) => (c.paidTotal ?? c.totalPaid ?? 0) === 0 && (c.attemptedTotal ?? 0) > 0 && isInRange(c.lastAttemptDate ?? c.firstOrderDate ?? "", startOfMonth, now)).length;
  const highValueCustomers = customers.filter((c) => (c.paidTotal ?? c.totalPaid ?? 0) >= highValueThreshold);
  const highValueCustomersThisMonth = highValueCustomers.filter((c) => isInRange(c.lastPaidDate ?? c.lastOrderDate ?? "", startOfMonth, now)).length;
  const failedCheckoutAttemptsThisMonth = customers
    .filter((c) => (c.failedPayments ?? 0) > 0 && isInRange(c.lastAttemptDate ?? c.lastOrderDate ?? "", startOfMonth, now))
    .reduce((a, c) => a + (c.failedPayments ?? 0), 0);
  const mrr = activeSubs.reduce((a, s) => a + (s.monthlyRecurringRevenue ?? s.amount ?? 0), 0);
  const sourceBreakdown = ["woocommerce", "stripe", "authorize_net", "nmi", "manual"].reduce<Record<string, number>>((acc, source) => {
    acc[source] = realSubs.filter((s) => s.source === source).reduce((a, s) => a + (s.amount ?? 0), 0);
    return acc;
  }, {});

  return NextResponse.json({
    customerCount: customers.length,
    totalRevenue: paidRevenue,
    paidRevenue,
    attemptedRevenue,
    totalSubscriptions: realSubs.length,
    activeSubscriptions: activeSubs.length,
    inactiveSubscriptions: realSubs.filter((s) => s.status === "inactive" || s.status === "canceled").length,
    pendingSubscriptions: realSubs.filter((s) => s.status === "pending" || s.status === "past_due").length,
    subscriptionCandidates: subscriptionCandidates.length,
    subscriptionNote: activeSubs.length === 0 ? "No active subscriptions detected." : "",
    failedPayments: failedSubsThisMonth.length,
    failedPaymentsTotal: failedSubs.length,
    failedPaymentsThisMonth: failedSubsThisMonth.length,
    failedPaymentsLast30Days: failedSubsLast30Days.length,
    failedCheckoutAttemptsThisMonth,
    upcomingBills7d: activeSubs.filter((s) => isInRange(s.nextBillingDate ?? "", now, new Date(now.getTime() + 7 * 86400000))).length,
    upcomingBills30d: upcomingActiveSubs30d.length,
    estimatedUpcomingRevenue30d: upcomingActiveSubs30d.reduce((a, s) => a + (s.amount ?? 0), 0),
    monthlyRecurringRevenue: mrr,
    newCustomersThisMonth,
    newPaidCustomersThisMonth,
    newHotLeadsThisMonth,
    checkoutAttemptsThisMonth: currentMonthSales?.attemptedOrders ?? customers.filter((c) => isInRange(c.lastAttemptDate ?? "", startOfMonth, now)).reduce((a, c) => a + (c.attemptedOrderCount ?? 0), 0),
    paidRevenueThisMonth: currentMonthSales?.paidRevenue ?? customers.filter((c) => isInRange(c.lastPaidDate ?? "", startOfMonth, now)).reduce((a, c) => a + (c.paidTotal ?? c.totalPaid ?? 0), 0),
    attemptedPipelineThisMonth: currentMonthSales?.attemptedPipeline ?? customers.filter((c) => isInRange(c.lastAttemptDate ?? "", startOfMonth, now)).reduce((a, c) => a + (c.attemptedTotal ?? 0), 0),
    highValueCustomers: highValueCustomers.length,
    highValueCustomersThisMonth,
    sourceBreakdown,
    salesHistoryUpdatedAt: salesHistory?.generatedAt ?? "",
  });
}

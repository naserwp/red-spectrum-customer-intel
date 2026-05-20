import { NextResponse } from "next/server";
import { readAnalyticsSnapshot } from "@/lib/analyticsCache";
import { connectToDatabase } from "@/lib/mongodb";
import { monthEnd, monthStart, dateInRange } from "@/lib/revenueAnalytics";
import { Customer } from "@/models/Customer";
import { WooCommerceSubscriptionRecord } from "@/models/WooCommerceSubscription";

export async function GET() {
  const started = Date.now();
  await connectToDatabase();
  const dbStarted = Date.now();
  const snapshot = await readAnalyticsSnapshot<Record<string, unknown>>("dashboard_analytics", {
    upcomingRows: [],
    recurringCandidates: [],
    totalUpcomingThisMonth: 0,
    totalUpcomingAmountThisMonth: 0,
    upcomingToday: 0,
    upcomingNext7Days: 0,
  });
  let rows = (Array.isArray(snapshot.upcomingRows) ? snapshot.upcomingRows : []) as Array<Record<string, unknown>>;
  if (!snapshot.analyticsCacheReady) {
    const now = new Date();
    const start = monthStart(now);
    const end = monthEnd(now);
    const [wooRows, gatewayRows] = await Promise.all([
      WooCommerceSubscriptionRecord.find({ status: "active", nextPaymentDate: { $ne: "" } }).sort({ nextPaymentDate: 1 }).limit(100).lean(),
      Customer.find({ isGatewayRecurring: true, recurringNextEstimatedPayment: { $ne: "" } }, { name: 1, email: 1, phone: 1, recurringAmount: 1, recurringNextEstimatedPayment: 1, recurringLastPayment: 1, riskLevel: 1 }).sort({ recurringNextEstimatedPayment: 1 }).limit(100).lean(),
    ]);
    rows = [
      ...wooRows.filter((row) => dateInRange(String(row.nextPaymentDate ?? ""), start, end)).map((row) => ({
        _id: String(row._id),
        subscriptionId: String(row.wooSubscriptionId),
        source: "woocommerce",
        customerEmail: row.customerEmail,
        customerName: row.customerName,
        status: row.status,
        amount: Number(row.recurringTotal ?? row.amount ?? 0),
        nextBillingDate: row.nextPaymentDate,
        lastBillingDate: row.lastPaymentDate,
        paymentMethodTitle: row.paymentMethodTitle || row.paymentMethod,
        productNames: row.productNames,
        churnRisk: "low",
        action: "Review subscription renewal",
      })),
      ...gatewayRows.filter((row) => dateInRange(String(row.recurringNextEstimatedPayment ?? ""), start, end)).map((row) => ({
        _id: String(row._id),
        subscriptionId: `authorize-net-${String(row._id)}`,
        source: "authorize_net",
        customerEmail: row.email,
        customerName: row.name,
        status: "estimated_recurring",
        amount: Number(row.recurringAmount ?? 0),
        nextBillingDate: row.recurringNextEstimatedPayment,
        lastBillingDate: row.recurringLastPayment,
        paymentMethodTitle: "Credit Card Payment",
        productNames: ["Authorize.net Recurring Payment"],
        churnRisk: row.riskLevel ?? "low",
        action: "Review Authorize.net recurring payment",
      })),
    ];
  }
  const payload = {
    rows,
    recurringCandidates: Array.isArray(snapshot.recurringCandidates) ? snapshot.recurringCandidates : [],
    highRiskCount: rows.filter((row) => row.churnRisk === "high").length,
    estimatedUpcomingRevenue: Number(snapshot.totalUpcomingAmountThisMonth ?? 0),
    upcomingCustomerCountThisMonth: Number(snapshot.totalUpcomingThisMonth ?? rows.length),
    upcomingRevenueThisMonth: Number(snapshot.upcomingRevenueThisMonth ?? snapshot.totalUpcomingAmountThisMonth ?? 0),
    upcomingToday: Number(snapshot.upcomingToday ?? 0),
    upcomingNext7Days: Number(snapshot.upcomingNext7Days ?? 0),
    message: snapshot.analyticsCacheReady ? "" : "Analytics cache is rebuilding...",
  };
  if (process.env.NODE_ENV === "development") {
    console.log(`[api] upcoming-bills durationMs=${Date.now() - started} mongoMs=${Date.now() - dbStarted} cache=stored responseBytes=${JSON.stringify(payload).length}`);
  }
  return NextResponse.json(payload);
}

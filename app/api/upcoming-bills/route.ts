import { NextResponse } from "next/server";
import { buildStateOptions } from "@/lib/customerBusinessResolver";
import { readAnalyticsSnapshot } from "@/lib/analyticsCache";
import { resolveBusinessName } from "@/lib/customerBusiness";
import { enrichCustomerProfile } from "@/lib/customerEnrichment";
import { normalizedStateParam, paging } from "@/lib/customerTableQuery";
import { connectToDatabase } from "@/lib/mongodb";
import { monthEnd, monthStart, dateInRange } from "@/lib/revenueAnalytics";
import { Customer } from "@/models/Customer";
import { WooCommerceSubscriptionRecord } from "@/models/WooCommerceSubscription";

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
  let rows = (Array.isArray(snapshot.upcomingRows) ? snapshot.upcomingRows : []) as Array<Record<string, unknown>>;
  if (!snapshot.analyticsCacheReady) {
    const now = new Date();
    const start = monthStart(now);
    const end = monthEnd(now);
    const [wooRows, gatewayRows] = await Promise.all([
      WooCommerceSubscriptionRecord.find({ status: "active", nextPaymentDate: { $ne: "" } }).sort({ nextPaymentDate: 1 }).limit(100).lean(),
      Customer.find({ isGatewayRecurring: true, recurringNextEstimatedPayment: { $ne: "" } }, { name: 1, email: 1, phone: 1, recurringAmount: 1, recurringNextEstimatedPayment: 1, recurringLastPayment: 1, riskLevel: 1, businessProfile: 1, orders: 1 }).sort({ recurringNextEstimatedPayment: 1 }).limit(100).lean(),
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
        businessName: resolveBusinessName(row).businessName,
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
  const rowEmails = rows.map((row) => String(row.customerEmail ?? "").trim().toLowerCase()).filter(Boolean);
  const customers = rowEmails.length ? await Customer.find({ normalizedEmail: { $in: rowEmails } }, { normalizedEmail: 1, email: 1, businessProfile: 1, orders: 1, factiivProfile: 1, publicEnrichment: 1 }).lean() : [];
  const customerByEmail = new Map(customers.map((customer) => [String(customer.normalizedEmail || customer.email || "").toLowerCase(), customer]));
  rows = rows.map((row) => {
    const email = String(row.customerEmail ?? "").trim().toLowerCase();
    const customer = customerByEmail.get(email);
    const enrichment = enrichCustomerProfile(customer);
    return {
      ...row,
      businessName: row.businessName || resolveBusinessName(customer).businessName,
      stateCode: enrichment.stateCode,
      stateName: enrichment.stateName,
      stateSource: enrichment.stateSource,
    };
  });
  const allRows = rows;
  rows = state ? allRows.filter((row) => row.stateCode === state) : allRows;
  const payload = {
    page,
    limit,
    total: rows.length,
    rows: rows.slice(skip, skip + limit),
    state,
    stateOptions: buildStateOptions(allRows),
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

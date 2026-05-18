import { NextResponse } from "next/server";
import { isInRange, isRealSubscriptionRecord } from "@/lib/businessMetrics";
import { connectToDatabase } from "@/lib/mongodb";
import { Customer, type CustomerDocument, type CustomerProductJourneyItem } from "@/models/Customer";
import { Subscription, type SubscriptionDocument } from "@/models/Subscription";

function isBusinessBuilderProduct(name: string) {
  const normalized = name.toLowerCase();
  return normalized.includes("business builder") || normalized.includes("build your business credit");
}

function monthKey(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function recurringCandidates(customers: CustomerDocument[]) {
  return customers.flatMap((customer) => {
    const paidBusinessBuilder = (customer.productJourney ?? [])
      .filter((item: CustomerProductJourneyItem) => item.type === "paid" && isBusinessBuilderProduct(item.productName))
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    const paidMonths = Array.from(new Set(paidBusinessBuilder.map((item) => monthKey(item.date)).filter(Boolean)));
    if (paidMonths.length < 2) return [];
    const total = paidBusinessBuilder.reduce((sum, item) => sum + Number(item.amount ?? 0), 0);
    return [{
      customerName: customer.name,
      customerEmail: customer.email,
      product: paidBusinessBuilder[0]?.productName ?? "Business Builder",
      paidMonths: paidMonths.length,
      lastPaid: paidBusinessBuilder[0]?.date ?? customer.lastPaidDate ?? "",
      averageAmount: paidBusinessBuilder.length > 0 ? total / paidBusinessBuilder.length : 0,
      suggestedReview: "Review for recurring billing or subscription source connection.",
    }];
  }).sort((a, b) => new Date(b.lastPaid).getTime() - new Date(a.lastPaid).getTime());
}

export async function GET() {
  await connectToDatabase();
  const now = new Date();
  const next30 = new Date(now.getTime() + 30 * 86400000);
  const [subs, customers] = await Promise.all([
    Subscription.find({ status: "active", isPlaceholder: { $ne: true }, sourceStatus: "real", recordType: "subscription" }).sort({ nextBillingDate: 1 }).lean<SubscriptionDocument[]>(),
    Customer.find({ paidOrderCount: { $gt: 1 } }, { name: 1, email: 1, productJourney: 1, lastPaidDate: 1 }).lean<CustomerDocument[]>(),
  ]);
  const rows = subs.filter((sub) => isRealSubscriptionRecord(sub) && isInRange(sub.nextBillingDate ?? "", now, next30));
  const highRisk = rows.filter((r) => (r.failedPaymentCount ?? 0) > 0 || r.status === "pending" || r.status === "past_due");
  return NextResponse.json({
    rows,
    recurringCandidates: recurringCandidates(customers),
    highRiskCount: highRisk.length,
    estimatedUpcomingRevenue: rows.reduce((a, r) => a + (r.amount ?? 0), 0),
    message: rows.length === 0 ? "No active subscriptions with a next billing date are available yet. Import orders and connect subscription source data to populate this tab." : "",
  });
}

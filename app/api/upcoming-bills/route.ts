import { NextResponse } from "next/server";
import { isInRange, isRealSubscriptionRecord } from "@/lib/businessMetrics";
import { connectToDatabase } from "@/lib/mongodb";
import { Subscription, type SubscriptionDocument } from "@/models/Subscription";

export async function GET() {
  await connectToDatabase();
  const now = new Date();
  const next30 = new Date(now.getTime() + 30 * 86400000);
  const subs = await Subscription.find({ status: "active", isPlaceholder: { $ne: true }, sourceStatus: "real", recordType: "subscription" }).sort({ nextBillingDate: 1 }).lean<SubscriptionDocument[]>();
  const rows = subs.filter((sub) => isRealSubscriptionRecord(sub) && isInRange(sub.nextBillingDate ?? "", now, next30));
  const highRisk = rows.filter((r) => (r.failedPaymentCount ?? 0) > 0 || r.status === "pending" || r.status === "past_due");
  return NextResponse.json({
    rows,
    highRiskCount: highRisk.length,
    estimatedUpcomingRevenue: rows.reduce((a, r) => a + (r.amount ?? 0), 0),
    message: rows.length === 0 ? "No next billing date available for active subscriptions." : "",
  });
}

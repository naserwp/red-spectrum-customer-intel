import { NextResponse } from "next/server";
import { connectToDatabase } from "@/lib/mongodb";
import { Subscription } from "@/models/Subscription";

export async function GET() {
  await connectToDatabase();
  const now = new Date();
  const next30 = new Date(now.getTime() + 30 * 86400000);
  const rows = await Subscription.find({ nextBillingDate: { $gte: now.toISOString(), $lte: next30.toISOString() } }).sort({ nextBillingDate: 1 }).lean();
  const highRisk = rows.filter((r) => (r.failedPaymentCount ?? 0) > 0 || r.status === "pending" || r.status === "past_due");
  return NextResponse.json({ rows, highRiskCount: highRisk.length, estimatedUpcomingRevenue: rows.reduce((a, r) => a + (r.amount ?? 0), 0) });
}

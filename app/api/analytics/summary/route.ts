import { NextResponse } from "next/server";
import { connectToDatabase } from "@/lib/mongodb";
import { Customer } from "@/models/Customer";
import { Subscription } from "@/models/Subscription";

export async function GET() {
  await connectToDatabase();
  const [customers, subs] = await Promise.all([Customer.find({}).lean(), Subscription.find({}).lean()]);
  const now = new Date();
  const days = (n: number) => new Date(now.getTime() + n * 86400000);
  const dueIn = (d: string, n: number) => d && new Date(d) >= now && new Date(d) <= days(n);
  const activeSubs = subs.filter((s) => s.status === "active");
  const failedSubs = subs.filter((s) => (s.failedPaymentCount ?? 0) > 0 || s.lastPaymentStatus === "failed");
  const pendingSubs = subs.filter((s) => s.status === "pending" || s.status === "past_due");
  const upcomingActiveSubs30d = activeSubs.filter((s) => dueIn(s.nextBillingDate ?? "", 30));
  const mrr = activeSubs.reduce((a, s) => a + (s.monthlyRecurringRevenue ?? s.amount ?? 0), 0);
  const sourceBreakdown = ["woocommerce","stripe","authorize_net","nmi","manual"].reduce<Record<string, number>>((acc, source) => {
    acc[source] = subs.filter((s) => s.source === source).reduce((a, s) => a + (s.amount ?? 0), 0); return acc;
  }, {});
  return NextResponse.json({
    customerCount: customers.length,
    totalRevenue: customers.reduce((a, c) => a + (c.paidTotal ?? c.totalPaid ?? 0), 0),
    paidRevenue: customers.reduce((a, c) => a + (c.paidTotal ?? c.totalPaid ?? 0), 0),
    attemptedRevenue: customers.reduce((a, c) => a + (c.attemptedTotal ?? 0), 0),
    totalSubscriptions: subs.length,
    activeSubscriptions: activeSubs.length,
    inactiveSubscriptions: subs.filter((s) => s.status === "inactive" || s.status === "canceled").length,
    pendingSubscriptions: pendingSubs.length,
    failedPayments: failedSubs.length,
    upcomingBills7d: subs.filter((s) => dueIn(s.nextBillingDate ?? "", 7)).length,
    upcomingBills30d: upcomingActiveSubs30d.length,
    estimatedUpcomingRevenue30d: upcomingActiveSubs30d.reduce((a, s) => a + (s.amount ?? 0), 0),
    monthlyRecurringRevenue: mrr,
    sourceBreakdown,
  });
}

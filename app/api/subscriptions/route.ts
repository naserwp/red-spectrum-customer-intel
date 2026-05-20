import { NextResponse } from "next/server";
import { cachedJson } from "@/lib/apiCache";
import { readAnalyticsSnapshot } from "@/lib/analyticsCache";
import { connectToDatabase } from "@/lib/mongodb";
import { Subscription } from "@/models/Subscription";
import { WooCommerceSubscriptionRecord, type WooCommerceSubscriptionDocument } from "@/models/WooCommerceSubscription";

type LeanWooSubscription = WooCommerceSubscriptionDocument & { _id: unknown };

export async function GET(request: Request) {
  await connectToDatabase();
  const { searchParams } = new URL(request.url);
  const page = Math.max(1, Number(searchParams.get("page") ?? 1));
  const limit = Math.min(100, Math.max(1, Number(searchParams.get("limit") ?? 20)));
  const source = searchParams.get("source") ?? "";
  const status = searchParams.get("status") ?? "";
  const kind = searchParams.get("kind") ?? "real";
  const search = (searchParams.get("q") ?? "").trim();
  const dashboard = searchParams.get("dashboard") === "1";
  if (dashboard) {
    return cachedJson(`subscriptions-dashboard:${page}:${limit}:${search}`, async () => {
      const [total, activeWooSubscriptions, activeWooMrr, snapshot, records, candidateRows] = await Promise.all([
        WooCommerceSubscriptionRecord.countDocuments({}),
        WooCommerceSubscriptionRecord.countDocuments({ status: "active" }),
        WooCommerceSubscriptionRecord.aggregate<{ _id: null; mrr: number }>([
          { $match: { status: "active" } },
          { $group: { _id: null, mrr: { $sum: { $ifNull: ["$recurringTotal", "$amount"] } } } },
        ]),
        readAnalyticsSnapshot<Record<string, unknown>>("dashboard_analytics", {}),
        WooCommerceSubscriptionRecord.find(search ? { $or: [{ customerName: { $regex: search, $options: "i" } }, { customerEmail: { $regex: search, $options: "i" } }, { subscriptionNumber: { $regex: search, $options: "i" } }] } : {}).sort({ nextPaymentDate: 1 }).skip((page - 1) * limit).limit(limit).lean<LeanWooSubscription[]>(),
        Subscription.find({ isPlaceholder: { $ne: true }, recordType: "subscription_candidate" }).sort({ nextBillingDate: 1 }).limit(limit).lean(),
      ]);
      const rows = records.map((record) => ({
        _id: String(record._id),
        subscriptionId: String(record.wooSubscriptionId),
        subscriptionNumber: record.subscriptionNumber,
        source: "woocommerce",
        customerEmail: record.customerEmail,
        customerName: record.customerName,
        customerPhone: record.customerPhone,
        status: record.status,
        amount: record.recurringTotal || record.amount,
        monthlyRecurringRevenue: record.status === "active" ? (record.recurringTotal || record.amount) : 0,
        billingInterval: [record.billingInterval, record.billingPeriod].filter(Boolean).join(" "),
        nextBillingDate: record.nextPaymentDate,
        lastBillingDate: record.lastPaymentDate,
        startDate: record.startDate,
        paymentMethodTitle: record.paymentMethodTitle || record.paymentMethod,
        productNames: record.productNames,
        sourceStatus: "real",
        recordType: "subscription",
      }));
      return {
        page,
        limit,
        total,
        rows,
        candidateRows,
        summary: {
          totalSubscriptions: Number(snapshot.totalSubscriptions ?? total),
          activeWooSubscriptions: Number(snapshot.activeWooSubscriptions ?? activeWooSubscriptions),
          activeGatewayRecurringCustomers: Number(snapshot.activeGatewayRecurringCustomers ?? 0),
          totalActiveRecurringCustomers: Number(snapshot.totalActiveRecurringCustomers ?? activeWooSubscriptions),
          activeSubscriptions: Number(snapshot.totalActiveRecurringCustomers ?? activeWooSubscriptions),
          monthlyRecurringRevenue: Number(snapshot.totalMonthlyRecurringRevenue ?? snapshot.activeMRR ?? activeWooMrr[0]?.mrr ?? 0),
          totalMonthlyRecurringRevenue: Number(snapshot.totalMonthlyRecurringRevenue ?? snapshot.activeMRR ?? activeWooMrr[0]?.mrr ?? 0),
          subscriptionCandidates: candidateRows.length,
          analyticsCacheReady: Boolean(snapshot.analyticsCacheReady),
        },
      };
    });
  }
  const q: Record<string, unknown> = {};
  if (kind === "real") {
    if (source && source !== "woocommerce") return NextResponse.json({ page, limit, total: 0, rows: [] });
    if (status) q.status = status;
    const wooQuery: Record<string, unknown> = {};
    if (status) wooQuery.status = status;
    if (search) wooQuery.$or = [{ customerName: { $regex: search, $options: "i" } }, { customerEmail: { $regex: search, $options: "i" } }, { subscriptionNumber: { $regex: search, $options: "i" } }];
    const [total, records] = await Promise.all([
      WooCommerceSubscriptionRecord.countDocuments(wooQuery),
      WooCommerceSubscriptionRecord.find(wooQuery).sort({ nextPaymentDate: 1 }).skip((page - 1) * limit).limit(limit).lean<LeanWooSubscription[]>(),
    ]);
    const rows = records.map((record) => ({
      _id: String(record._id),
      subscriptionId: String(record.wooSubscriptionId),
      subscriptionNumber: record.subscriptionNumber,
      source: "woocommerce",
      customerEmail: record.customerEmail,
      customerName: record.customerName,
      customerPhone: record.customerPhone,
      status: record.status,
      amount: record.recurringTotal || record.amount,
      monthlyRecurringRevenue: record.status === "active" ? (record.recurringTotal || record.amount) : 0,
      billingInterval: [record.billingInterval, record.billingPeriod].filter(Boolean).join(" "),
      nextBillingDate: record.nextPaymentDate,
      lastBillingDate: record.lastPaymentDate,
      startDate: record.startDate,
      paymentMethodTitle: record.paymentMethodTitle || record.paymentMethod,
      productNames: record.productNames,
      sourceStatus: "real",
      recordType: "subscription",
    }));
    return NextResponse.json({ page, limit, total, rows });
  } else if (kind === "candidates") {
    q.isPlaceholder = { $ne: true };
    q.recordType = "subscription_candidate";
  } else if (kind === "all-real-data") {
    q.isPlaceholder = { $ne: true };
  }
  if (source) q.source = source;
  if (status) q.status = status;
  if (search) q.$or = [{ customerName: { $regex: search, $options: "i" } }, { customerEmail: { $regex: search, $options: "i" } }, { subscriptionId: { $regex: search, $options: "i" } }];
  const [total, rows] = await Promise.all([
    Subscription.countDocuments(q),
    Subscription.find(q).sort({ nextBillingDate: 1 }).skip((page - 1) * limit).limit(limit).lean(),
  ]);
  return NextResponse.json({ page, limit, total, rows });
}

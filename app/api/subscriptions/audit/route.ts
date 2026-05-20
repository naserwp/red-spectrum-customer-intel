import { NextResponse } from "next/server";
import { authorizeNetLedgerRecords, customerLedgerRecords, dedupePaidRecords, detectAuthorizeNetRecurring } from "@/lib/revenueAnalytics";
import { connectToDatabase } from "@/lib/mongodb";
import { AuthorizeNetTransaction, type AuthorizeNetTransactionDocument } from "@/models/AuthorizeNetTransaction";
import { Customer, type CustomerDocument } from "@/models/Customer";
import { WooCommerceOrderRecord, type WooCommerceOrderDocument } from "@/models/WooCommerceOrder";
import { WooCommerceSubscriptionRecord, type WooCommerceSubscriptionDocument } from "@/models/WooCommerceSubscription";

function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

export async function GET(request: Request) {
  const email = normalizeEmail(new URL(request.url).searchParams.get("email") ?? "");
  if (!email) return NextResponse.json({ error: "email is required" }, { status: 400 });
  await connectToDatabase();
  const [customer, wooSubscriptions, wooOrders, authTransactions] = await Promise.all([
    Customer.findOne({ $or: [{ normalizedEmail: email }, { emailNormalized: email }, { email }] }).lean<(CustomerDocument & { _id: unknown }) | null>(),
    WooCommerceSubscriptionRecord.find({ normalizedEmail: email }).lean<WooCommerceSubscriptionDocument[]>(),
    WooCommerceOrderRecord.find({ normalizedEmail: email }).lean<WooCommerceOrderDocument[]>(),
    AuthorizeNetTransaction.find({ $or: [{ normalizedEmail: email }, { emailNormalized: email }, { customerEmail: email }] }).lean<AuthorizeNetTransactionDocument[]>(),
  ]);
  const { records } = dedupePaidRecords([...(customer ? customerLedgerRecords(customer) : []), ...authorizeNetLedgerRecords(authTransactions)]);
  const recurring = detectAuthorizeNetRecurring(records);
  const activeWoo = wooSubscriptions.filter((subscription) => subscription.status === "active");
  const paidRenewalIds = new Set(wooSubscriptions.flatMap((subscription) => subscription.relatedOrderIds ?? []).map(String));
  const paidRenewalCount = wooOrders.filter((order) => order.isPaid && (paidRenewalIds.has(String(order.wooOrderId)) || paidRenewalIds.has(String(order.orderNumber)))).length;
  const failedRenewalCount = wooOrders.filter((order) => order.isAttempted && (paidRenewalIds.has(String(order.wooOrderId)) || paidRenewalIds.has(String(order.orderNumber)))).length;
  const estimatedMRR = activeWoo.reduce((sum, subscription) => sum + Number(subscription.recurringTotal ?? subscription.amount ?? 0), 0) + (recurring.isGatewayRecurring ? recurring.recurringAmount : 0);
  const lastPaymentDate = records.map((record) => record.date).filter(Boolean).sort().reverse()[0] ?? "";
  const rankingTotal = Math.max(records.reduce((sum, record) => sum + Number(record.amount ?? 0), 0), Number(customer?.lifetimeValue ?? customer?.paidTotal ?? customer?.totalPaid ?? 0));

  return NextResponse.json({
    email,
    wooActiveSubscriptions: activeWoo.length,
    authorizeNetRecurringDetected: recurring.isGatewayRecurring,
    recurringAmount: recurring.recurringAmount,
    recurringPaymentCount: recurring.recurringPaymentCount,
    nextEstimatedBilling: recurring.recurringNextEstimatedPayment || activeWoo[0]?.nextPaymentDate || "",
    lastPaymentDate,
    paidRenewalCount,
    failedRenewalCount,
    estimatedMRR,
    churnRisk: failedRenewalCount > 1 ? "high" : failedRenewalCount > 0 ? "medium" : "low",
    rankingTotal,
  });
}

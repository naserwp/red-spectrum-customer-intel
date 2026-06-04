import { NextResponse } from "next/server";
import { calculateCustomerValueMetrics } from "@/lib/customerValue";
import { isDeclinedOrFailed, isRefundedOrChargeback } from "@/lib/authorizeNet";
import { isNmiDeclined, isNmiRefundOrChargeback } from "@/lib/nmiQuickPay";
import { connectToDatabase } from "@/lib/mongodb";
import { AuthorizeNetTransaction, type AuthorizeNetTransactionDocument } from "@/models/AuthorizeNetTransaction";
import { Customer, type CustomerDocument } from "@/models/Customer";
import { NmiQuickPayTransaction, type NmiQuickPayTransactionDocument } from "@/models/NmiQuickPayTransaction";
import { WooCommerceOrderRecord, type WooCommerceOrderDocument } from "@/models/WooCommerceOrder";
import { WooCommerceSubscriptionRecord, type WooCommerceSubscriptionDocument } from "@/models/WooCommerceSubscription";

export const dynamic = "force-dynamic";

function normalizeEmail(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

function failedAuth(tx: Partial<AuthorizeNetTransactionDocument>) {
  return isDeclinedOrFailed(tx.transactionStatus ?? "");
}

function failedNmi(tx: Partial<NmiQuickPayTransactionDocument>) {
  return isNmiDeclined(tx.transactionStatus ?? "");
}

function lastDate(values: string[]) {
  return values.filter(Boolean).sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0] ?? "";
}

function auditBadge(metrics: ReturnType<typeof calculateCustomerValueMetrics>, auth: AuthorizeNetTransactionDocument[], nmi: NmiQuickPayTransactionDocument[]) {
  if (metrics.rankingTotal <= 0) return "No Paid History";
  if (!auth.length && !nmi.length && metrics.gatewayOnlyPaidTotal <= 0) return "Missing Gateway History";
  if (metrics.duplicateSkipped > 0) return "Possible Duplicate";
  if (metrics.refundsAndChargebacksDetected) return "Needs Review";
  return "Verified";
}

export async function GET(request: Request) {
  const started = Date.now();
  await connectToDatabase();
  const { searchParams } = new URL(request.url);
  const page = Math.max(1, Number(searchParams.get("page") ?? 1));
  const limit = Math.min(100, Math.max(1, Number(searchParams.get("limit") ?? 25)));
  const email = normalizeEmail(searchParams.get("email"));
  const query = email ? { $or: [{ normalizedEmail: email }, { emailNormalized: email }, { email }] } : {};
  const [total, customers] = await Promise.all([
    Customer.countDocuments(query),
    Customer.find(query).sort({ lifetimeValue: -1, rankingPaidTotal: -1 }).skip((page - 1) * limit).limit(limit).lean<Array<CustomerDocument & { _id: unknown }>>(),
  ]);
  const emails = customers.map((customer) => normalizeEmail(customer.normalizedEmail || customer.email)).filter(Boolean);
  const ids = customers.map((customer) => String(customer._id));
  const orderNumbers = customers.flatMap((customer) => (customer.orders ?? []).map((order) => order.orderNumber).filter(Boolean));
  const [wooOrders, authTransactions, nmiTransactions, subscriptions] = await Promise.all([
    emails.length || orderNumbers.length ? WooCommerceOrderRecord.find({ $or: [{ normalizedEmail: { $in: emails } }, ...(orderNumbers.length ? [{ orderNumber: { $in: orderNumbers } }] : [])] }).lean<WooCommerceOrderDocument[]>() : [],
    emails.length || ids.length || orderNumbers.length ? AuthorizeNetTransaction.find({ $or: [{ normalizedEmail: { $in: emails } }, { emailNormalized: { $in: emails } }, { customerEmail: { $in: emails } }, { matchedCustomerId: { $in: ids } }, ...(orderNumbers.length ? [{ invoiceNumber: { $in: orderNumbers } }] : [])] }).lean<AuthorizeNetTransactionDocument[]>() : [],
    emails.length || ids.length || orderNumbers.length ? NmiQuickPayTransaction.find({ $or: [{ normalizedEmail: { $in: emails } }, { emailNormalized: { $in: emails } }, { customerEmail: { $in: emails } }, { matchedCustomerId: { $in: ids } }, ...(orderNumbers.length ? [{ invoiceNumber: { $in: orderNumbers } }] : [])] }).lean<NmiQuickPayTransactionDocument[]>() : [],
    emails.length ? WooCommerceSubscriptionRecord.find({ normalizedEmail: { $in: emails } }).lean<WooCommerceSubscriptionDocument[]>() : [],
  ]);
  const rows = customers.map((customer) => {
    const customerEmail = normalizeEmail(customer.normalizedEmail || customer.email);
    const customerId = String(customer._id);
    const customerOrderNumbers = new Set((customer.orders ?? []).map((order) => order.orderNumber).filter(Boolean));
    const woo = wooOrders.filter((order) => normalizeEmail(order.normalizedEmail) === customerEmail || customerOrderNumbers.has(order.orderNumber));
    const auth = authTransactions.filter((tx) => [tx.normalizedEmail, tx.emailNormalized, tx.customerEmail].map(normalizeEmail).includes(customerEmail) || tx.matchedCustomerId === customerId || customerOrderNumbers.has(tx.invoiceNumber));
    const nmi = nmiTransactions.filter((tx) => [tx.normalizedEmail, tx.emailNormalized, tx.customerEmail].map(normalizeEmail).includes(customerEmail) || tx.matchedCustomerId === customerId || customerOrderNumbers.has(tx.invoiceNumber));
    const subs = subscriptions.filter((sub) => normalizeEmail(sub.normalizedEmail || sub.customerEmail) === customerEmail);
    const metrics = calculateCustomerValueMetrics({ customer, wooOrders: woo, authorizeNetTransactions: auth, nmiTransactions: nmi, subscriptions: subs });
    const refundTotal = Math.abs(auth.filter((tx) => isRefundedOrChargeback(tx.transactionStatus)).reduce((sum, tx) => sum + Number(tx.amount ?? 0), 0))
      + Math.abs(nmi.filter((tx) => isNmiRefundOrChargeback(tx.transactionStatus)).reduce((sum, tx) => sum + Number(tx.amount ?? 0), 0));
    const failedDates = [
      ...auth.filter(failedAuth).map((tx) => tx.submittedAt),
      ...nmi.filter(failedNmi).map((tx) => tx.submittedAt),
      ...(customer.orders ?? []).filter((order) => order.status === "failed").map((order) => order.dateCreated),
    ];
    return {
      customerId,
      name: customer.name,
      email: customer.email,
      wooCommerceTotal: metrics.wooPaidTotal,
      authorizeNetTotal: metrics.authorizeNetPaidTotal,
      nmiTotal: metrics.nmiQuickPayPaidTotal,
      gatewayOnlyTotal: metrics.gatewayOnlyPaidTotal,
      subscriptionTotal: metrics.subscriptionPaidTotal,
      refundTotal,
      chargebackTotal: Math.max(0, Number(customer.chargebacks ?? 0)),
      finalLifetimeValue: metrics.rankingTotal,
      paymentCount: Number(customer.paidOrderCount ?? 0) + auth.length + nmi.length,
      failedPaymentCount: Number(customer.failedPayments ?? 0) + auth.filter(failedAuth).length + nmi.filter(failedNmi).length,
      lastSuccessfulPaymentDate: metrics.lastPaidDate,
      lastFailedPaymentDate: lastDate(failedDates),
      duplicateSkipped: metrics.duplicateSkipped,
      dataConfidenceStatus: auditBadge(metrics, auth, nmi),
    };
  });
  return NextResponse.json({ page, limit, total, rows, totalMs: Date.now() - started });
}

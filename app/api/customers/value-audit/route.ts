import { NextResponse } from "next/server";
import { calculateCustomerValueMetrics } from "@/lib/customerValue";
import { connectToDatabase } from "@/lib/mongodb";
import { AuthorizeNetTransaction, type AuthorizeNetTransactionDocument } from "@/models/AuthorizeNetTransaction";
import { Customer, type CustomerDocument } from "@/models/Customer";
import { WooCommerceOrderRecord, type WooCommerceOrderDocument } from "@/models/WooCommerceOrder";
import { WooCommerceSubscriptionRecord, type WooCommerceSubscriptionDocument } from "@/models/WooCommerceSubscription";
import { NmiQuickPayTransaction, type NmiQuickPayTransactionDocument } from "@/models/NmiQuickPayTransaction";

export const dynamic = "force-dynamic";

function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const email = normalizeEmail(searchParams.get("email") ?? "");
  if (!email) return NextResponse.json({ error: "email is required" }, { status: 400 });

  await connectToDatabase();
  const customer = await Customer.findOne({
    $or: [{ normalizedEmail: email }, { emailNormalized: email }, { email }],
  }).lean<(CustomerDocument & { _id: unknown }) | null>().exec();

  const orderNumbers = (customer?.orders ?? []).map((order) => order.orderNumber).filter(Boolean);
  const [wooOrders, authorizeNetTransactions, nmiTransactions, subscriptions] = await Promise.all([
    WooCommerceOrderRecord.find({
      $or: [
        { normalizedEmail: email },
        ...(orderNumbers.length ? [{ orderNumber: { $in: orderNumbers } }] : []),
      ],
    }).lean<WooCommerceOrderDocument[]>(),
    AuthorizeNetTransaction.find({
      $or: [
        { normalizedEmail: email },
        { emailNormalized: email },
        { customerEmail: email },
        ...(customer?._id ? [{ matchedCustomerId: String(customer._id) }] : []),
        ...(orderNumbers.length ? [{ invoiceNumber: { $in: orderNumbers } }] : []),
      ],
    }).lean<AuthorizeNetTransactionDocument[]>(),
    NmiQuickPayTransaction.find({
      $or: [
        { normalizedEmail: email },
        { emailNormalized: email },
        { customerEmail: email },
        ...(customer?._id ? [{ matchedCustomerId: String(customer._id) }] : []),
        ...(orderNumbers.length ? [{ invoiceNumber: { $in: orderNumbers } }] : []),
      ],
    }).lean<NmiQuickPayTransactionDocument[]>(),
    WooCommerceSubscriptionRecord.find({ normalizedEmail: email }).lean<WooCommerceSubscriptionDocument[]>(),
  ]);

  const metrics = calculateCustomerValueMetrics({ customer, wooOrders, authorizeNetTransactions, nmiTransactions, subscriptions });
  return NextResponse.json({
    email,
    customerFound: Boolean(customer),
    wooPaidTotal: metrics.wooPaidTotal,
    authorizeNetPaidTotal: metrics.authorizeNetPaidTotal,
    gatewayOnlyPaidTotal: metrics.gatewayOnlyPaidTotal,
    nmiQuickPayPaidTotal: metrics.nmiQuickPayPaidTotal,
    subscriptionPaidTotal: metrics.subscriptionPaidTotal,
    attemptedTotal: metrics.attemptedTotal,
    duplicateSkipped: metrics.duplicateSkipped,
    firstPaidDate: metrics.firstPaidDate,
    lastPaidDate: metrics.lastPaidDate,
    paidMonths: metrics.paidMonths,
    activeSubscriptionStatus: metrics.activeSubscriptionStatus,
    rankingTotal: metrics.rankingTotal,
    subscriptionStartDate: metrics.subscriptionStartDate,
    stayWithUsMonths: metrics.stayWithUsMonths,
    sourceCounts: {
      customerOrders: customer?.orders?.length ?? 0,
      gatewayPayments: customer?.gatewayPayments?.length ?? 0,
      wooOrders: wooOrders.length,
      authorizeNetTransactions: authorizeNetTransactions.length,
      nmiQuickPayTransactions: nmiTransactions.length,
      subscriptions: subscriptions.length,
    },
  });
}

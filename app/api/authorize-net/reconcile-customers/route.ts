import { NextResponse } from "next/server";
import { isDeclinedOrFailed, isSettledSuccessful } from "@/lib/authorizeNet";
import { connectToDatabase } from "@/lib/mongodb";
import { normalizePhone } from "@/lib/wooOrderImport";
import { AuthorizeNetTransaction, type AuthorizeNetTransactionDocument } from "@/models/AuthorizeNetTransaction";
import { Customer, type CustomerDocument, type CustomerGatewayPayment, type CustomerOrderHistoryItem } from "@/models/Customer";
import { WooCommerceOrderRecord, type WooCommerceOrderDocument } from "@/models/WooCommerceOrder";

export const dynamic = "force-dynamic";

const runtimeBudgetMs = 8000;

type LeanCustomer = CustomerDocument & { _id: unknown };

function safeNumber(value: unknown, fallback: number, max: number) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.min(max, Math.floor(parsed));
}

function gatewayVerification(transaction: AuthorizeNetTransactionDocument, matchedBy: string, confidence: CustomerOrderHistoryItem["gatewayVerification"]["confidence"]) {
  return {
    provider: "authorize_net",
    matched: confidence !== "not_found",
    confidence,
    matchedBy,
    transactionId: transaction.transactionId,
    transactionStatus: transaction.transactionStatus,
    amount: transaction.amount,
    transactionDate: transaction.settledAt || transaction.submittedAt,
    customerVaultId: "",
    paymentProfileId: transaction.customerPaymentProfileId,
    customerProfileId: transaction.customerProfileId,
    paymentIntentId: "",
    chargeId: "",
    stripeCustomerId: "",
    paymentMethodId: "",
    last4: transaction.cardLast4,
    cardType: transaction.cardType,
    candidatesCount: 1,
    rawSummary: `${transaction.transactionStatus} ${transaction.invoiceNumber}`.trim(),
    lastCheckedAt: new Date().toISOString(),
    configured: true,
    notes: "Matched from imported Authorize.net transaction.",
  };
}

function gatewayPayment(transaction: AuthorizeNetTransactionDocument, matchedBy: string, confidence: string, source: string): CustomerGatewayPayment {
  return {
    date: transaction.settledAt || transaction.submittedAt,
    provider: "authorize_net",
    transactionId: transaction.transactionId,
    invoiceNumber: transaction.invoiceNumber,
    status: transaction.transactionStatus,
    amount: transaction.amount,
    cardLast4: transaction.cardLast4,
    matchedBy,
    matchConfidence: confidence,
    source,
  };
}

function syntheticOrder(transaction: AuthorizeNetTransactionDocument, matchedBy: string, confidence: CustomerOrderHistoryItem["gatewayVerification"]["confidence"]): CustomerOrderHistoryItem {
  const settled = isSettledSuccessful(transaction.transactionStatus);
  return {
    orderId: `authorize-net-${transaction.transactionId}`,
    orderNumber: transaction.invoiceNumber || transaction.transactionId,
    customerId: 0,
    status: settled ? "paid" : isDeclinedOrFailed(transaction.transactionStatus) ? "failed" : "attempted",
    dateCreated: transaction.submittedAt || transaction.settledAt,
    dateModified: transaction.settledAt || transaction.submittedAt,
    total: transaction.amount,
    currency: transaction.currency || "USD",
    paymentMethod: "authorize_net",
    paymentMethodTitle: "Authorize.net",
    transactionId: transaction.transactionId,
    paidDate: settled ? transaction.settledAt || transaction.submittedAt : "",
    attemptedDate: settled ? "" : transaction.submittedAt,
    isPaid: settled,
    isAttempted: !settled,
    billingName: transaction.customerName,
    billingEmail: transaction.normalizedEmail || transaction.customerEmail,
    billingPhone: transaction.billingPhone,
    billingFirstName: transaction.billingFirstName,
    billingLastName: transaction.billingLastName,
    billingCompany: transaction.billingCompany,
    billingAddress: { address1: "", address2: "", city: "", state: "", postcode: "", country: "" },
    lineItems: [],
    products: [],
    refundsCount: 0,
    refundsAmount: 0,
    metaData: [],
    customerNote: "",
    checkoutSource: "authorize_net",
    source: "authorize_net_only",
    matchedBy: [matchedBy],
    matchConfidence: confidence,
    gatewayVerification: gatewayVerification(transaction, matchedBy, confidence),
  };
}

async function findMatch(transaction: AuthorizeNetTransactionDocument) {
  const invoiceNumber = transaction.invoiceNumber.trim();
  if (invoiceNumber) {
    const wooOrder = await WooCommerceOrderRecord.findOne({ orderNumber: invoiceNumber }).lean<WooCommerceOrderDocument | null>().exec();
    if (wooOrder?.normalizedEmail) {
      const customer = await Customer.findOne({ $or: [{ normalizedEmail: wooOrder.normalizedEmail }, { email: wooOrder.normalizedEmail }] }).lean<LeanCustomer | null>().exec();
      if (customer) return { customer, matchedBy: "invoiceNumber", confidence: "exact" as const, wooOrderNumberMatched: invoiceNumber, wooOrderIdMatched: Number(wooOrder.wooOrderId ?? 0) };
    }
    const customer = await Customer.findOne({ "orders.orderNumber": invoiceNumber }).lean<LeanCustomer | null>().exec();
    if (customer) return { customer, matchedBy: "invoiceNumber", confidence: "exact" as const, wooOrderNumberMatched: invoiceNumber, wooOrderIdMatched: 0 };
  }
  if (transaction.normalizedEmail) {
    const customer = await Customer.findOne({ $or: [{ normalizedEmail: transaction.normalizedEmail }, { email: transaction.normalizedEmail }] }).lean<LeanCustomer | null>().exec();
    if (customer) return { customer, matchedBy: "normalizedEmail", confidence: "high" as const, wooOrderNumberMatched: "", wooOrderIdMatched: 0 };
  }
  if (transaction.billingPhone) {
    const phone = normalizePhone(transaction.billingPhone);
    const customer = await Customer.findOne({ phone: { $regex: phone.slice(-7), $options: "i" } }).lean<LeanCustomer | null>().exec();
    if (customer) return { customer, matchedBy: "phone", confidence: "medium" as const, wooOrderNumberMatched: "", wooOrderIdMatched: 0 };
  }
  if (transaction.customerName && transaction.amount > 0) {
    const parts = transaction.customerName.split(/\s+/).filter(Boolean);
    const customer = await Customer.findOne({ name: { $regex: parts.join(".*"), $options: "i" }, orders: { $elemMatch: { total: transaction.amount } } }).lean<LeanCustomer | null>().exec();
    if (customer) return { customer, matchedBy: "name_amount_date", confidence: "low" as const, wooOrderNumberMatched: "", wooOrderIdMatched: 0 };
  }
  return { customer: null, matchedBy: "", confidence: "not_found" as const, wooOrderNumberMatched: "", wooOrderIdMatched: 0 };
}

function reconcileCustomer(customer: LeanCustomer, transaction: AuthorizeNetTransactionDocument, matchedBy: string, confidence: CustomerOrderHistoryItem["gatewayVerification"]["confidence"]) {
  const orders = [...(customer.orders ?? [])];
  const gatewayPayments = [...(customer.gatewayPayments ?? [])];
  const alreadyHasGatewayPayment = gatewayPayments.some((payment) => payment.transactionId === transaction.transactionId);
  const orderIndex = orders.findIndex((order) => order.orderNumber === transaction.invoiceNumber || order.transactionId === transaction.transactionId);
  const settled = isSettledSuccessful(transaction.transactionStatus);
  let countedNewPaid = false;
  let source = "authorize_net_reconciled";

  if (orderIndex >= 0) {
    const existing = orders[orderIndex];
    const wasPaid = Boolean(existing.isPaid);
    orders[orderIndex] = {
      ...existing,
      status: settled ? "paid" : isDeclinedOrFailed(transaction.transactionStatus) ? "failed" : existing.status,
      transactionId: transaction.transactionId || existing.transactionId,
      isPaid: settled || existing.isPaid,
      isAttempted: settled ? false : existing.isAttempted,
      paidDate: settled ? transaction.settledAt || transaction.submittedAt : existing.paidDate,
      paymentMethod: "authorize_net",
      paymentMethodTitle: "Authorize.net",
      gatewayVerification: gatewayVerification(transaction, matchedBy, confidence),
    };
    countedNewPaid = settled && !wasPaid && !alreadyHasGatewayPayment;
  } else {
    source = "authorize_net_only";
    orders.unshift(syntheticOrder(transaction, matchedBy, confidence));
    countedNewPaid = settled && !alreadyHasGatewayPayment;
  }

  if (!alreadyHasGatewayPayment) gatewayPayments.unshift(gatewayPayment(transaction, matchedBy, confidence, source));

  const paidIncrement = countedNewPaid ? transaction.amount : 0;
  const paidTotal = Number(customer.paidTotal ?? customer.totalPaid ?? 0) + paidIncrement;
  const paidOrderCount = Number(customer.paidOrderCount ?? 0) + (countedNewPaid ? 1 : 0);
  const lastPaidDate = settled && (transaction.settledAt || transaction.submittedAt) > (customer.lastPaidDate ?? "") ? transaction.settledAt || transaction.submittedAt : customer.lastPaidDate;
  return {
    orders,
    gatewayPayments,
    paidTotal,
    totalPaid: paidTotal,
    paidOrderCount,
    orderCount: orders.length,
    lastPaidDate,
    lastOrderDate: orders[0]?.dateCreated ?? customer.lastOrderDate,
    paymentStatus: paidTotal > 0 ? "paid" : customer.paymentStatus,
    leadStatus: paidTotal > 0 ? "customer" : customer.leadStatus,
    gatewayVerification: gatewayVerification(transaction, matchedBy, confidence),
    lastPaymentMethod: settled ? "Authorize.net" : customer.lastPaymentMethod,
    lastSyncedAt: new Date().toISOString(),
  };
}

export async function POST(request: Request) {
  const started = Date.now();
  const body = await request.json().catch(() => ({})) as { limit?: number; offset?: number; dryRun?: boolean };
  const limit = safeNumber(body.limit, 50, 100);
  const offset = safeNumber(body.offset, 0, 1000000);
  const dryRun = body.dryRun === true;
  await connectToDatabase();
  const transactions = await AuthorizeNetTransaction.find({}).sort({ submittedAt: -1 }).skip(offset).limit(limit).lean<AuthorizeNetTransactionDocument[]>().exec();
  const total = await AuthorizeNetTransaction.countDocuments({});
  const warnings: string[] = dryRun ? ["Dry run: no Customer records were written."] : [];
  let processed = 0;
  let matched = 0;
  let updated = 0;

  for (const transaction of transactions) {
    if (Date.now() - started > runtimeBudgetMs - 1000) {
      warnings.push(`Stopped Authorize.net reconciliation batch at ${processed} processed transactions to stay within runtime budget.`);
      break;
    }
    processed += 1;
    const match = await findMatch(transaction);
    if (!match.customer) continue;
    matched += 1;
    if (!dryRun) {
      const updates = reconcileCustomer(match.customer, transaction, match.matchedBy, match.confidence);
      await Customer.updateOne({ _id: match.customer._id }, { $set: updates }).exec();
      await AuthorizeNetTransaction.updateOne(
        { transactionId: transaction.transactionId },
        { $set: { matchedCustomerId: String(match.customer._id), matchedBy: match.matchedBy, matchConfidence: match.confidence, wooOrderNumberMatched: match.wooOrderNumberMatched, wooOrderIdMatched: match.wooOrderIdMatched } }
      ).exec();
      updated += 1;
    }
  }

  const nextOffset = offset + processed;
  const hasMore = nextOffset < total || warnings.some((warning) => warning.includes("runtime budget"));
  return NextResponse.json({
    dryRun,
    transactionsProcessed: processed,
    transactionsMatched: matched,
    customersUpdated: dryRun ? 0 : updated,
    hasMore,
    nextOffset,
    warnings,
    message: hasMore ? `Processed ${processed} Authorize.net transactions. Continue reconciliation to process next batch.` : `Processed ${processed} Authorize.net transactions. Reconciliation batch is complete.`,
  });
}

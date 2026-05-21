import { calculateCustomerValueMetrics } from "@/lib/customerValue";
import { isNmiDeclined, isNmiRefundOrChargeback, isNmiSuccessful, normalizeNmiPhone } from "@/lib/nmiQuickPay";
import { monthsSince } from "@/lib/customerValue";
import { customerLedgerRecords, detectAuthorizeNetRecurring } from "@/lib/revenueAnalytics";
import { Customer, type CustomerDocument, type CustomerGatewayPayment, type CustomerOrderHistoryItem, type CustomerProductJourneyItem } from "@/models/Customer";
import { NmiQuickPayTransaction, type NmiQuickPayTransactionDocument } from "@/models/NmiQuickPayTransaction";
import { WooCommerceOrderRecord, type WooCommerceOrderDocument } from "@/models/WooCommerceOrder";

export type LeanCustomer = CustomerDocument & { _id: unknown };

export type NmiReconcileResult = {
  matched: boolean;
  updated: boolean;
  attachedGatewayOnly: boolean;
  verifiedWooOrder: boolean;
  skippedDuplicate: boolean;
  matchedBy: string;
  matchConfidence: "exact" | "high" | "medium" | "low" | "not_found";
  customerId?: string;
};

function transactionDate(transaction: NmiQuickPayTransactionDocument) {
  return transaction.settledAt || transaction.submittedAt;
}

function productName(transaction: NmiQuickPayTransactionDocument) {
  return transaction.description?.trim() || "NMI Quick Pay";
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sameDay(a?: string, b?: string) {
  if (!a || !b) return false;
  return a.slice(0, 10) === b.slice(0, 10);
}

function duplicatePayment(customer: LeanCustomer, transaction: NmiQuickPayTransactionDocument) {
  const date = transactionDate(transaction);
  return (customer.gatewayPayments ?? []).some((payment) => (payment.provider === "nmi" || payment.provider === "nmi_quick_pay") && (
    payment.transactionId === transaction.transactionId ||
    (payment.invoiceNumber && payment.invoiceNumber === transaction.invoiceNumber && Number(payment.amount) === Number(transaction.amount) && sameDay(payment.date, date))
  )) || (customer.orders ?? []).some((order) => (
    order.transactionId === transaction.transactionId ||
    (transaction.invoiceNumber && order.orderNumber === transaction.invoiceNumber && Number(order.total) === Number(transaction.amount) && sameDay(order.dateCreated, date))
  ));
}

function gatewayVerification(transaction: NmiQuickPayTransactionDocument, matchedBy: string, confidence: CustomerOrderHistoryItem["gatewayVerification"]["confidence"]) {
  return {
    provider: "nmi",
    matched: confidence !== "not_found",
    confidence,
    matchedBy,
    transactionId: transaction.transactionId,
    transactionStatus: transaction.transactionStatus,
    amount: transaction.amount,
    transactionDate: transactionDate(transaction),
    customerVaultId: transaction.customerVaultId,
    paymentProfileId: transaction.customerPaymentProfileId,
    customerProfileId: transaction.customerVaultId,
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
    notes: "Matched from imported NMI Quick Pay transaction.",
  };
}

function gatewayPayment(transaction: NmiQuickPayTransactionDocument, matchedBy: string, confidence: string, source: string): CustomerGatewayPayment {
  return {
    date: transactionDate(transaction),
    provider: "nmi",
    transactionId: transaction.transactionId,
    invoiceNumber: transaction.invoiceNumber,
    status: transaction.transactionStatus,
    amount: transaction.amount,
    cardLast4: transaction.cardLast4,
    cardType: transaction.cardType,
    matchedBy,
    matchConfidence: confidence,
    source,
    customerProfileId: transaction.customerVaultId,
    customerPaymentProfileId: transaction.customerPaymentProfileId,
  };
}

function syntheticOrder(transaction: NmiQuickPayTransactionDocument, matchedBy: string, confidence: CustomerOrderHistoryItem["gatewayVerification"]["confidence"]): CustomerOrderHistoryItem {
  const paid = isNmiSuccessful(transaction.transactionStatus);
  const lineItem = {
    productId: 0,
    variationId: 0,
    name: productName(transaction),
    sku: "",
    quantity: 1,
    subtotal: transaction.amount,
    total: transaction.amount,
    price: transaction.amount,
  };
  return {
    orderId: `nmi-${transaction.transactionId}`,
    orderNumber: transaction.invoiceNumber || transaction.transactionId,
    customerId: 0,
    status: paid ? "paid" : isNmiDeclined(transaction.transactionStatus) ? "failed" : isNmiRefundOrChargeback(transaction.transactionStatus) ? "refunded" : "attempted",
    dateCreated: transaction.submittedAt || transaction.settledAt,
    dateModified: transactionDate(transaction),
    total: transaction.amount,
    currency: transaction.currency || "USD",
    paymentMethod: "nmi_quick_pay",
    paymentMethodTitle: "NMI Quick Pay",
    transactionId: transaction.transactionId,
    paidDate: paid ? transactionDate(transaction) : "",
    attemptedDate: paid ? "" : transaction.submittedAt,
    isPaid: paid,
    isAttempted: !paid,
    billingName: transaction.customerName,
    billingEmail: transaction.normalizedEmail || transaction.customerEmail,
    billingPhone: transaction.billingPhone,
    billingFirstName: transaction.billingFirstName,
    billingLastName: transaction.billingLastName,
    billingCompany: transaction.billingCompany,
    billingAddress: { address1: "", address2: "", city: "", state: "", postcode: "", country: "" },
    lineItems: [lineItem],
    products: [lineItem],
    refundsCount: isNmiRefundOrChargeback(transaction.transactionStatus) ? 1 : 0,
    refundsAmount: isNmiRefundOrChargeback(transaction.transactionStatus) ? transaction.amount : 0,
    metaData: [{ key: "cardLast4", value: transaction.cardLast4 }, { key: "source", value: "nmi_quick_pay_only" }].filter((item) => item.value),
    customerNote: "",
    checkoutSource: "nmi_quick_pay",
    source: "nmi_quick_pay_only",
    matchedBy: [matchedBy],
    matchConfidence: confidence,
    gatewayVerification: gatewayVerification(transaction, matchedBy, confidence),
  };
}

function productJourneyItem(transaction: NmiQuickPayTransactionDocument): CustomerProductJourneyItem {
  const paid = isNmiSuccessful(transaction.transactionStatus);
  return {
    date: transactionDate(transaction),
    orderNumber: transaction.invoiceNumber || transaction.transactionId,
    status: paid ? "paid" : isNmiDeclined(transaction.transactionStatus) ? "failed" : isNmiRefundOrChargeback(transaction.transactionStatus) ? "refunded" : "attempted",
    paymentMethod: "NMI Quick Pay",
    productName: productName(transaction),
    category: "other",
    productType: "NMI Quick Pay",
    amount: transaction.amount,
    type: paid ? "paid" : "attempted",
  };
}

export async function findNmiCustomerMatch(transaction: NmiQuickPayTransactionDocument) {
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
    const customer = await Customer.findOne({ $or: [{ normalizedEmail: transaction.normalizedEmail }, { emailNormalized: transaction.normalizedEmail }, { email: transaction.normalizedEmail }] }).lean<LeanCustomer | null>().exec();
    if (customer) return { customer, matchedBy: "normalizedEmail", confidence: "high" as const, wooOrderNumberMatched: "", wooOrderIdMatched: 0 };
  }
  const phone = normalizeNmiPhone(transaction.normalizedPhone || transaction.billingPhone);
  if (phone.length >= 7) {
    const customer = await Customer.findOne({ $or: [{ phoneNormalized: phone }, { phone: { $regex: escapeRegex(phone.slice(-7)), $options: "i" } }, { "orders.billingPhone": { $regex: escapeRegex(phone.slice(-7)), $options: "i" } }] }).lean<LeanCustomer | null>().exec();
    if (customer) return { customer, matchedBy: "phone", confidence: "medium" as const, wooOrderNumberMatched: "", wooOrderIdMatched: 0 };
  }
  if (transaction.customerVaultId || transaction.customerPaymentProfileId) {
    const profileConditions: Record<string, string>[] = [];
    if (transaction.customerVaultId) {
      profileConditions.push({ "gatewayPayments.customerProfileId": transaction.customerVaultId });
      profileConditions.push({ "orders.gatewayVerification.customerProfileId": transaction.customerVaultId });
    }
    if (transaction.customerPaymentProfileId) {
      profileConditions.push({ "gatewayPayments.customerPaymentProfileId": transaction.customerPaymentProfileId });
      profileConditions.push({ "orders.gatewayVerification.paymentProfileId": transaction.customerPaymentProfileId });
    }
    const customer = profileConditions.length ? await Customer.findOne({ $or: profileConditions }).lean<LeanCustomer | null>().exec() : null;
    if (customer) return { customer, matchedBy: "customerVaultId", confidence: "medium" as const, wooOrderNumberMatched: "", wooOrderIdMatched: 0 };
  }
  const nameParts = transaction.customerName.split(/\s+/).filter((part) => part.length > 1).slice(0, 4);
  if (nameParts.length >= 2) {
    const nameRegex = `^${nameParts.map(escapeRegex).join("\\s+")}`;
    const customer = await Customer.findOne({
      $or: [
        { name: { $regex: nameRegex, $options: "i" } },
        { "orders.billingName": { $regex: nameRegex, $options: "i" } },
        { "businessProfile.company": { $regex: escapeRegex(transaction.billingCompany), $options: "i" } },
      ],
    }).sort({ lifetimeValue: -1, paidTotal: -1 }).lean<LeanCustomer | null>().exec();
    if (customer) return { customer, matchedBy: "billing_name", confidence: "medium" as const, wooOrderNumberMatched: "", wooOrderIdMatched: 0 };
  }
  if (transaction.cardLast4 && transaction.amount > 0) {
    const customer = await Customer.findOne({ "gatewayPayments.cardLast4": transaction.cardLast4, "gatewayPayments.amount": transaction.amount }).lean<LeanCustomer | null>().exec();
    if (customer) return { customer, matchedBy: "card_last4_amount_date", confidence: "low" as const, wooOrderNumberMatched: "", wooOrderIdMatched: 0 };
  }
  return { customer: null, matchedBy: "", confidence: "not_found" as const, wooOrderNumberMatched: "", wooOrderIdMatched: 0 };
}

export function buildReconciledNmiCustomerUpdate(customer: LeanCustomer, transaction: NmiQuickPayTransactionDocument, matchedBy: string, confidence: CustomerOrderHistoryItem["gatewayVerification"]["confidence"]) {
  const orders = [...(customer.orders ?? [])];
  const gatewayPayments = [...(customer.gatewayPayments ?? [])];
  const productJourney = [...(customer.productJourney ?? [])];
  const paidProducts = [...(customer.paidProducts ?? [])];
  const attemptedProducts = [...(customer.attemptedProducts ?? [])];
  const alreadyDuplicate = duplicatePayment(customer, transaction);
  const orderIndex = orders.findIndex((order) => order.orderNumber === transaction.invoiceNumber || order.transactionId === transaction.transactionId);
  const paid = isNmiSuccessful(transaction.transactionStatus);
  let attachedGatewayOnly = false;
  let verifiedWooOrder = false;
  let source = "nmi_quick_pay_reconciled";

  if (orderIndex >= 0) {
    const existing = orders[orderIndex];
    const existingPaid = existing.isPaid || ["completed", "processing", "paid"].includes(String(existing.status ?? "").toLowerCase());
    verifiedWooOrder = true;
    orders[orderIndex] = {
      ...existing,
      status: paid ? "paid" : existingPaid ? existing.status : isNmiDeclined(transaction.transactionStatus) ? "failed" : isNmiRefundOrChargeback(transaction.transactionStatus) ? "refunded" : "attempted",
      transactionId: transaction.transactionId || existing.transactionId,
      isPaid: paid ? true : existingPaid,
      isAttempted: paid ? false : existingPaid ? false : true,
      paidDate: paid ? transactionDate(transaction) : existing.paidDate,
      attemptedDate: paid ? existing.attemptedDate : transaction.submittedAt || existing.attemptedDate,
      paymentMethod: "nmi_quick_pay",
      paymentMethodTitle: "NMI Quick Pay",
      gatewayVerification: gatewayVerification(transaction, matchedBy, confidence),
    };
  } else if (!alreadyDuplicate) {
    source = "nmi_quick_pay_only";
    attachedGatewayOnly = paid;
    orders.unshift(syntheticOrder(transaction, matchedBy, confidence));
    productJourney.unshift(productJourneyItem(transaction));
    if (paid) {
      if (!paidProducts.includes(productName(transaction))) paidProducts.unshift(productName(transaction));
    } else if (!attemptedProducts.includes(productName(transaction))) {
      attemptedProducts.unshift(productName(transaction));
    }
  }

  if (!gatewayPayments.some((payment) => payment.transactionId === transaction.transactionId)) {
    gatewayPayments.unshift(gatewayPayment(transaction, matchedBy, confidence, source));
  }

  const metrics = calculateCustomerValueMetrics({ customer: { ...customer, orders, gatewayPayments, productJourney }, nmiTransactions: [transaction] });
  const paidTotal = metrics.rankingTotal;
  const gatewayOnlyPaymentsAttached = orders.filter((order) => order.source === "authorize_net_only" || order.source === "nmi_quick_pay_only").length;
  const nmiTransactionsFound = gatewayPayments.filter((payment) => payment.provider === "nmi" || payment.provider === "nmi_quick_pay").length;
  const recurring = detectAuthorizeNetRecurring(customerLedgerRecords({ ...customer, orders, gatewayPayments }));
  const firstPaidDate = metrics.firstPaidDate || customer.firstPaidDate || customer.firstOrderDate || (paid ? transactionDate(transaction) : "");
  const sourceCoverage = {
    ...(customer.sourceCoverage ?? {}),
    ordersStored: orders.length,
    ordersStoredCount: orders.length,
    gatewayOnlyPaymentsAttached,
    reconciledRecords: gatewayPayments.length,
    nmiQuickPayTransactionsFound: nmiTransactionsFound,
    revenueCoveragePercent: paidTotal > 0 ? 100 : 0,
  };
  return {
    updates: {
      orders,
      gatewayPayments,
      productJourney,
      paidProducts,
      attemptedProducts,
      paidTotal,
      totalPaid: paidTotal,
      lifetimeValue: paidTotal,
      rankingPaidTotal: paidTotal,
      wooPaidTotal: metrics.wooPaidTotal,
      authorizeNetPaidTotal: metrics.authorizeNetPaidTotal,
      gatewayOnlyPaidTotal: metrics.gatewayOnlyPaidTotal,
      nmiQuickPayPaidTotal: metrics.nmiQuickPayPaidTotal,
      subscriptionPaidTotal: metrics.subscriptionPaidTotal,
      attemptedTotal: metrics.attemptedTotal,
      paidOrderCount: Math.max(Number(customer.paidOrderCount ?? 0), orders.filter((order) => order.isPaid).length),
      gatewayPaidCount: orders.filter((order) => (order.source === "authorize_net_only" || order.source === "nmi_quick_pay_only") && order.isPaid).length,
      attemptedOrderCount: Math.max(Number(customer.attemptedOrderCount ?? 0), orders.filter((order) => order.isAttempted).length),
      paidMonths: metrics.paidMonths,
      firstPaidDate,
      stayWithUsMonths: metrics.stayWithUsMonths || monthsSince(firstPaidDate),
      orderCount: orders.length,
      lastPaidDate: metrics.lastPaidDate || customer.lastPaidDate,
      lastOrderDate: orders[0]?.dateCreated ?? customer.lastOrderDate,
      paymentStatus: paidTotal > 0 ? "paid" : metrics.attemptedTotal > 0 ? "attempted_unpaid" : customer.paymentStatus,
      leadStatus: paidTotal > 0 ? "customer" : customer.leadStatus,
      gatewayVerification: gatewayVerification(transaction, matchedBy, confidence),
      lastPaymentMethod: paid ? "NMI Quick Pay" : customer.lastPaymentMethod,
      lastPurchasedProduct: attachedGatewayOnly && paid ? productName(transaction) : customer.lastPurchasedProduct,
      lastAttemptedProduct: !paid ? productName(transaction) : customer.lastAttemptedProduct,
      isGatewayRecurring: recurring.isGatewayRecurring,
      recurringSource: recurring.recurringSource,
      recurringAmount: recurring.recurringAmount,
      recurringFrequencyEstimate: recurring.recurringFrequencyEstimate,
      recurringLastPayment: recurring.recurringLastPayment,
      recurringNextEstimatedPayment: recurring.recurringNextEstimatedPayment,
      recurringPaymentCount: recurring.recurringPaymentCount,
      sourceCoverage,
      lastSyncedAt: new Date().toISOString(),
    },
    attachedGatewayOnly,
    verifiedWooOrder,
    skippedDuplicate: alreadyDuplicate,
  };
}

export async function reconcileNmiTransaction(transaction: NmiQuickPayTransactionDocument, dryRun = false): Promise<NmiReconcileResult> {
  const match = await findNmiCustomerMatch(transaction);
  if (!match.customer) return { matched: false, updated: false, attachedGatewayOnly: false, verifiedWooOrder: false, skippedDuplicate: false, matchedBy: "", matchConfidence: "not_found" };
  const { updates, attachedGatewayOnly, verifiedWooOrder, skippedDuplicate } = buildReconciledNmiCustomerUpdate(match.customer, transaction, match.matchedBy, match.confidence);
  if (!dryRun) {
    await Customer.updateOne({ _id: match.customer._id }, { $set: updates }).exec();
    await NmiQuickPayTransaction.updateOne(
      { transactionId: transaction.transactionId },
      { $set: { matchedCustomerId: String(match.customer._id), matchedBy: match.matchedBy, matchConfidence: match.confidence, wooOrderNumberMatched: match.wooOrderNumberMatched, wooOrderIdMatched: match.wooOrderIdMatched } }
    ).exec();
  }
  return {
    matched: true,
    updated: !dryRun,
    attachedGatewayOnly,
    verifiedWooOrder,
    skippedDuplicate,
    matchedBy: match.matchedBy,
    matchConfidence: match.confidence,
    customerId: String(match.customer._id),
  };
}

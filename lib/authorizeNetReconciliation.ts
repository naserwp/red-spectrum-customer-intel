import { isDeclinedOrFailed, isSettledSuccessful } from "@/lib/authorizeNet";
import { normalizePhone } from "@/lib/wooOrderImport";
import { AuthorizeNetTransaction, type AuthorizeNetTransactionDocument } from "@/models/AuthorizeNetTransaction";
import { Customer, type CustomerDocument, type CustomerGatewayPayment, type CustomerOrderHistoryItem, type CustomerProductJourneyItem } from "@/models/Customer";
import { WooCommerceOrderRecord, type WooCommerceOrderDocument } from "@/models/WooCommerceOrder";

export type LeanCustomer = CustomerDocument & { _id: unknown };

export type ReconcileResult = {
  matched: boolean;
  updated: boolean;
  attachedAuthorizeNetOnly: boolean;
  verifiedWooOrder: boolean;
  skippedDuplicate: boolean;
  matchedBy: string;
  matchConfidence: "exact" | "high" | "medium" | "low" | "not_found";
  customerId?: string;
};

export function gatewayVerification(transaction: AuthorizeNetTransactionDocument, matchedBy: string, confidence: CustomerOrderHistoryItem["gatewayVerification"]["confidence"]) {
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

function productName(transaction: AuthorizeNetTransactionDocument) {
  return transaction.description?.trim() || "Authorize.net Payment";
}

function transactionDate(transaction: AuthorizeNetTransactionDocument) {
  return transaction.settledAt || transaction.submittedAt;
}

function sameDay(a?: string, b?: string) {
  if (!a || !b) return false;
  return a.slice(0, 10) === b.slice(0, 10);
}

function duplicatePayment(customer: LeanCustomer, transaction: AuthorizeNetTransactionDocument) {
  const date = transactionDate(transaction);
  return (customer.gatewayPayments ?? []).some((payment) => payment.provider === "authorize_net" && (
    payment.transactionId === transaction.transactionId ||
    (payment.invoiceNumber && payment.invoiceNumber === transaction.invoiceNumber && Number(payment.amount) === Number(transaction.amount) && sameDay(payment.date, date))
  )) || (customer.orders ?? []).some((order) => (
    order.transactionId === transaction.transactionId ||
    (transaction.invoiceNumber && order.orderNumber === transaction.invoiceNumber && Number(order.total) === Number(transaction.amount) && sameDay(order.dateCreated, date))
  ));
}

export function gatewayPayment(transaction: AuthorizeNetTransactionDocument, matchedBy: string, confidence: string, source: string): CustomerGatewayPayment {
  return {
    date: transactionDate(transaction),
    provider: "authorize_net",
    transactionId: transaction.transactionId,
    invoiceNumber: transaction.invoiceNumber,
    status: transaction.transactionStatus,
    amount: transaction.amount,
    cardLast4: transaction.cardLast4,
    cardType: transaction.cardType,
    matchedBy,
    matchConfidence: confidence,
    source,
    customerProfileId: transaction.customerProfileId,
    customerPaymentProfileId: transaction.customerPaymentProfileId,
  };
}

export function syntheticOrder(transaction: AuthorizeNetTransactionDocument, matchedBy: string, confidence: CustomerOrderHistoryItem["gatewayVerification"]["confidence"]): CustomerOrderHistoryItem {
  const settled = isSettledSuccessful(transaction.transactionStatus);
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
    orderId: `authorize-net-${transaction.transactionId}`,
    orderNumber: transaction.invoiceNumber || transaction.transactionId,
    customerId: 0,
    status: settled ? "paid" : isDeclinedOrFailed(transaction.transactionStatus) ? "failed" : "attempted",
    dateCreated: transaction.submittedAt || transaction.settledAt,
    dateModified: transactionDate(transaction),
    total: transaction.amount,
    currency: transaction.currency || "USD",
    paymentMethod: "authorize_net",
    paymentMethodTitle: "Credit Card Payment",
    transactionId: transaction.transactionId,
    paidDate: settled ? transactionDate(transaction) : "",
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
    lineItems: [lineItem],
    products: [lineItem],
    refundsCount: 0,
    refundsAmount: 0,
    metaData: [{ key: "cardLast4", value: transaction.cardLast4 }, { key: "source", value: "authorize_net_only" }].filter((item) => item.value),
    customerNote: "",
    checkoutSource: "authorize_net",
    source: "authorize_net_only",
    matchedBy: [matchedBy],
    matchConfidence: confidence,
    gatewayVerification: gatewayVerification(transaction, matchedBy, confidence),
  };
}

export async function findAuthorizeNetCustomerMatch(transaction: AuthorizeNetTransactionDocument) {
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
  if (transaction.customerProfileId || transaction.customerPaymentProfileId) {
    const profileConditions: Record<string, string>[] = [];
    if (transaction.customerProfileId) {
      profileConditions.push({ "gatewayPayments.customerProfileId": transaction.customerProfileId });
      profileConditions.push({ "orders.gatewayVerification.customerProfileId": transaction.customerProfileId });
    }
    if (transaction.customerPaymentProfileId) {
      profileConditions.push({ "gatewayPayments.customerPaymentProfileId": transaction.customerPaymentProfileId });
      profileConditions.push({ "orders.gatewayVerification.paymentProfileId": transaction.customerPaymentProfileId });
    }
    const customer = profileConditions.length ? await Customer.findOne({ $or: profileConditions }).lean<LeanCustomer | null>().exec() : null;
    if (customer) return { customer, matchedBy: "customerProfileId", confidence: "medium" as const, wooOrderNumberMatched: "", wooOrderIdMatched: 0 };
  }
  if (transaction.billingPhone) {
    const phone = normalizePhone(transaction.billingPhone);
    const customer = phone.length >= 7 ? await Customer.findOne({ phone: { $regex: phone.slice(-7), $options: "i" } }).lean<LeanCustomer | null>().exec() : null;
    if (customer) return { customer, matchedBy: "phone", confidence: "medium" as const, wooOrderNumberMatched: "", wooOrderIdMatched: 0 };
  }
  if (transaction.customerName && transaction.amount > 0) {
    const parts = transaction.customerName.split(/\s+/).filter(Boolean);
    const customer = await Customer.findOne({ name: { $regex: parts.join(".*"), $options: "i" }, orders: { $elemMatch: { total: transaction.amount } } }).lean<LeanCustomer | null>().exec();
    if (customer) return { customer, matchedBy: "name_amount_date", confidence: "low" as const, wooOrderNumberMatched: "", wooOrderIdMatched: 0 };
  }
  if (transaction.cardLast4 && transaction.amount > 0) {
    const customer = await Customer.findOne({ "gatewayPayments.cardLast4": transaction.cardLast4, "gatewayPayments.amount": transaction.amount }).lean<LeanCustomer | null>().exec();
    if (customer) return { customer, matchedBy: "card_last4_amount_date", confidence: "low" as const, wooOrderNumberMatched: "", wooOrderIdMatched: 0 };
  }
  return { customer: null, matchedBy: "", confidence: "not_found" as const, wooOrderNumberMatched: "", wooOrderIdMatched: 0 };
}

function productJourneyItem(transaction: AuthorizeNetTransactionDocument): CustomerProductJourneyItem {
  return {
    date: transactionDate(transaction),
    orderNumber: transaction.invoiceNumber || transaction.transactionId,
    status: "paid",
    paymentMethod: "Credit Card Payment",
    productName: productName(transaction),
    category: "other",
    productType: "Authorize.net Payment",
    amount: transaction.amount,
    type: "paid",
  };
}

export function buildReconciledCustomerUpdate(customer: LeanCustomer, transaction: AuthorizeNetTransactionDocument, matchedBy: string, confidence: CustomerOrderHistoryItem["gatewayVerification"]["confidence"]) {
  const orders = [...(customer.orders ?? [])];
  const gatewayPayments = [...(customer.gatewayPayments ?? [])];
  const productJourney = [...(customer.productJourney ?? [])];
  const paidProducts = [...(customer.paidProducts ?? [])];
  const alreadyDuplicate = duplicatePayment(customer, transaction);
  const orderIndex = orders.findIndex((order) => order.orderNumber === transaction.invoiceNumber || order.transactionId === transaction.transactionId);
  const settled = isSettledSuccessful(transaction.transactionStatus);
  let countedNewPaid = false;
  let attachedAuthorizeNetOnly = false;
  let verifiedWooOrder = false;
  let source = "authorize_net_reconciled";

  if (orderIndex >= 0) {
    const existing = orders[orderIndex];
    verifiedWooOrder = true;
    orders[orderIndex] = {
      ...existing,
      status: settled ? "paid" : isDeclinedOrFailed(transaction.transactionStatus) ? "failed" : existing.status,
      transactionId: transaction.transactionId || existing.transactionId,
      isPaid: settled || existing.isPaid,
      isAttempted: settled ? false : existing.isAttempted,
      paidDate: settled ? transactionDate(transaction) : existing.paidDate,
      paymentMethod: "authorize_net",
      paymentMethodTitle: "Credit Card Payment",
      gatewayVerification: gatewayVerification(transaction, matchedBy, confidence),
    };
    countedNewPaid = settled && !existing.isPaid && !alreadyDuplicate;
  } else if (settled && !alreadyDuplicate) {
    source = "authorize_net_only";
    attachedAuthorizeNetOnly = true;
    orders.unshift(syntheticOrder(transaction, matchedBy, confidence));
    productJourney.unshift(productJourneyItem(transaction));
    if (!paidProducts.includes(productName(transaction))) paidProducts.unshift(productName(transaction));
    countedNewPaid = true;
  }

  if (!gatewayPayments.some((payment) => payment.transactionId === transaction.transactionId)) {
    gatewayPayments.unshift(gatewayPayment(transaction, matchedBy, confidence, source));
  }

  const paidIncrement = countedNewPaid ? transaction.amount : 0;
  const paidTotal = Number(customer.paidTotal ?? customer.totalPaid ?? 0) + paidIncrement;
  const paidOrderCount = Number(customer.paidOrderCount ?? 0) + (countedNewPaid ? 1 : 0);
  const lastPaidDate = settled && transactionDate(transaction) > (customer.lastPaidDate ?? "") ? transactionDate(transaction) : customer.lastPaidDate;
  const gatewayOnlyPaymentsAttached = orders.filter((order) => order.source === "authorize_net_only").length;
  const authorizeNetTransactionsFound = gatewayPayments.filter((payment) => payment.provider === "authorize_net").length;
  const sourceCoverage = {
    ...(customer.sourceCoverage ?? {}),
    ordersStored: orders.length,
    ordersStoredCount: orders.length,
    wooCommerceCustomerOrdersStored: orders.length - gatewayOnlyPaymentsAttached,
    authorizeNetTransactionsFound,
    gatewayOnlyPaymentsAttached,
    reconciledRecords: authorizeNetTransactionsFound,
    missingUnattachedRecords: 0,
    revenueCoveragePercent: paidTotal > 0 ? 100 : 0,
  };
  return {
    updates: {
      orders,
      gatewayPayments,
      productJourney,
      paidProducts,
      paidTotal,
      totalPaid: paidTotal,
      paidOrderCount,
      orderCount: orders.length,
      lastPaidDate,
      lastOrderDate: orders[0]?.dateCreated ?? customer.lastOrderDate,
      paymentStatus: paidTotal > 0 ? "paid" : customer.paymentStatus,
      leadStatus: paidTotal > 0 ? "customer" : customer.leadStatus,
      gatewayVerification: gatewayVerification(transaction, matchedBy, confidence),
      lastPaymentMethod: settled ? "Credit Card Payment" : customer.lastPaymentMethod,
      lastPurchasedProduct: attachedAuthorizeNetOnly ? productName(transaction) : customer.lastPurchasedProduct,
      sourceCoverage,
      lastSyncedAt: new Date().toISOString(),
    },
    attachedAuthorizeNetOnly,
    verifiedWooOrder,
    skippedDuplicate: alreadyDuplicate,
  };
}

export async function reconcileAuthorizeNetTransaction(transaction: AuthorizeNetTransactionDocument, dryRun = false): Promise<ReconcileResult> {
  const match = await findAuthorizeNetCustomerMatch(transaction);
  if (!match.customer) return { matched: false, updated: false, attachedAuthorizeNetOnly: false, verifiedWooOrder: false, skippedDuplicate: false, matchedBy: "", matchConfidence: "not_found" };
  const { updates, attachedAuthorizeNetOnly, verifiedWooOrder, skippedDuplicate } = buildReconciledCustomerUpdate(match.customer, transaction, match.matchedBy, match.confidence);
  if (!dryRun) {
    await Customer.updateOne({ _id: match.customer._id }, { $set: updates }).exec();
    await AuthorizeNetTransaction.updateOne(
      { transactionId: transaction.transactionId },
      { $set: { matchedCustomerId: String(match.customer._id), matchedBy: match.matchedBy, matchConfidence: match.confidence, wooOrderNumberMatched: match.wooOrderNumberMatched, wooOrderIdMatched: match.wooOrderIdMatched } }
    ).exec();
  }
  return {
    matched: true,
    updated: !dryRun,
    attachedAuthorizeNetOnly,
    verifiedWooOrder,
    skippedDuplicate,
    matchedBy: match.matchedBy,
    matchConfidence: match.confidence,
    customerId: String(match.customer._id),
  };
}

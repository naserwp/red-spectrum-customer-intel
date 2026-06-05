import { calculateCustomerValueMetrics, monthsSince } from "@/lib/customerValue";
import { customerLedgerRecords, detectAuthorizeNetRecurring } from "@/lib/revenueAnalytics";
import { normalizePhone } from "@/lib/wooOrderImport";
import { Customer, type CustomerDocument, type CustomerGatewayPayment, type CustomerOrderHistoryItem, type CustomerProductJourneyItem } from "@/models/Customer";
import { CustomerRanking } from "@/models/CustomerRanking";
import { StripeTransaction, type StripeTransactionDocument } from "@/models/StripeTransaction";
import { WooCommerceOrderRecord, type WooCommerceOrderDocument } from "@/models/WooCommerceOrder";

export type StripeSyncResult = {
  success: boolean;
  gateway: "stripe";
  dryRun: boolean;
  hours: number;
  since: string;
  fetched: number;
  inserted: number;
  updated: number;
  duplicatesSkipped: number;
  matchedCustomers: number;
  gatewayOnlyCreatedCustomers: number;
  failed: number;
  statusCounts: Record<string, number>;
  sampleTransactions: Array<Record<string, unknown>>;
  affectedCustomerIds: string[];
  warnings: string[];
  totalMs: number;
};

type LeanCustomer = CustomerDocument & { _id: unknown };
type StripeCharge = Record<string, unknown>;
type StripeListResponse = { data?: StripeCharge[]; has_more?: boolean; error?: { message?: string } };

const maxHours = 24 * 60;
const maxPages = 20;

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function normalizedEmail(value: unknown) {
  return clean(value).toLowerCase();
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function readString(source: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = clean(source[key]);
    if (value) return value;
  }
  return "";
}

function stripeDate(value: unknown) {
  const seconds = Number(value ?? 0);
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : "";
}

function amountFromCents(value: unknown) {
  const cents = Number(value ?? 0);
  return Number.isFinite(cents) ? Math.round((cents / 100 + Number.EPSILON) * 100) / 100 : 0;
}

function metadataValue(metadata: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = clean(metadata[key]);
    if (value) return value;
  }
  return "";
}

function normalizeStripeStatus(charge: StripeCharge) {
  const status = clean(charge.status).toLowerCase();
  const paid = charge.paid === true;
  const refunded = charge.refunded === true || Number(charge.amount_refunded ?? 0) > 0;
  const disputed = charge.disputed === true || Boolean(charge.dispute);
  if (disputed) return "disputed";
  if (refunded) return "refunded";
  if (paid && status === "succeeded") return "succeeded";
  if (status === "failed" || charge.failure_code || charge.failure_message) return "failed";
  if (status === "pending") return "pending";
  return status || "unknown";
}

export function isStripePaidStatus(status: string) {
  return /succeeded|paid|settled|captured/i.test(status);
}

export function isStripeRefundOrChargeback(status: string) {
  return /refund|dispute|chargeback/i.test(status);
}

export function isStripeFailedStatus(status: string) {
  return /failed|declined|canceled|void/i.test(status);
}

function safeMeta(metadata: Record<string, unknown>) {
  return Object.entries(metadata).slice(0, 30).map(([key, value]) => ({ key, value: clean(value).slice(0, 250) })).filter((item) => item.key && item.value);
}

function normalizeStripeCharge(charge: StripeCharge, importedAt: string): Partial<StripeTransactionDocument> {
  const billing = readRecord(charge.billing_details);
  const card = readRecord(readRecord(charge.payment_method_details).card);
  const outcome = readRecord(charge.outcome);
  const metadata = readRecord(charge.metadata);
  const paymentIntent = typeof charge.payment_intent === "object" ? readRecord(charge.payment_intent) : {};
  const paymentIntentMetadata = readRecord(paymentIntent.metadata);
  const mergedMetadata = { ...paymentIntentMetadata, ...metadata };
  const invoiceNumber = metadataValue(mergedMetadata, ["order_id", "orderId", "order", "invoice", "invoiceNumber", "invoice_number", "woocommerce_order_id", "wc_order_id"]);
  const email = normalizedEmail(readString(billing, ["email"]) || clean(charge.receipt_email));
  const name = readString(billing, ["name"]);
  const phone = readString(billing, ["phone"]);
  const status = normalizeStripeStatus(charge);
  const amount = amountFromCents(charge.amount);
  const createdAt = stripeDate(charge.created);
  return {
    stripePaymentIntentId: clean(typeof charge.payment_intent === "string" ? charge.payment_intent : paymentIntent.id),
    chargeId: clean(charge.id),
    transactionId: clean(charge.id),
    stripeCustomerId: clean(typeof charge.customer === "string" ? charge.customer : readRecord(charge.customer).id),
    customerId: "",
    email,
    normalizedEmail: email,
    emailNormalized: email,
    phone,
    normalizedPhone: normalizePhone(phone),
    name,
    amount,
    amountRefunded: amountFromCents(charge.amount_refunded),
    currency: clean(charge.currency).toUpperCase() || "USD",
    status,
    stripeStatus: clean(charge.status) || status,
    stripeCreatedAt: createdAt,
    paidAt: isStripePaidStatus(status) || isStripeRefundOrChargeback(status) ? createdAt : "",
    cardLast4: readString(card, ["last4"]),
    cardBrand: readString(card, ["brand"]),
    description: clean(charge.description) || readString(outcome, ["seller_message"]),
    invoiceNumber,
    metadata: mergedMetadata,
    rawSafeMeta: safeMeta(mergedMetadata),
    matchedCustomerId: "",
    matchedBy: "",
    matchConfidence: "not_found",
    wooOrderNumberMatched: "",
    wooOrderIdMatched: 0,
    source: "stripe",
    importedAt,
  };
}

async function stripeRequest(path: string, params: URLSearchParams) {
  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) throw new Error("STRIPE_SECRET_KEY is not configured.");
  const url = new URL(`https://api.stripe.com/v1/${path.replace(/^\//, "")}`);
  params.forEach((value, key) => url.searchParams.append(key, value));
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${secret}` },
    cache: "no-store",
  });
  const data = await response.json().catch(() => ({})) as StripeListResponse;
  if (!response.ok) throw new Error(data.error?.message || `Stripe API returned HTTP ${response.status}.`);
  return data;
}

export function isStripeConfigured() {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

export async function fetchRecentStripeTransactions(hours: number) {
  const sinceSeconds = Math.floor((Date.now() - Math.min(maxHours, Math.max(1, hours)) * 60 * 60 * 1000) / 1000);
  const importedAt = new Date().toISOString();
  const transactions: Partial<StripeTransactionDocument>[] = [];
  let startingAfter = "";
  let pages = 0;
  while (pages < maxPages) {
    const params = new URLSearchParams();
    params.set("limit", "100");
    params.set("created[gte]", String(sinceSeconds));
    params.append("expand[]", "data.customer");
    params.append("expand[]", "data.payment_intent");
    if (startingAfter) params.set("starting_after", startingAfter);
    const page = await stripeRequest("charges", params);
    const data = Array.isArray(page.data) ? page.data : [];
    transactions.push(...data.map((charge) => normalizeStripeCharge(charge, importedAt)).filter((tx) => tx.chargeId));
    pages += 1;
    if (!page.has_more || !data.length) break;
    startingAfter = clean(data[data.length - 1].id);
    if (!startingAfter) break;
  }
  return { transactions, pages };
}

function transactionDate(transaction: StripeTransactionDocument) {
  return transaction.paidAt || transaction.stripeCreatedAt;
}

function productName(transaction: StripeTransactionDocument) {
  return transaction.description?.trim() || "Stripe Payment";
}

function sameDay(a?: string, b?: string) {
  return Boolean(a && b && a.slice(0, 10) === b.slice(0, 10));
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function gatewayOnlyEmail(transaction: StripeTransactionDocument) {
  return normalizedEmail(transaction.normalizedEmail || transaction.email) || `no-email-stripe-${transaction.transactionId}@stripe.local`.slice(0, 180);
}

function duplicatePayment(customer: LeanCustomer, transaction: StripeTransactionDocument) {
  const date = transactionDate(transaction);
  return (customer.gatewayPayments ?? []).some((payment) => payment.provider === "stripe" && (
    payment.transactionId === transaction.transactionId ||
    payment.transactionId === transaction.chargeId ||
    (payment.invoiceNumber && payment.invoiceNumber === transaction.invoiceNumber && Number(payment.amount) === Number(transaction.amount) && sameDay(payment.date, date))
  )) || (customer.orders ?? []).some((order) => (
    order.transactionId === transaction.transactionId ||
    order.transactionId === transaction.chargeId ||
    (transaction.invoiceNumber && order.orderNumber === transaction.invoiceNumber && Number(order.total) === Number(transaction.amount) && sameDay(order.dateCreated, date))
  ));
}

function gatewayVerification(transaction: StripeTransactionDocument, matchedBy: string, confidence: CustomerOrderHistoryItem["gatewayVerification"]["confidence"]) {
  return {
    provider: "stripe",
    matched: confidence !== "not_found",
    confidence,
    matchedBy,
    transactionId: transaction.transactionId,
    transactionStatus: transaction.status,
    amount: transaction.amount,
    transactionDate: transactionDate(transaction),
    customerVaultId: "",
    paymentProfileId: "",
    customerProfileId: transaction.stripeCustomerId,
    paymentIntentId: transaction.stripePaymentIntentId,
    chargeId: transaction.chargeId,
    stripeCustomerId: transaction.stripeCustomerId,
    paymentMethodId: "",
    last4: transaction.cardLast4,
    cardType: transaction.cardBrand,
    candidatesCount: 1,
    rawSummary: `${transaction.status} ${transaction.invoiceNumber}`.trim(),
    lastCheckedAt: new Date().toISOString(),
    configured: true,
    notes: "Matched from imported Stripe transaction.",
  };
}

function gatewayPayment(transaction: StripeTransactionDocument, matchedBy: string, confidence: string, source: string): CustomerGatewayPayment {
  return {
    date: transactionDate(transaction),
    provider: "stripe",
    transactionId: transaction.transactionId || transaction.chargeId,
    invoiceNumber: transaction.invoiceNumber,
    status: transaction.status,
    amount: transaction.amount,
    cardLast4: transaction.cardLast4,
    cardType: transaction.cardBrand,
    matchedBy,
    matchConfidence: confidence,
    source,
    customerProfileId: transaction.stripeCustomerId,
    customerPaymentProfileId: "",
  };
}

function syntheticOrder(transaction: StripeTransactionDocument, matchedBy: string, confidence: CustomerOrderHistoryItem["gatewayVerification"]["confidence"]): CustomerOrderHistoryItem {
  const paid = isStripePaidStatus(transaction.status);
  const refunded = isStripeRefundOrChargeback(transaction.status);
  const failed = isStripeFailedStatus(transaction.status);
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
    orderId: `stripe-${transaction.transactionId}`,
    orderNumber: transaction.invoiceNumber || transaction.transactionId,
    customerId: 0,
    status: paid ? "paid" : refunded ? "refunded" : failed ? "failed" : "attempted",
    dateCreated: transaction.stripeCreatedAt || transaction.paidAt,
    dateModified: transactionDate(transaction),
    total: transaction.amount,
    currency: transaction.currency || "USD",
    paymentMethod: "stripe",
    paymentMethodTitle: "Stripe",
    transactionId: transaction.transactionId || transaction.chargeId,
    paidDate: paid ? transactionDate(transaction) : "",
    attemptedDate: paid ? "" : transaction.stripeCreatedAt,
    isPaid: paid,
    isAttempted: !paid,
    billingName: transaction.name,
    billingEmail: transaction.normalizedEmail || transaction.email,
    billingPhone: transaction.phone,
    billingFirstName: transaction.name.split(/\s+/)[0] || "",
    billingLastName: transaction.name.split(/\s+/).slice(1).join(" "),
    billingCompany: "",
    billingAddress: { address1: "", address2: "", city: "", state: "", postcode: "", country: "" },
    lineItems: [lineItem],
    products: [lineItem],
    refundsCount: refunded ? 1 : 0,
    refundsAmount: refunded ? transaction.amountRefunded || transaction.amount : 0,
    metaData: [{ key: "cardLast4", value: transaction.cardLast4 }, { key: "source", value: "stripe_only" }].filter((item) => item.value),
    customerNote: "",
    checkoutSource: "stripe",
    source: "stripe_only",
    matchedBy: [matchedBy],
    matchConfidence: confidence,
    gatewayVerification: gatewayVerification(transaction, matchedBy, confidence),
  };
}

function productJourneyItem(transaction: StripeTransactionDocument): CustomerProductJourneyItem {
  const paid = isStripePaidStatus(transaction.status);
  return {
    date: transactionDate(transaction),
    orderNumber: transaction.invoiceNumber || transaction.transactionId,
    status: paid ? "paid" : isStripeRefundOrChargeback(transaction.status) ? "refunded" : isStripeFailedStatus(transaction.status) ? "failed" : "attempted",
    paymentMethod: "Stripe",
    productName: productName(transaction),
    category: "other",
    productType: "Stripe Payment",
    amount: transaction.amount,
    type: paid ? "paid" : "attempted",
  };
}

export async function findStripeCustomerMatch(transaction: StripeTransactionDocument) {
  const invoiceNumber = transaction.invoiceNumber.trim();
  if (invoiceNumber) {
    const wooOrder = await WooCommerceOrderRecord.findOne({ orderNumber: invoiceNumber }).lean<WooCommerceOrderDocument | null>().exec();
    if (wooOrder?.normalizedEmail) {
      const customer = await Customer.findOne({ $or: [{ normalizedEmail: wooOrder.normalizedEmail }, { emailNormalized: wooOrder.normalizedEmail }, { email: wooOrder.normalizedEmail }] }).lean<LeanCustomer | null>().exec();
      if (customer) return { customer, matchedBy: "invoiceNumber", confidence: "exact" as const, wooOrderNumberMatched: invoiceNumber, wooOrderIdMatched: Number(wooOrder.wooOrderId ?? 0) };
    }
    const customer = await Customer.findOne({ "orders.orderNumber": invoiceNumber }).lean<LeanCustomer | null>().exec();
    if (customer) return { customer, matchedBy: "invoiceNumber", confidence: "exact" as const, wooOrderNumberMatched: invoiceNumber, wooOrderIdMatched: 0 };
  }
  if (transaction.normalizedEmail) {
    const customer = await Customer.findOne({ $or: [{ normalizedEmail: transaction.normalizedEmail }, { emailNormalized: transaction.normalizedEmail }, { email: transaction.normalizedEmail }] }).lean<LeanCustomer | null>().exec();
    if (customer) return { customer, matchedBy: "normalizedEmail", confidence: "high" as const, wooOrderNumberMatched: "", wooOrderIdMatched: 0 };
  }
  const phone = normalizePhone(transaction.normalizedPhone || transaction.phone);
  if (phone.length >= 7) {
    const customer = await Customer.findOne({ $or: [{ phoneNormalized: phone }, { phone: { $regex: escapeRegex(phone.slice(-7)), $options: "i" } }, { "orders.billingPhone": { $regex: escapeRegex(phone.slice(-7)), $options: "i" } }] }).lean<LeanCustomer | null>().exec();
    if (customer) return { customer, matchedBy: "phone", confidence: "medium" as const, wooOrderNumberMatched: "", wooOrderIdMatched: 0 };
  }
  if (transaction.stripeCustomerId) {
    const customer = await Customer.findOne({ $or: [{ stripeCustomerId: transaction.stripeCustomerId }, { "gatewayPayments.customerProfileId": transaction.stripeCustomerId }, { "orders.gatewayVerification.stripeCustomerId": transaction.stripeCustomerId }] }).lean<LeanCustomer | null>().exec();
    if (customer) return { customer, matchedBy: "stripeCustomerId", confidence: "medium" as const, wooOrderNumberMatched: "", wooOrderIdMatched: 0 };
  }
  const nameParts = transaction.name.split(/\s+/).filter((part) => part.length > 1).slice(0, 4);
  if (nameParts.length >= 2) {
    const nameRegex = `^${nameParts.map(escapeRegex).join("\\s+")}`;
    const date = transactionDate(transaction);
    const dateFloor = date ? new Date(new Date(date).getTime() - 3 * 24 * 60 * 60 * 1000).toISOString() : "";
    const dateCeil = date ? new Date(new Date(date).getTime() + 3 * 24 * 60 * 60 * 1000).toISOString() : "";
    const customer = await Customer.findOne({
      $or: [
        { name: { $regex: nameRegex, $options: "i" } },
        { "orders.billingName": { $regex: nameRegex, $options: "i" } },
      ],
      ...(transaction.amount > 0 && dateFloor && dateCeil ? { orders: { $elemMatch: { total: transaction.amount, dateCreated: { $gte: dateFloor, $lte: dateCeil } } } } : {}),
    }).sort({ lifetimeValue: -1, paidTotal: -1 }).lean<LeanCustomer | null>().exec();
    if (customer) return { customer, matchedBy: "name_amount_date", confidence: "medium" as const, wooOrderNumberMatched: "", wooOrderIdMatched: 0 };
  }
  if (transaction.cardLast4 && transaction.amount > 0) {
    const customer = await Customer.findOne({ "gatewayPayments.cardLast4": transaction.cardLast4, "gatewayPayments.amount": transaction.amount }).lean<LeanCustomer | null>().exec();
    if (customer) return { customer, matchedBy: "card_last4_amount_date", confidence: "low" as const, wooOrderNumberMatched: "", wooOrderIdMatched: 0 };
  }
  return { customer: null, matchedBy: "", confidence: "not_found" as const, wooOrderNumberMatched: "", wooOrderIdMatched: 0 };
}

function buildReconciledStripeCustomerUpdate(customer: LeanCustomer, transaction: StripeTransactionDocument, matchedBy: string, confidence: CustomerOrderHistoryItem["gatewayVerification"]["confidence"]) {
  const orders = [...(customer.orders ?? [])];
  const gatewayPayments = [...(customer.gatewayPayments ?? [])];
  const productJourney = [...(customer.productJourney ?? [])];
  const paidProducts = [...(customer.paidProducts ?? [])];
  const attemptedProducts = [...(customer.attemptedProducts ?? [])];
  const alreadyDuplicate = duplicatePayment(customer, transaction);
  const orderIndex = orders.findIndex((order) => order.orderNumber === transaction.invoiceNumber || order.transactionId === transaction.transactionId || order.transactionId === transaction.chargeId);
  const paid = isStripePaidStatus(transaction.status);
  let attachedGatewayOnly = false;
  let verifiedWooOrder = false;
  let source = "stripe_reconciled";

  if (orderIndex >= 0) {
    const existing = orders[orderIndex];
    const existingPaid = existing.isPaid || ["completed", "processing", "paid"].includes(String(existing.status ?? "").toLowerCase());
    verifiedWooOrder = true;
    orders[orderIndex] = {
      ...existing,
      status: paid ? "paid" : existingPaid ? existing.status : isStripeFailedStatus(transaction.status) ? "failed" : isStripeRefundOrChargeback(transaction.status) ? "refunded" : "attempted",
      transactionId: transaction.transactionId || existing.transactionId,
      isPaid: paid ? true : existingPaid,
      isAttempted: paid ? false : existingPaid ? false : true,
      paidDate: paid ? transactionDate(transaction) : existing.paidDate,
      attemptedDate: paid ? existing.attemptedDate : transaction.stripeCreatedAt || existing.attemptedDate,
      paymentMethod: "stripe",
      paymentMethodTitle: "Stripe",
      gatewayVerification: gatewayVerification(transaction, matchedBy, confidence),
    };
  } else if (!alreadyDuplicate) {
    source = "stripe_only";
    attachedGatewayOnly = paid;
    orders.unshift(syntheticOrder(transaction, matchedBy, confidence));
    productJourney.unshift(productJourneyItem(transaction));
    if (paid) {
      if (!paidProducts.includes(productName(transaction))) paidProducts.unshift(productName(transaction));
    } else if (!attemptedProducts.includes(productName(transaction))) {
      attemptedProducts.unshift(productName(transaction));
    }
  }

  if (!gatewayPayments.some((payment) => payment.transactionId === transaction.transactionId || payment.transactionId === transaction.chargeId)) {
    gatewayPayments.unshift(gatewayPayment(transaction, matchedBy, confidence, source));
  }

  const metrics = calculateCustomerValueMetrics({ customer: { ...customer, orders, gatewayPayments, productJourney }, stripeTransactions: [transaction] });
  const paidTotal = metrics.rankingTotal;
  const firstPaidDate = metrics.firstPaidDate || customer.firstPaidDate || customer.firstOrderDate || (paid ? transactionDate(transaction) : "");
  const recurring = detectAuthorizeNetRecurring(customerLedgerRecords({ ...customer, orders, gatewayPayments }));
  const stripeTransactionsFound = gatewayPayments.filter((payment) => payment.provider === "stripe").length;
  const gatewayOnlyPaymentsAttached = orders.filter((order) => ["authorize_net_only", "nmi_quick_pay_only", "stripe_only"].includes(order.source)).length;
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
      stripePaidTotal: metrics.stripePaidTotal,
      subscriptionPaidTotal: metrics.subscriptionPaidTotal,
      attemptedTotal: metrics.attemptedTotal,
      paidOrderCount: Math.max(Number(customer.paidOrderCount ?? 0), orders.filter((order) => order.isPaid).length),
      gatewayPaidCount: orders.filter((order) => ["authorize_net_only", "nmi_quick_pay_only", "stripe_only"].includes(order.source) && order.isPaid).length,
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
      lastPaymentMethod: paid ? "Stripe" : customer.lastPaymentMethod,
      lastPurchasedProduct: attachedGatewayOnly && paid ? productName(transaction) : customer.lastPurchasedProduct,
      lastAttemptedProduct: !paid ? productName(transaction) : customer.lastAttemptedProduct,
      isGatewayRecurring: recurring.isGatewayRecurring,
      recurringSource: recurring.recurringSource,
      recurringAmount: recurring.recurringAmount,
      recurringFrequencyEstimate: recurring.recurringFrequencyEstimate,
      recurringLastPayment: recurring.recurringLastPayment,
      recurringNextEstimatedPayment: recurring.recurringNextEstimatedPayment,
      recurringPaymentCount: recurring.recurringPaymentCount,
      sourceCoverage: {
        ...(customer.sourceCoverage ?? {}),
        ordersStored: orders.length,
        ordersStoredCount: orders.length,
        stripeTransactionsFound,
        gatewayOnlyPaymentsAttached,
        reconciledRecords: gatewayPayments.length,
        revenueCoveragePercent: paidTotal > 0 ? 100 : 0,
        lastStripeSyncAt: new Date().toISOString(),
        lastSyncedAt: new Date().toISOString(),
      },
      lastSyncedAt: new Date().toISOString(),
    },
    attachedGatewayOnly,
    verifiedWooOrder,
    skippedDuplicate: alreadyDuplicate,
  };
}

async function createGatewayOnlyCustomer(transaction: StripeTransactionDocument, dryRun = false) {
  const paid = isStripePaidStatus(transaction.status);
  const attempted = !paid && !isStripeFailedStatus(transaction.status);
  const hasIdentity = Boolean(gatewayOnlyEmail(transaction) || transaction.phone || transaction.name);
  if (!hasIdentity || (!paid && !attempted && !isStripeFailedStatus(transaction.status))) {
    return { matched: false, updated: false, attachedGatewayOnly: false, verifiedWooOrder: false, skippedDuplicate: false, matchedBy: "", matchConfidence: "not_found" as const, customerId: "", gatewayOnlyCreated: false };
  }
  const email = gatewayOnlyEmail(transaction);
  const now = new Date().toISOString();
  const order = syntheticOrder(transaction, "gateway_only_identity", paid ? "medium" : "low");
  const gateway = gatewayPayment(transaction, "gateway_only_identity", paid ? "medium" : "low", "stripe_only");
  const customerName = clean(transaction.name) || email;
  const metrics = calculateCustomerValueMetrics({ customer: { orders: [order], gatewayPayments: [gateway] }, stripeTransactions: [transaction] });
  if (dryRun) {
    return { matched: true, updated: false, attachedGatewayOnly: paid, verifiedWooOrder: false, skippedDuplicate: false, matchedBy: "gateway_only_identity", matchConfidence: paid ? "medium" as const : "low" as const, customerId: "", gatewayOnlyCreated: true };
  }
  const created = await Customer.findOneAndUpdate(
    { $or: [{ normalizedEmail: email }, { email }, { externalCustomerKey: `stripe:${transaction.transactionId}` }] },
    {
      $set: {
        name: customerName,
        email,
        normalizedEmail: email,
        emailNormalized: email,
        phone: transaction.phone,
        phoneNormalized: normalizePhone(transaction.phone),
        stripeCustomerId: transaction.stripeCustomerId,
        externalCustomerKey: `stripe:${transaction.transactionId}`,
        sourcePlatform: "stripe",
        orders: [order],
        gatewayPayments: [gateway],
        productJourney: [productJourneyItem(transaction)],
        paidProducts: paid ? [productName(transaction)] : [],
        attemptedProducts: paid ? [] : [productName(transaction)],
        paidTotal: metrics.rankingTotal,
        totalPaid: metrics.rankingTotal,
        lifetimeValue: metrics.rankingTotal,
        rankingPaidTotal: metrics.rankingTotal,
        wooPaidTotal: metrics.wooPaidTotal,
        authorizeNetPaidTotal: metrics.authorizeNetPaidTotal,
        gatewayOnlyPaidTotal: metrics.gatewayOnlyPaidTotal,
        nmiQuickPayPaidTotal: metrics.nmiQuickPayPaidTotal,
        stripePaidTotal: metrics.stripePaidTotal,
        attemptedTotal: metrics.attemptedTotal,
        orderCount: 1,
        paidOrderCount: paid ? 1 : 0,
        gatewayPaidCount: paid ? 1 : 0,
        attemptedOrderCount: paid ? 0 : 1,
        paidMonths: metrics.paidMonths,
        firstPaidDate: metrics.firstPaidDate,
        firstOrderDate: transaction.stripeCreatedAt || now,
        latestOrderDate: transaction.stripeCreatedAt || now,
        customerCreatedAt: transaction.stripeCreatedAt || now,
        latestCustomerCreatedAt: transaction.stripeCreatedAt || now,
        lastOrderDate: transaction.stripeCreatedAt || now,
        lastPaidDate: metrics.lastPaidDate,
        lastAttemptDate: paid ? "" : transaction.stripeCreatedAt,
        lastPaymentMethod: paid ? "Stripe" : "",
        lastAttemptPaymentMethod: paid ? "" : "Stripe",
        leadStatus: paid ? "customer" : "hot_lead",
        paymentStatus: paid ? "paid" : "attempted_unpaid",
        "businessProfile.email": email,
        "businessProfile.phone": transaction.phone,
        "businessProfile.sourcePlatform": "stripe",
        "businessProfile.source": "stripe",
        "sourceCoverage.syncStatus": "success",
        "sourceCoverage.dataConfidenceStatus": "Gateway Only / Needs Review",
        "sourceCoverage.stripeTransactionsFound": 1,
        "sourceCoverage.gatewayOnlyPaymentsAttached": paid ? 1 : 0,
        "sourceCoverage.lastStripeSyncAt": now,
        "sourceCoverage.lastSyncedAt": now,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean<LeanCustomer | null>().exec();
  if (!created) {
    return { matched: false, updated: false, attachedGatewayOnly: false, verifiedWooOrder: false, skippedDuplicate: false, matchedBy: "", matchConfidence: "not_found" as const, customerId: "", gatewayOnlyCreated: false };
  }
  await CustomerRanking.updateOne(
    { customerId: String(created._id) },
    {
      $set: {
        customerId: String(created._id),
        name: customerName,
        email,
        phone: transaction.phone,
        businessName: "",
        lifetimeSpent: metrics.rankingTotal,
        periodSpent: metrics.rankingTotal,
        monthlySpent: metrics.rankingTotal,
        yearlySpent: metrics.rankingTotal,
        paidMonths: metrics.paidMonths,
        firstPaidDate: metrics.firstPaidDate,
        latestPaidDate: metrics.lastPaidDate,
        activeSubscriptionCount: 0,
        estimatedMRR: 0,
        stayWithUsMonths: metrics.stayWithUsMonths,
        attemptedPipeline: metrics.attemptedTotal,
        category: metrics.rankingTotal > 0 ? "Paying Customer" : "Hot Lead",
        generatedAt: now,
        lastVerifiedAt: now,
      },
    },
    { upsert: true }
  ).exec();
  await StripeTransaction.updateOne(
    { transactionId: transaction.transactionId },
    { $set: { matchedCustomerId: String(created._id), matchedBy: "gateway_only_identity", matchConfidence: paid ? "medium" : "low" } }
  ).exec();
  return { matched: true, updated: true, attachedGatewayOnly: paid, verifiedWooOrder: false, skippedDuplicate: false, matchedBy: "gateway_only_identity", matchConfidence: paid ? "medium" as const : "low" as const, customerId: String(created._id), gatewayOnlyCreated: true };
}

export async function reconcileStripeTransaction(transaction: StripeTransactionDocument, dryRun = false) {
  const match = await findStripeCustomerMatch(transaction);
  if (!match.customer) return createGatewayOnlyCustomer(transaction, dryRun);
  const { updates, attachedGatewayOnly, verifiedWooOrder, skippedDuplicate } = buildReconciledStripeCustomerUpdate(match.customer, transaction, match.matchedBy, match.confidence);
  if (!dryRun) {
    await Customer.updateOne({ _id: match.customer._id }, { $set: updates }).exec();
    await CustomerRanking.updateOne({ customerId: String(match.customer._id) }, {
      $set: {
        lifetimeSpent: updates.lifetimeValue,
        periodSpent: updates.lifetimeValue,
        monthlySpent: updates.lifetimeValue,
        yearlySpent: updates.lifetimeValue,
        paidMonths: updates.paidMonths,
        latestPaidDate: updates.lastPaidDate,
        attemptedPipeline: updates.attemptedTotal,
        category: Number(updates.lifetimeValue ?? 0) >= 2000 ? "VIP Paid Customer" : Number(updates.lifetimeValue ?? 0) > 0 ? "Paying Customer" : Number(updates.attemptedTotal ?? 0) > 0 ? "Hot Lead" : "Cold Lead",
        lastVerifiedAt: new Date().toISOString(),
      },
    }).exec();
    await StripeTransaction.updateOne(
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
    gatewayOnlyCreated: false,
  };
}

function sample(transaction: Partial<StripeTransactionDocument>) {
  return {
    transactionId: transaction.transactionId,
    stripePaymentIntentId: transaction.stripePaymentIntentId,
    chargeId: transaction.chargeId,
    status: transaction.status,
    amount: transaction.amount,
    stripeCreatedAt: transaction.stripeCreatedAt,
    paidAt: transaction.paidAt,
    email: transaction.normalizedEmail || transaction.email,
    name: transaction.name,
    invoiceNumber: transaction.invoiceNumber,
    cardLast4: transaction.cardLast4,
  };
}

export async function syncRecentStripeTransactions({ hours = 24, dryRun = true }: { hours?: number; dryRun?: boolean }): Promise<StripeSyncResult> {
  const started = Date.now();
  const safeHours = Math.min(maxHours, Math.max(1, Math.floor(Number(hours) || 24)));
  const since = new Date(Date.now() - safeHours * 60 * 60 * 1000);
  const warnings: string[] = dryRun ? ["Dry run: no StripeTransaction, Customer, or CustomerRanking records were written."] : [];
  if (!isStripeConfigured()) {
    return {
      success: false,
      gateway: "stripe",
      dryRun,
      hours: safeHours,
      since: since.toISOString(),
      fetched: 0,
      inserted: 0,
      updated: 0,
      duplicatesSkipped: 0,
      matchedCustomers: 0,
      gatewayOnlyCreatedCustomers: 0,
      failed: 1,
      statusCounts: {},
      sampleTransactions: [],
      affectedCustomerIds: [],
      warnings: ["STRIPE_SECRET_KEY is not configured."],
      totalMs: Date.now() - started,
    };
  }

  let fetched: Partial<StripeTransactionDocument>[] = [];
  let failed = 0;
  try {
    const result = await fetchRecentStripeTransactions(safeHours);
    fetched = result.transactions;
    if (result.pages >= maxPages) warnings.push(`Stripe pagination stopped at ${maxPages} pages to stay Vercel-safe.`);
  } catch (error) {
    failed += 1;
    warnings.push(error instanceof Error ? error.message : "Stripe fetch failed.");
  }

  const transactionIds = fetched.map((transaction) => String(transaction.transactionId || transaction.chargeId)).filter(Boolean);
  const existingIds = transactionIds.length
    ? new Set((await StripeTransaction.find({ transactionId: { $in: transactionIds } }, { transactionId: 1 }).lean<Array<{ transactionId?: string }>>()).map((row) => String(row.transactionId)))
    : new Set<string>();

  let inserted = 0;
  let updated = 0;
  let duplicatesSkipped = existingIds.size;
  let matchedCustomers = 0;
  let gatewayOnlyCreatedCustomers = 0;
  const affectedCustomerIds = new Set<string>();

  if (!dryRun && fetched.length) {
    const write = await StripeTransaction.bulkWrite(fetched.map((transaction) => ({
      updateOne: {
        filter: { transactionId: transaction.transactionId },
        update: { $set: transaction },
        upsert: true,
      },
    })), { ordered: false });
    inserted = write.upsertedCount;
    updated = write.modifiedCount;
    duplicatesSkipped = Math.max(0, write.matchedCount - write.modifiedCount);

    const saved = await StripeTransaction.find({ transactionId: { $in: transactionIds } }).sort({ stripeCreatedAt: -1 }).lean<StripeTransactionDocument[]>();
    for (const transaction of saved) {
      const result = await reconcileStripeTransaction(transaction, false);
      if (result.matched) matchedCustomers += 1;
      if (result.customerId) affectedCustomerIds.add(result.customerId);
      if (result.gatewayOnlyCreated) gatewayOnlyCreatedCustomers += 1;
    }
  }

  return {
    success: failed === 0,
    gateway: "stripe",
    dryRun,
    hours: safeHours,
    since: since.toISOString(),
    fetched: fetched.length,
    inserted: dryRun ? 0 : inserted,
    updated: dryRun ? 0 : updated,
    duplicatesSkipped: dryRun ? existingIds.size : duplicatesSkipped,
    matchedCustomers: dryRun ? 0 : matchedCustomers,
    gatewayOnlyCreatedCustomers: dryRun ? 0 : gatewayOnlyCreatedCustomers,
    failed,
    statusCounts: fetched.reduce<Record<string, number>>((counts, transaction) => {
      const status = String(transaction.status || "unknown");
      counts[status] = (counts[status] ?? 0) + 1;
      return counts;
    }, {}),
    sampleTransactions: fetched.slice(0, 10).map(sample),
    affectedCustomerIds: Array.from(affectedCustomerIds),
    warnings,
    totalMs: Date.now() - started,
  };
}

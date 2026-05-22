import { isDeclinedOrFailed, isRefundedOrChargeback, isSettledSuccessful } from "@/lib/authorizeNet";
import { isNmiDeclined, isNmiRefundOrChargeback, isNmiSuccessful } from "@/lib/nmiQuickPay";
import type { AuthorizeNetTransactionDocument } from "@/models/AuthorizeNetTransaction";
import type { CustomerDocument, CustomerGatewayPayment, CustomerOrderHistoryItem } from "@/models/Customer";
import type { NmiQuickPayTransactionDocument } from "@/models/NmiQuickPayTransaction";
import type { WooCommerceSubscriptionDocument } from "@/models/WooCommerceSubscription";

export type UnifiedPaymentSource = "woocommerce" | "authorize_net" | "nmi_quick_pay";
export type UnifiedPaymentOrigin =
  | "woocommerce_checkout"
  | "woocommerce_subscription_renewal"
  | "authorize_net_manual"
  | "authorize_net_cim_profile"
  | "authorize_net_recurring"
  | "ghl_payment_link"
  | "nmi"
  | "stripe"
  | "unknown_gateway";

export type UnifiedPaymentLedgerRow = {
  date: string;
  source: UnifiedPaymentSource;
  provider: string;
  origin: UnifiedPaymentOrigin;
  originClassificationReason: string;
  transactionId: string;
  invoiceNumber: string;
  productDescription: string;
  status: string;
  amount: number;
  cardLast4: string;
  matchMethod: string;
  confidence: string;
  revenueType: "paid" | "attempted" | "refund" | "pending";
  dedupeKeys: string[];
  matchedWooOrderId: string;
  matchedSubscriptionId: string;
  gatewayProfileId: string;
  paymentProfileId: string;
  recurringPatternDetected: boolean;
  retryDetected: boolean;
  staleNextPaymentPrevented: boolean;
};

export type UnifiedPaymentLedgerMetrics = {
  paidTotal: number;
  attemptedTotal: number;
  refundTotal: number;
  paidCount: number;
  attemptedCount: number;
  duplicateSkipped: number;
  lastActivity: string;
  paidByWooCommerce: number;
  paidBySubscriptionRenewal: number;
  paidByAuthorizeNetManual: number;
  paidByCimRecurring: number;
  failedAttemptsBySource: Partial<Record<UnifiedPaymentOrigin, number>>;
  lastFailedAttempt: string;
  nextRetryAttempt: string;
  lastSuccessfulPayment: string;
  activePaymentProfileCount: number;
};

type LedgerInput = {
  customer?: Partial<CustomerDocument> | null;
  authorizeNetTransactions?: Partial<AuthorizeNetTransactionDocument>[];
  nmiTransactions?: Partial<NmiQuickPayTransactionDocument>[];
  subscriptions?: Partial<WooCommerceSubscriptionDocument>[];
};

type SubscriptionLookup = {
  orderToSubscription: Map<string, string>;
  activeSubscriptionIds: Set<string>;
};

function money(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function dateKey(value?: string) {
  return value ? value.slice(0, 10) : "";
}

function latestDate(a: string, b: string) {
  if (!a) return b;
  if (!b) return a;
  return new Date(b).getTime() > new Date(a).getTime() ? b : a;
}

function parseDate(value?: string) {
  if (!value) return 0;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

function addDays(value: string, days: number) {
  const parsed = parseDate(value);
  if (!parsed) return "";
  const date = new Date(parsed);
  date.setDate(date.getDate() + days);
  return date.toISOString();
}

function productNames(order: CustomerOrderHistoryItem) {
  const items = order.lineItems?.length ? order.lineItems : order.products ?? [];
  return items.map((item) => item.name).filter(Boolean).join(", ") || order.customerNote || "WooCommerce Order";
}

function orderRevenueType(order: CustomerOrderHistoryItem): UnifiedPaymentLedgerRow["revenueType"] {
  if (order.status?.toLowerCase().includes("refund") || Number(order.refundsAmount ?? 0) > 0) return "refund";
  if (order.isPaid || ["completed", "processing", "paid"].includes(String(order.status ?? "").toLowerCase())) return "paid";
  if (order.isAttempted) return "attempted";
  return "pending";
}

function authRevenueType(status?: string): UnifiedPaymentLedgerRow["revenueType"] {
  const value = status ?? "";
  if (isRefundedOrChargeback(value)) return "refund";
  if (isSettledSuccessful(value)) return "paid";
  if (isDeclinedOrFailed(value)) return "attempted";
  return "pending";
}

function nmiRevenueType(status?: string): UnifiedPaymentLedgerRow["revenueType"] {
  const value = status ?? "";
  if (isNmiRefundOrChargeback(value)) return "refund";
  if (isNmiSuccessful(value)) return "paid";
  if (isNmiDeclined(value)) return "attempted";
  return "pending";
}

function rowKeys(row: UnifiedPaymentLedgerRow) {
  const amount = roundMoney(Math.abs(row.amount)).toFixed(2);
  const date = dateKey(row.date);
  const keys = [...row.dedupeKeys];
  if (row.transactionId) keys.push(`tx:${row.provider}:${row.transactionId}`);
  if (row.invoiceNumber) keys.push(`invoice:${row.invoiceNumber}`);
  if (row.invoiceNumber && date) keys.push(`invoice-date:${row.invoiceNumber}:${amount}:${date}`);
  if (row.cardLast4 && date) keys.push(`card-date:${row.cardLast4}:${amount}:${date}`);
  return keys.filter(Boolean);
}

function norm(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

function cleanId(value: unknown) {
  return String(value ?? "").trim();
}

function amountBucket(value: number) {
  return roundMoney(Math.abs(value)).toFixed(2);
}

function recurringText(value: string) {
  return /renew|recurr|subscription|monthly|membership|autopay|rebill/i.test(value);
}

function ghlText(value: string) {
  return /gohighlevel|highlevel|ghl|payment link/i.test(value);
}

function manualText(value: string) {
  return /manual|virtual terminal|moto|keyed|admin/i.test(value);
}

function buildSubscriptionLookup(subscriptions: Partial<WooCommerceSubscriptionDocument>[]) {
  const orderToSubscription = new Map<string, string>();
  const activeSubscriptionIds = new Set<string>();

  for (const subscription of subscriptions) {
    const subscriptionId = cleanId(subscription.subscriptionId || subscription.subscriptionNumber || subscription.wooSubscriptionId);
    if (!subscriptionId) continue;
    if (norm(subscription.status) === "active") activeSubscriptionIds.add(subscriptionId);
    for (const relatedOrderId of subscription.relatedOrderIds ?? []) {
      const normalizedOrderId = cleanId(relatedOrderId);
      if (normalizedOrderId) orderToSubscription.set(normalizedOrderId, subscriptionId);
    }
  }

  return { orderToSubscription, activeSubscriptionIds };
}

function buildAuthorizeRecurringTransactionIds(transactions: Partial<AuthorizeNetTransactionDocument>[]) {
  const paidTransactions = transactions
    .filter((transaction) => authRevenueType(transaction.transactionStatus) === "paid" && parseDate(transaction.settledAt || transaction.submittedAt))
    .sort((a, b) => parseDate(a.settledAt || a.submittedAt) - parseDate(b.settledAt || b.submittedAt));

  const groups = new Map<string, Partial<AuthorizeNetTransactionDocument>[]>();
  for (const transaction of paidTransactions) {
    const profileId = cleanId(transaction.customerProfileId);
    const paymentProfileId = cleanId(transaction.customerPaymentProfileId);
    const cardLast4 = cleanId(transaction.cardLast4);
    const amount = amountBucket(money(transaction.amount));
    const key = [profileId || "no_profile", paymentProfileId || cardLast4 || "no_card", amount].join("|");
    groups.set(key, [...(groups.get(key) ?? []), transaction]);
  }

  const recurring = new Set<string>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    let monthlyLike = false;
    for (let index = 1; index < group.length; index += 1) {
      const diff = Math.round((parseDate(group[index].settledAt || group[index].submittedAt) - parseDate(group[index - 1].settledAt || group[index - 1].submittedAt)) / 86400000);
      if (diff >= 20 && diff <= 45) {
        monthlyLike = true;
        break;
      }
    }
    if (!monthlyLike && !group.some((transaction) => recurringText(`${transaction.invoiceNumber ?? ""} ${transaction.description ?? ""}`))) continue;
    for (const transaction of group) {
      const transactionId = cleanId(transaction.transactionId);
      if (transactionId) recurring.add(transactionId);
    }
  }
  return recurring;
}

function buildRecurringWooOrderIds(orders: CustomerOrderHistoryItem[], subscriptions: SubscriptionLookup) {
  const recurringOrderIds = new Set<string>();
  const hasActiveSubscription = subscriptions.activeSubscriptionIds.size > 0;
  if (!hasActiveSubscription) return recurringOrderIds;

  const paidOrders = orders
    .filter((order) => orderRevenueType(order) === "paid" && parseDate(order.paidDate || order.dateCreated))
    .sort((a, b) => parseDate(a.paidDate || a.dateCreated) - parseDate(b.paidDate || b.dateCreated));

  const groups = new Map<string, CustomerOrderHistoryItem[]>();
  for (const order of paidOrders) {
    const key = [
      amountBucket(money(order.total)),
      norm(productNames(order)),
      norm(order.paymentMethodTitle || order.paymentMethod),
    ].join("|");
    groups.set(key, [...(groups.get(key) ?? []), order]);
  }

  for (const group of groups.values()) {
    if (group.length < 2) continue;
    let monthlyLike = false;
    for (let index = 1; index < group.length; index += 1) {
      const diff = Math.round((parseDate(group[index].paidDate || group[index].dateCreated) - parseDate(group[index - 1].paidDate || group[index - 1].dateCreated)) / 86400000);
      if (diff >= 20 && diff <= 45) {
        monthlyLike = true;
        break;
      }
    }
    if (!monthlyLike) continue;
    for (const order of group) {
      const orderId = cleanId(order.orderId || order.orderNumber);
      if (orderId) recurringOrderIds.add(orderId);
    }
  }
  return recurringOrderIds;
}

function buildRetryFingerprints(rows: UnifiedPaymentLedgerRow[]) {
  const paidFingerprints = new Set<string>();
  const attemptedFingerprints = new Map<string, number>();

  for (const row of rows) {
    const fingerprint = [row.gatewayProfileId || row.paymentProfileId || row.cardLast4 || "na", amountBucket(row.amount), row.invoiceNumber || "no_invoice"].join("|");
    if (!fingerprint) continue;
    if (row.revenueType === "paid") paidFingerprints.add(fingerprint);
    if (row.revenueType === "attempted") attemptedFingerprints.set(fingerprint, (attemptedFingerprints.get(fingerprint) ?? 0) + 1);
  }

  return { paidFingerprints, attemptedFingerprints };
}

function classifyWooOrigin(order: CustomerOrderHistoryItem, subscriptions: SubscriptionLookup, recurringWooOrderIds: Set<string>) {
  const matchedSubscriptionId = subscriptions.orderToSubscription.get(cleanId(order.orderId)) ?? "";
  const recurringHint = recurringText(`${order.orderNumber ?? ""} ${productNames(order)} ${order.paymentMethodTitle ?? ""}`);
  const recurringCadence = recurringWooOrderIds.has(cleanId(order.orderId || order.orderNumber));
  if (matchedSubscriptionId || recurringHint || recurringCadence) {
    return {
      origin: "woocommerce_subscription_renewal" as const,
      reason: matchedSubscriptionId ? "matched_related_subscription_order" : recurringCadence ? "monthly_paid_order_cadence_with_active_subscription" : "renewal_text_detected",
      matchedSubscriptionId,
    };
  }
  return {
    origin: "woocommerce_checkout" as const,
    reason: "direct_woocommerce_order",
    matchedSubscriptionId: "",
  };
}

function classifyAuthorizeOrigin(params: {
  provider: string;
  invoiceNumber: string;
  productDescription: string;
  matchedWooOrderId: string;
  matchedSubscriptionId: string;
  gatewayProfileId: string;
  paymentProfileId: string;
  recurringPatternDetected: boolean;
}) {
  const signature = `${params.invoiceNumber} ${params.productDescription} ${params.provider}`;
  if (params.matchedSubscriptionId) {
    return { origin: "woocommerce_subscription_renewal" as const, reason: "matched_subscription_order" };
  }
  if (params.matchedWooOrderId) {
    return { origin: "woocommerce_checkout" as const, reason: "matched_woocommerce_order" };
  }
  if (ghlText(signature)) {
    return { origin: "ghl_payment_link" as const, reason: "ghl_metadata_detected" };
  }
  if (params.recurringPatternDetected) {
    return { origin: "authorize_net_recurring" as const, reason: "recurring_payment_pattern_detected" };
  }
  if (params.gatewayProfileId || params.paymentProfileId) {
    return { origin: "authorize_net_cim_profile" as const, reason: "cim_profile_detected" };
  }
  if (manualText(signature)) {
    return { origin: "authorize_net_manual" as const, reason: "manual_indicator_detected" };
  }
  return { origin: "authorize_net_manual" as const, reason: "standalone_authorize_net_transaction" };
}

function gatewayRow(payment: CustomerGatewayPayment): UnifiedPaymentLedgerRow {
  const provider = payment.provider === "nmi" || payment.provider === "cliq" ? "nmi_quick_pay" : payment.provider || "authorize_net";
  const source: UnifiedPaymentSource = provider === "nmi_quick_pay" ? "nmi_quick_pay" : provider === "stripe" ? "authorize_net" : "authorize_net";
  const revenueType = source === "nmi_quick_pay" ? nmiRevenueType(payment.status) : authRevenueType(payment.status);
  const isNmi = source === "nmi_quick_pay";
  const origin = isNmi ? "nmi" : provider === "stripe" ? "stripe" : "unknown_gateway";

  return {
    date: payment.date,
    source,
    provider,
    origin,
    originClassificationReason: isNmi ? "stored_nmi_gateway_payment" : provider === "stripe" ? "stored_stripe_gateway_payment" : "stored_gateway_payment",
    transactionId: payment.transactionId,
    invoiceNumber: payment.invoiceNumber,
    productDescription: isNmi ? "NMI Quick Pay" : "Gateway Payment",
    status: payment.status,
    amount: money(payment.amount),
    cardLast4: payment.cardLast4,
    matchMethod: payment.matchedBy,
    confidence: payment.matchConfidence,
    revenueType,
    dedupeKeys: [],
    matchedWooOrderId: "",
    matchedSubscriptionId: "",
    gatewayProfileId: cleanId(payment.customerProfileId),
    paymentProfileId: cleanId(payment.customerPaymentProfileId),
    recurringPatternDetected: false,
    retryDetected: false,
    staleNextPaymentPrevented: false,
  };
}

export function buildUnifiedPaymentLedger(input: LedgerInput) {
  const customer = input.customer ?? {};
  const rows: UnifiedPaymentLedgerRow[] = [];
  const subscriptionLookup = buildSubscriptionLookup(input.subscriptions ?? []);
  const recurringAuthorizeNetTransactions = buildAuthorizeRecurringTransactionIds(input.authorizeNetTransactions ?? []);
  const recurringWooOrderIds = buildRecurringWooOrderIds(customer.orders ?? [], subscriptionLookup);

  for (const order of customer.orders ?? []) {
    const provider = order.source === "authorize_net_only"
      ? "authorize_net"
      : order.source === "nmi_quick_pay_only"
        ? "nmi_quick_pay"
        : order.gatewayVerification?.provider || "woocommerce";
    const source: UnifiedPaymentSource = provider === "authorize_net"
      ? "authorize_net"
      : provider === "nmi_quick_pay" || provider === "nmi"
        ? "nmi_quick_pay"
        : "woocommerce";
    const wooClassification = classifyWooOrigin(order, subscriptionLookup, recurringWooOrderIds);
    const gatewayStatus = order.gatewayVerification?.transactionStatus || order.status;
    const revenueType = orderRevenueType(order);

    rows.push({
      date: order.paidDate || order.attemptedDate || order.dateCreated,
      source,
      provider,
      origin: source === "woocommerce" ? wooClassification.origin : source === "nmi_quick_pay" ? "nmi" : order.source === "authorize_net_only" ? "authorize_net_manual" : "unknown_gateway",
      originClassificationReason: source === "woocommerce"
        ? wooClassification.reason
        : source === "nmi_quick_pay"
          ? "stored_nmi_order"
          : order.source === "authorize_net_only"
            ? "authorize_net_only_order"
            : "stored_gateway_order",
      transactionId: order.transactionId,
      invoiceNumber: order.orderNumber,
      productDescription: productNames(order),
      status: gatewayStatus,
      amount: money(order.total),
      cardLast4: order.gatewayVerification?.last4 || "",
      matchMethod: order.gatewayVerification?.matchedBy || order.matchedBy?.join(", ") || "",
      confidence: order.gatewayVerification?.confidence || order.matchConfidence || "",
      revenueType,
      dedupeKeys: order.orderNumber ? [`order:${order.orderNumber}`] : [],
      matchedWooOrderId: cleanId(order.orderId),
      matchedSubscriptionId: wooClassification.matchedSubscriptionId,
      gatewayProfileId: cleanId(order.gatewayVerification?.customerProfileId),
      paymentProfileId: cleanId(order.gatewayVerification?.paymentProfileId),
      recurringPatternDetected: wooClassification.origin === "woocommerce_subscription_renewal",
      retryDetected: revenueType === "attempted" && /retry|renew|subscription/i.test(`${gatewayStatus} ${productNames(order)}`),
      staleNextPaymentPrevented: false,
    });
  }

  for (const payment of customer.gatewayPayments ?? []) rows.push(gatewayRow(payment));

  for (const transaction of input.authorizeNetTransactions ?? []) {
    const transactionId = cleanId(transaction.transactionId);
    const matchedWooOrderId = cleanId(transaction.wooOrderIdMatched || transaction.wooOrderNumberMatched);
    const matchedSubscriptionId = subscriptionLookup.orderToSubscription.get(cleanId(transaction.wooOrderIdMatched))
      ?? subscriptionLookup.orderToSubscription.get(cleanId(transaction.wooOrderNumberMatched))
      ?? "";
    const recurringPatternDetected = recurringAuthorizeNetTransactions.has(transactionId)
      || recurringText(`${transaction.invoiceNumber ?? ""} ${transaction.description ?? ""}`);
    const origin = classifyAuthorizeOrigin({
      provider: "authorize_net",
      invoiceNumber: cleanId(transaction.invoiceNumber),
      productDescription: String(transaction.description ?? ""),
      matchedWooOrderId,
      matchedSubscriptionId,
      gatewayProfileId: cleanId(transaction.customerProfileId),
      paymentProfileId: cleanId(transaction.customerPaymentProfileId),
      recurringPatternDetected,
    });

    rows.push({
      date: transaction.settledAt || transaction.submittedAt || "",
      source: "authorize_net",
      provider: "authorize_net",
      origin: origin.origin,
      originClassificationReason: origin.reason,
      transactionId,
      invoiceNumber: cleanId(transaction.invoiceNumber),
      productDescription: transaction.description || "Authorize.net Payment",
      status: transaction.transactionStatus ?? "",
      amount: money(transaction.amount),
      cardLast4: transaction.cardLast4 ?? "",
      matchMethod: transaction.matchedBy || "candidate_lookup",
      confidence: transaction.matchConfidence || "medium",
      revenueType: authRevenueType(transaction.transactionStatus),
      dedupeKeys: [],
      matchedWooOrderId,
      matchedSubscriptionId,
      gatewayProfileId: cleanId(transaction.customerProfileId),
      paymentProfileId: cleanId(transaction.customerPaymentProfileId),
      recurringPatternDetected,
      retryDetected: false,
      staleNextPaymentPrevented: false,
    });
  }

  for (const transaction of input.nmiTransactions ?? []) {
    rows.push({
      date: transaction.settledAt || transaction.submittedAt || "",
      source: "nmi_quick_pay",
      provider: "nmi_quick_pay",
      origin: "nmi",
      originClassificationReason: cleanId(transaction.customerVaultId) ? "nmi_customer_vault_profile" : "nmi_transaction",
      transactionId: cleanId(transaction.transactionId),
      invoiceNumber: cleanId(transaction.invoiceNumber),
      productDescription: transaction.description || "NMI Quick Pay",
      status: transaction.transactionStatus ?? "",
      amount: money(transaction.amount),
      cardLast4: transaction.cardLast4 ?? "",
      matchMethod: transaction.matchedBy || "candidate_lookup",
      confidence: transaction.matchConfidence || "medium",
      revenueType: nmiRevenueType(transaction.transactionStatus),
      dedupeKeys: [],
      matchedWooOrderId: cleanId(transaction.wooOrderIdMatched || transaction.wooOrderNumberMatched),
      matchedSubscriptionId: subscriptionLookup.orderToSubscription.get(cleanId(transaction.wooOrderIdMatched))
        ?? subscriptionLookup.orderToSubscription.get(cleanId(transaction.wooOrderNumberMatched))
        ?? "",
      gatewayProfileId: cleanId(transaction.customerVaultId),
      paymentProfileId: cleanId(transaction.customerPaymentProfileId),
      recurringPatternDetected: recurringText(`${transaction.invoiceNumber ?? ""} ${transaction.description ?? ""}`),
      retryDetected: false,
      staleNextPaymentPrevented: false,
    });
  }

  const retryLookup = buildRetryFingerprints(rows);
  const preparedRows = rows.map((row) => {
    const fingerprint = [row.gatewayProfileId || row.paymentProfileId || row.cardLast4 || "na", amountBucket(row.amount), row.invoiceNumber || "no_invoice"].join("|");
    const retryDetected = row.revenueType === "attempted"
      && ((retryLookup.paidFingerprints.has(fingerprint) || (retryLookup.attemptedFingerprints.get(fingerprint) ?? 0) > 1)
        || row.recurringPatternDetected);
    return {
      ...row,
      retryDetected,
    };
  });

  const seen = new Set<string>();
  let duplicateSkipped = 0;
  const deduped: UnifiedPaymentLedgerRow[] = [];
  for (const row of preparedRows.sort((a, b) => parseDate(b.date) - parseDate(a.date))) {
    const keys = rowKeys(row);
    if (keys.length && keys.some((key) => seen.has(key))) {
      duplicateSkipped += 1;
      continue;
    }
    keys.forEach((key) => seen.add(key));
    deduped.push(row);
  }

  const paymentProfiles = new Set<string>();
  const metrics = deduped.reduce<UnifiedPaymentLedgerMetrics>((summary, row) => {
    if (row.gatewayProfileId) paymentProfiles.add(`customer:${row.gatewayProfileId}`);
    if (row.paymentProfileId) paymentProfiles.add(`payment:${row.paymentProfileId}`);

    if (row.revenueType === "paid") {
      summary.paidTotal += Math.abs(row.amount);
      summary.paidCount += 1;
      summary.lastSuccessfulPayment = latestDate(summary.lastSuccessfulPayment, row.date);
      if (row.origin === "woocommerce_checkout") summary.paidByWooCommerce += Math.abs(row.amount);
      if (row.origin === "woocommerce_subscription_renewal") summary.paidBySubscriptionRenewal += Math.abs(row.amount);
      if (row.origin === "authorize_net_manual") summary.paidByAuthorizeNetManual += Math.abs(row.amount);
      if (row.origin === "authorize_net_recurring" || row.origin === "authorize_net_cim_profile") summary.paidByCimRecurring += Math.abs(row.amount);
    } else if (row.revenueType === "refund") {
      summary.paidTotal -= Math.abs(row.amount);
      summary.refundTotal += Math.abs(row.amount);
    } else if (row.revenueType === "attempted") {
      summary.attemptedTotal += Math.abs(row.amount);
      summary.attemptedCount += 1;
      summary.lastFailedAttempt = latestDate(summary.lastFailedAttempt, row.date);
      summary.failedAttemptsBySource[row.origin] = (summary.failedAttemptsBySource[row.origin] ?? 0) + 1;
      if (row.retryDetected) {
        const retryCandidate = addDays(row.date, row.origin === "woocommerce_subscription_renewal" || row.recurringPatternDetected ? 3 : 7);
        if (retryCandidate) {
          summary.nextRetryAttempt = summary.nextRetryAttempt
            ? [summary.nextRetryAttempt, retryCandidate].sort((a, b) => parseDate(a) - parseDate(b))[0]
            : retryCandidate;
        }
      }
    }
    summary.lastActivity = latestDate(summary.lastActivity, row.date);
    return summary;
  }, {
    paidTotal: 0,
    attemptedTotal: 0,
    refundTotal: 0,
    paidCount: 0,
    attemptedCount: 0,
    duplicateSkipped,
    lastActivity: "",
    paidByWooCommerce: 0,
    paidBySubscriptionRenewal: 0,
    paidByAuthorizeNetManual: 0,
    paidByCimRecurring: 0,
    failedAttemptsBySource: {},
    lastFailedAttempt: "",
    nextRetryAttempt: "",
    lastSuccessfulPayment: "",
    activePaymentProfileCount: 0,
  });

  return {
    rows: deduped,
    metrics: {
      ...metrics,
      activePaymentProfileCount: paymentProfiles.size,
      paidTotal: roundMoney(Math.max(0, metrics.paidTotal)),
      attemptedTotal: roundMoney(metrics.attemptedTotal),
      refundTotal: roundMoney(metrics.refundTotal),
      paidByWooCommerce: roundMoney(metrics.paidByWooCommerce),
      paidBySubscriptionRenewal: roundMoney(metrics.paidBySubscriptionRenewal),
      paidByAuthorizeNetManual: roundMoney(metrics.paidByAuthorizeNetManual),
      paidByCimRecurring: roundMoney(metrics.paidByCimRecurring),
    },
  };
}

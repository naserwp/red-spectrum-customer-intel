import { isAuthorizeNetPaidStatus, isDeclinedOrFailed, isRefundedOrChargeback } from "@/lib/authorizeNet";
import { isNmiDeclined, isNmiRefundOrChargeback, isNmiSuccessful } from "@/lib/nmiQuickPay";
import type { AuthorizeNetTransactionDocument } from "@/models/AuthorizeNetTransaction";
import type { CustomerDocument, CustomerGatewayPayment, CustomerOrderHistoryItem } from "@/models/Customer";
import type { NmiQuickPayTransactionDocument } from "@/models/NmiQuickPayTransaction";
import type { StripeTransactionDocument } from "@/models/StripeTransaction";
import type { WooCommerceOrderDocument } from "@/models/WooCommerceOrder";
import type { WooCommerceSubscriptionDocument } from "@/models/WooCommerceSubscription";

type ValueCustomer = Partial<CustomerDocument> & {
  orders?: CustomerOrderHistoryItem[];
  gatewayPayments?: CustomerGatewayPayment[];
};

type PaidSource = "woocommerce" | "authorize_net" | "gateway_only" | "nmi_quick_pay" | "stripe" | "subscription";

type PaidRecord = {
  amount: number;
  date: string;
  transactionId?: string;
  invoiceNumber?: string;
  orderNumber?: string;
  provider?: string;
  source: PaidSource;
};

export type CustomerValueMetrics = {
  wooPaidTotal: number;
  authorizeNetPaidTotal: number;
  gatewayOnlyPaidTotal: number;
  nmiQuickPayPaidTotal: number;
  stripePaidTotal: number;
  subscriptionPaidTotal: number;
  attemptedTotal: number;
  attemptedGatewayTotal: number;
  refundsAndChargebacksDetected: boolean;
  duplicateSkipped: number;
  firstPaidDate: string;
  lastPaidDate: string;
  paidMonths: number;
  activeSubscriptionStatus: string;
  rankingTotal: number;
  subscriptionStartDate: string;
  stayWithUsMonths: number;
  gatewayApprovalRate: number;
};

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function dateKey(value?: string) {
  return value ? value.slice(0, 10) : "";
}

function amountDateKey(amount: unknown, date?: string) {
  const rounded = roundMoney(Number(amount ?? 0)).toFixed(2);
  const day = dateKey(date);
  return rounded !== "0.00" && day ? `${rounded}:${day}` : "";
}

function monthKey(value?: string) {
  return value ? value.slice(0, 7) : "";
}

function isValidDate(value?: string) {
  if (!value) return false;
  return !Number.isNaN(new Date(value).getTime());
}

export function monthsSince(value?: string) {
  if (!isValidDate(value)) return 0;
  const date = new Date(value as string);
  const now = new Date();
  return Math.max(0, (now.getFullYear() - date.getFullYear()) * 12 + now.getMonth() - date.getMonth() + 1);
}

function paidRecordKeys(record: PaidRecord) {
  const amount = roundMoney(record.amount).toFixed(2);
  const date = dateKey(record.date);
  const keys: string[] = [];
  const adjustment = record.amount < 0 ? "adjustment:" : "";
  if (record.transactionId) keys.push(`tx:${record.provider ?? record.source}:${record.transactionId}`);
  if (record.orderNumber) keys.push(`${adjustment}order:${record.orderNumber}`);
  if (record.invoiceNumber) keys.push(`${adjustment}invoice:${record.invoiceNumber}`);
  if (record.invoiceNumber && date) keys.push(`${adjustment}invoice-date:${record.invoiceNumber}:${amount}:${date}`);
  if (!keys.length) keys.push(`fallback:${record.source}:${amount}:${date}`);
  return keys;
}

function addPaidRecord(record: PaidRecord, seen: Set<string>, totals: Record<PaidSource, number>, monthKeys: Set<string>) {
  if (!record.amount) return 0;
  const keys = paidRecordKeys(record);
  if (keys.some((key) => seen.has(key))) return 1;
  keys.forEach((key) => seen.add(key));
  totals[record.source] += Number(record.amount);
  const month = monthKey(record.date);
  if (month && record.amount > 0) monthKeys.add(month);
  return 0;
}

function minDate(values: string[]) {
  return values.filter(isValidDate).sort((a, b) => new Date(a).getTime() - new Date(b).getTime())[0] ?? "";
}

function maxDate(values: string[]) {
  return values.filter(isValidDate).sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0] ?? "";
}

function isGatewayPaid(payment: CustomerGatewayPayment) {
  return isAuthorizeNetPaidStatus(payment.status) || /paid|settled/i.test(payment.status ?? "");
}

function signedGatewayAmount(status: string, amount: number) {
  if (isRefundedOrChargeback(status)) return -Math.abs(amount);
  if (isAuthorizeNetPaidStatus(status) || /paid|settled/i.test(status ?? "")) return Math.abs(amount);
  return 0;
}

function isAttemptedGatewayStatus(status: string) {
  return isDeclinedOrFailed(status) || /pending|captured|hold/i.test(status ?? "");
}

function isStripePaidStatus(status: string) {
  return /succeeded|paid|settled|captured/i.test(status ?? "");
}

function isStripeRefundOrChargeback(status: string) {
  return /refund|dispute|chargeback/i.test(status ?? "");
}

function isStripeAttemptedStatus(status: string) {
  return /failed|declined|canceled|pending|requires|uncaptured/i.test(status ?? "");
}

export function calculateCustomerValueMetrics(input: {
  customer?: ValueCustomer | null;
  wooOrders?: Partial<WooCommerceOrderDocument>[];
  authorizeNetTransactions?: Partial<AuthorizeNetTransactionDocument>[];
  nmiTransactions?: Partial<NmiQuickPayTransactionDocument>[];
  stripeTransactions?: Partial<StripeTransactionDocument>[];
  subscriptions?: Partial<WooCommerceSubscriptionDocument>[];
}): CustomerValueMetrics {
  const customer = input.customer ?? {};
  const seen = new Set<string>();
  const wooAmountDateKeys = new Set<string>();
  const monthKeys = new Set<string>();
  const paidDates: string[] = [];
  const totals: Record<PaidSource, number> = { woocommerce: 0, authorize_net: 0, gateway_only: 0, nmi_quick_pay: 0, stripe: 0, subscription: 0 };
  let duplicateSkipped = 0;
  let attemptedGatewayTotal = 0;
  let hasNegativeGatewayRecord = false;

  for (const order of input.wooOrders ?? []) {
    if (!order.isPaid) continue;
    const date = order.dateCreated ?? "";
    const fingerprint = amountDateKey(order.paidAmount ?? order.total, date);
    if (fingerprint) wooAmountDateKeys.add(fingerprint);
    paidDates.push(date);
    duplicateSkipped += addPaidRecord({
      amount: Number(order.paidAmount ?? order.total ?? 0),
      date,
      transactionId: order.transactionId,
      orderNumber: order.orderNumber,
      invoiceNumber: order.orderNumber,
      provider: "woocommerce",
      source: "woocommerce",
    }, seen, totals, monthKeys);
  }

  for (const order of customer.orders ?? []) {
    if (!order.isPaid) continue;
    const source: PaidSource = order.source === "authorize_net_only" ? "gateway_only" : order.source === "stripe_only" ? "stripe" : "woocommerce";
    const date = order.paidDate || order.dateCreated;
    if (source === "woocommerce") {
      const fingerprint = amountDateKey(order.total, date);
      if (fingerprint) wooAmountDateKeys.add(fingerprint);
    }
    paidDates.push(date);
    duplicateSkipped += addPaidRecord({
      amount: Number(order.total ?? 0),
      date,
      transactionId: order.transactionId,
      orderNumber: order.orderNumber,
      invoiceNumber: order.orderNumber,
      provider: source === "gateway_only" ? "authorize_net" : source === "stripe" ? "stripe" : "woocommerce",
      source,
    }, seen, totals, monthKeys);
  }

  for (const payment of customer.gatewayPayments ?? []) {
    const stripePayment = payment.provider === "stripe";
    const paidLike = stripePayment ? isStripePaidStatus(payment.status) : isGatewayPaid(payment);
    const refundLike = stripePayment ? isStripeRefundOrChargeback(payment.status) : isRefundedOrChargeback(payment.status);
    if (!paidLike && !refundLike) {
      if (stripePayment ? isStripeAttemptedStatus(payment.status) : isAttemptedGatewayStatus(payment.status)) attemptedGatewayTotal += Math.abs(Number(payment.amount ?? 0));
      continue;
    }
    const source: PaidSource = payment.provider === "nmi" || payment.provider === "cliq" || payment.provider === "nmi_quick_pay" || payment.source === "nmi_quick_pay_only"
      ? "nmi_quick_pay"
      : stripePayment || payment.source === "stripe_only" ? "stripe"
      : payment.source === "authorize_net_only" ? "gateway_only" : "authorize_net";
    const nmiPayment = source === "nmi_quick_pay";
    const stripeSource = source === "stripe";
    if (nmiPayment && !isNmiSuccessful(payment.status) && !isNmiRefundOrChargeback(payment.status)) {
      if (isNmiDeclined(payment.status)) attemptedGatewayTotal += Math.abs(Number(payment.amount ?? 0));
      continue;
    }
    const signedAmount = nmiPayment
      ? isNmiRefundOrChargeback(payment.status) ? -Math.abs(Number(payment.amount ?? 0)) : Math.abs(Number(payment.amount ?? 0))
      : stripeSource
        ? isStripeRefundOrChargeback(payment.status) ? -Math.abs(Number(payment.amount ?? 0)) : Math.abs(Number(payment.amount ?? 0))
      : signedGatewayAmount(payment.status, Number(payment.amount ?? 0));
    const gatewayDuplicatesWoo = !nmiPayment && signedAmount > 0 && wooAmountDateKeys.has(amountDateKey(signedAmount, payment.date));
    if (gatewayDuplicatesWoo) {
      duplicateSkipped += 1;
      continue;
    }
    if (signedAmount < 0) hasNegativeGatewayRecord = true;
    paidDates.push(payment.date);
    duplicateSkipped += addPaidRecord({
      amount: signedAmount,
      date: payment.date,
      transactionId: payment.transactionId,
      invoiceNumber: payment.invoiceNumber,
      provider: payment.provider || (nmiPayment ? "nmi_quick_pay" : stripeSource ? "stripe" : "authorize_net"),
      source,
    }, seen, totals, monthKeys);
  }

  for (const transaction of input.authorizeNetTransactions ?? []) {
    const status = transaction.transactionStatus ?? "";
    if (!isAuthorizeNetPaidStatus(status) && !isRefundedOrChargeback(status)) {
      if (isAttemptedGatewayStatus(status)) attemptedGatewayTotal += Math.abs(Number(transaction.amount ?? 0));
      continue;
    }
    const date = transaction.settledAt || transaction.submittedAt || "";
    const signedAmount = isRefundedOrChargeback(status) ? -Math.abs(Number(transaction.amount ?? 0)) : Math.abs(Number(transaction.amount ?? 0));
    if (signedAmount > 0 && wooAmountDateKeys.has(amountDateKey(signedAmount, date))) {
      duplicateSkipped += 1;
      continue;
    }
    if (signedAmount < 0) hasNegativeGatewayRecord = true;
    paidDates.push(date);
    duplicateSkipped += addPaidRecord({
      amount: signedAmount,
      date,
      transactionId: transaction.transactionId,
      invoiceNumber: transaction.invoiceNumber,
      provider: "authorize_net",
      source: transaction.wooOrderNumberMatched || transaction.wooOrderIdMatched ? "authorize_net" : "gateway_only",
    }, seen, totals, monthKeys);
  }

  for (const transaction of input.nmiTransactions ?? []) {
    const status = transaction.transactionStatus ?? "";
    if (!isNmiSuccessful(status) && !isNmiRefundOrChargeback(status)) {
      if (isNmiDeclined(status)) attemptedGatewayTotal += Math.abs(Number(transaction.amount ?? 0));
      continue;
    }
    const date = transaction.settledAt || transaction.submittedAt || "";
    const signedAmount = isNmiRefundOrChargeback(status) ? -Math.abs(Number(transaction.amount ?? 0)) : Math.abs(Number(transaction.amount ?? 0));
    if (signedAmount < 0) hasNegativeGatewayRecord = true;
    paidDates.push(date);
    duplicateSkipped += addPaidRecord({
      amount: signedAmount,
      date,
      transactionId: transaction.transactionId,
      invoiceNumber: transaction.invoiceNumber,
      provider: "nmi_quick_pay",
      source: "nmi_quick_pay",
    }, seen, totals, monthKeys);
  }

  for (const transaction of input.stripeTransactions ?? []) {
    const status = transaction.status ?? "";
    if (!isStripePaidStatus(status) && !isStripeRefundOrChargeback(status)) {
      if (isStripeAttemptedStatus(status)) attemptedGatewayTotal += Math.abs(Number(transaction.amount ?? 0));
      continue;
    }
    const date = transaction.paidAt || transaction.stripeCreatedAt || "";
    const signedAmount = isStripeRefundOrChargeback(status) ? -Math.abs(Number(transaction.amount ?? 0)) : Math.abs(Number(transaction.amount ?? 0));
    if (signedAmount > 0 && wooAmountDateKeys.has(amountDateKey(signedAmount, date))) {
      duplicateSkipped += 1;
      continue;
    }
    if (signedAmount < 0) hasNegativeGatewayRecord = true;
    paidDates.push(date);
    duplicateSkipped += addPaidRecord({
      amount: signedAmount,
      date,
      transactionId: transaction.transactionId || transaction.chargeId,
      invoiceNumber: transaction.invoiceNumber,
      provider: "stripe",
      source: "stripe",
    }, seen, totals, monthKeys);
  }

  const activeSubscription = (input.subscriptions ?? []).find((sub) => String(sub.status ?? "").toLowerCase() === "active");
  const subscriptionStartDate = minDate((input.subscriptions ?? []).map((sub) => String(sub.startDate ?? "")).filter(Boolean));
  const subscriptionOrderIds = new Set((input.subscriptions ?? []).flatMap((sub) => sub.relatedOrderIds ?? []).map(String));
  const subscriptionPaidTotal = (input.wooOrders ?? []).reduce((sum, order) => {
    if (!order.isPaid) return sum;
    const orderId = String(order.wooOrderId ?? "");
    const orderNumber = String(order.orderNumber ?? "");
    return subscriptionOrderIds.has(orderId) || subscriptionOrderIds.has(orderNumber) ? sum + Number(order.paidAmount ?? order.total ?? 0) : sum;
  }, 0);

  const dedupedTotal = Math.max(0, totals.woocommerce + totals.authorize_net + totals.gateway_only + totals.nmi_quick_pay + totals.stripe);
  const storedPaidTotal = Math.max(Number(customer.paidTotal ?? 0), Number(customer.totalPaid ?? 0));
  const rankingTotal = roundMoney(hasNegativeGatewayRecord ? dedupedTotal : Math.max(dedupedTotal, storedPaidTotal));
  const firstPaidDate = minDate([subscriptionStartDate, customer.firstSignupDate ?? "", customer.firstOrderDate ?? "", ...paidDates]);
  const lastPaidDate = maxDate([customer.lastPaidDate ?? "", ...paidDates, ...(input.subscriptions ?? []).map((sub) => String(sub.lastPaymentDate ?? ""))]);

  return {
    wooPaidTotal: roundMoney(totals.woocommerce),
    authorizeNetPaidTotal: roundMoney(totals.authorize_net),
    gatewayOnlyPaidTotal: roundMoney(totals.gateway_only),
    nmiQuickPayPaidTotal: roundMoney(totals.nmi_quick_pay),
    stripePaidTotal: roundMoney(totals.stripe),
    subscriptionPaidTotal: roundMoney(subscriptionPaidTotal),
    attemptedTotal: roundMoney(Math.max(Number(customer.attemptedTotal ?? 0), attemptedGatewayTotal)),
    attemptedGatewayTotal: roundMoney(attemptedGatewayTotal),
    refundsAndChargebacksDetected: hasNegativeGatewayRecord,
    duplicateSkipped,
    firstPaidDate,
    lastPaidDate,
    paidMonths: Math.max(monthKeys.size, Number(customer.paidMonths ?? 0), Number(customer.paidOrderCount ?? 0)),
    activeSubscriptionStatus: activeSubscription ? "active" : "",
    rankingTotal,
    subscriptionStartDate,
    stayWithUsMonths: monthsSince(firstPaidDate),
    gatewayApprovalRate: Math.round(Math.max(0, ((totals.authorize_net + totals.gateway_only + totals.nmi_quick_pay + totals.stripe) / Math.max(1, totals.authorize_net + totals.gateway_only + totals.nmi_quick_pay + totals.stripe + attemptedGatewayTotal)) * 100)),
  };
}

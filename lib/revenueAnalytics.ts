import { isSettledSuccessful } from "@/lib/authorizeNet";
import type { AuthorizeNetTransactionDocument } from "@/models/AuthorizeNetTransaction";
import type { CustomerGatewayPayment, CustomerOrderHistoryItem } from "@/models/Customer";
import type { WooCommerceOrderDocument } from "@/models/WooCommerceOrder";
import type { WooCommerceSubscriptionDocument } from "@/models/WooCommerceSubscription";

export type PaidLedgerRecord = {
  customerId?: string;
  customerName?: string;
  email?: string;
  source: "woocommerce" | "authorize_net" | "gateway_only";
  provider?: string;
  amount: number;
  date: string;
  transactionId?: string;
  invoiceNumber?: string;
  orderNumber?: string;
  paymentMethod?: string;
};

export type GatewayRecurringSummary = {
  isGatewayRecurring: boolean;
  recurringSource: "authorize_net" | "";
  recurringAmount: number;
  recurringFrequencyEstimate: string;
  recurringLastPayment: string;
  recurringNextEstimatedPayment: string;
  recurringPaymentCount: number;
};

type LedgerCustomer = {
  _id?: unknown;
  name?: string;
  email?: string;
  normalizedEmail?: string;
  orders?: CustomerOrderHistoryItem[];
  gatewayPayments?: CustomerGatewayPayment[];
};

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function validDate(value?: string) {
  if (!value) return false;
  return !Number.isNaN(new Date(value).getTime());
}

export function dateInRange(value: string, from?: Date, to?: Date) {
  if (!validDate(value)) return false;
  const time = new Date(value).getTime();
  return (!from || time >= from.getTime()) && (!to || time <= to.getTime());
}

export function monthStart(date = new Date()) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

export function monthEnd(date = new Date()) {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0, 23, 59, 59, 999);
}

export function addDays(value: string, days: number) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  date.setDate(date.getDate() + days);
  return date.toISOString();
}

export function monthsBetween(start?: string, end = new Date()) {
  if (!validDate(start)) return 0;
  const date = new Date(start as string);
  return Math.max(0, (end.getFullYear() - date.getFullYear()) * 12 + end.getMonth() - date.getMonth() + 1);
}

function amountBucket(amount: number) {
  return Math.round(Number(amount ?? 0));
}

function median(values: number[]) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  return sorted[Math.floor(sorted.length / 2)];
}

function recordKeys(record: PaidLedgerRecord) {
  const amount = roundMoney(record.amount).toFixed(2);
  const date = record.date?.slice(0, 10) ?? "";
  return [
    record.transactionId ? `tx:${record.provider ?? record.source}:${record.transactionId}` : "",
    record.orderNumber ? `order:${record.orderNumber}` : "",
    record.invoiceNumber ? `invoice:${record.invoiceNumber}` : "",
    record.invoiceNumber && date ? `invoice-date:${record.invoiceNumber}:${amount}:${date}` : "",
  ].filter(Boolean);
}

export function dedupePaidRecords(records: PaidLedgerRecord[]) {
  const seen = new Set<string>();
  const deduped: PaidLedgerRecord[] = [];
  let duplicateSkipped = 0;
  for (const record of records) {
    if (!record.amount || record.amount <= 0 || !record.date) continue;
    const keys = recordKeys(record);
    if (keys.length && keys.some((key) => seen.has(key))) {
      duplicateSkipped += 1;
      continue;
    }
    keys.forEach((key) => seen.add(key));
    deduped.push(record);
  }
  return { records: deduped, duplicateSkipped };
}

function isGatewayPaid(payment: CustomerGatewayPayment) {
  return isSettledSuccessful(payment.status) || /paid|settled/i.test(payment.status ?? "");
}

export function customerLedgerRecords(customer: LedgerCustomer) {
  const rows: PaidLedgerRecord[] = [];
  for (const order of customer.orders ?? []) {
    if (!order.isPaid) continue;
    const source = order.source === "authorize_net_only" ? "gateway_only" : "woocommerce";
    rows.push({
      customerId: customer._id ? String(customer._id) : "",
      customerName: customer.name,
      email: customer.normalizedEmail || customer.email,
      source,
      provider: source === "gateway_only" ? "authorize_net" : "woocommerce",
      amount: Number(order.total ?? 0),
      date: order.paidDate || order.dateCreated,
      transactionId: order.transactionId,
      invoiceNumber: order.orderNumber,
      orderNumber: order.orderNumber,
      paymentMethod: order.paymentMethodTitle || order.paymentMethod,
    });
  }
  for (const payment of customer.gatewayPayments ?? []) {
    if (!isGatewayPaid(payment)) continue;
    rows.push({
      customerId: customer._id ? String(customer._id) : "",
      customerName: customer.name,
      email: customer.normalizedEmail || customer.email,
      source: payment.source === "authorize_net_only" ? "gateway_only" : "authorize_net",
      provider: payment.provider || "authorize_net",
      amount: Number(payment.amount ?? 0),
      date: payment.date,
      transactionId: payment.transactionId,
      invoiceNumber: payment.invoiceNumber,
      orderNumber: payment.invoiceNumber,
      paymentMethod: "Credit Card Payment",
    });
  }
  return rows;
}

export function wooOrderLedgerRecords(orders: Partial<WooCommerceOrderDocument>[]) {
  return orders.filter((order) => order.isPaid).map((order) => ({
    email: order.normalizedEmail || order.billingEmail,
    customerName: order.billingName,
    source: "woocommerce" as const,
    provider: "woocommerce",
    amount: Number(order.paidAmount ?? order.total ?? 0),
    date: order.dateCreated ?? "",
    transactionId: order.transactionId,
    invoiceNumber: order.orderNumber,
    orderNumber: order.orderNumber,
    paymentMethod: order.paymentMethodTitle || order.paymentMethod,
  }));
}

export function authorizeNetLedgerRecords(transactions: Partial<AuthorizeNetTransactionDocument>[]) {
  return transactions.filter((transaction) => isSettledSuccessful(transaction.transactionStatus ?? "")).map((transaction) => ({
    customerId: transaction.matchedCustomerId,
    customerName: transaction.customerName,
    email: transaction.normalizedEmail || transaction.emailNormalized || transaction.customerEmail,
    source: (transaction.wooOrderNumberMatched || transaction.wooOrderIdMatched ? "authorize_net" : "gateway_only") as "authorize_net" | "gateway_only",
    provider: "authorize_net",
    amount: Number(transaction.amount ?? 0),
    date: transaction.settledAt || transaction.submittedAt || "",
    transactionId: transaction.transactionId,
    invoiceNumber: transaction.invoiceNumber,
    orderNumber: transaction.invoiceNumber,
    paymentMethod: "Credit Card Payment",
  }));
}

export function detectAuthorizeNetRecurring(records: PaidLedgerRecord[]): GatewayRecurringSummary {
  const authorizePayments = records
    .filter((record) => record.provider === "authorize_net" && record.amount > 0 && validDate(record.date))
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  const groups = new Map<number, PaidLedgerRecord[]>();
  for (const payment of authorizePayments) {
    const key = amountBucket(payment.amount);
    groups.set(key, [...(groups.get(key) ?? []), payment]);
  }
  const candidates = Array.from(groups.values()).filter((group) => group.length >= 2);
  let best: PaidLedgerRecord[] = [];
  for (const group of candidates) {
    const intervals = group.slice(1).map((payment, index) => Math.round((new Date(payment.date).getTime() - new Date(group[index].date).getTime()) / 86400000));
    const monthlyLike = intervals.some((days) => days >= 20 && days <= 45);
    const invoiceLike = group.some((payment) => /sub|renew|recurr|month|membership|plan/i.test(`${payment.invoiceNumber ?? ""} ${payment.orderNumber ?? ""}`));
    if ((monthlyLike || invoiceLike) && group.length > best.length) best = group;
  }
  if (best.length < 2) return { isGatewayRecurring: false, recurringSource: "", recurringAmount: 0, recurringFrequencyEstimate: "", recurringLastPayment: "", recurringNextEstimatedPayment: "", recurringPaymentCount: 0 };
  const intervals = best.slice(1).map((payment, index) => Math.round((new Date(payment.date).getTime() - new Date(best[index].date).getTime()) / 86400000)).filter((days) => days > 0);
  const intervalDays = Math.max(28, Math.min(31, median(intervals) || 30));
  const last = best[best.length - 1];
  return {
    isGatewayRecurring: true,
    recurringSource: "authorize_net",
    recurringAmount: roundMoney(best.reduce((sum, payment) => sum + payment.amount, 0) / best.length),
    recurringFrequencyEstimate: intervalDays >= 55 ? `${intervalDays} days` : "monthly",
    recurringLastPayment: last.date,
    recurringNextEstimatedPayment: addDays(last.date, intervalDays),
    recurringPaymentCount: best.length,
  };
}

export function wooSubscriptionMrr(subscriptions: Partial<WooCommerceSubscriptionDocument>[]) {
  return subscriptions
    .filter((subscription) => String(subscription.status ?? "").toLowerCase() === "active")
    .reduce((sum, subscription) => sum + Number(subscription.recurringTotal ?? subscription.amount ?? 0), 0);
}

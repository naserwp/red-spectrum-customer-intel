import { isDeclinedOrFailed, isRefundedOrChargeback, isSettledSuccessful } from "@/lib/authorizeNet";
import { isNmiDeclined, isNmiRefundOrChargeback, isNmiSuccessful } from "@/lib/nmiQuickPay";
import type { AuthorizeNetTransactionDocument } from "@/models/AuthorizeNetTransaction";
import type { CustomerDocument, CustomerGatewayPayment, CustomerOrderHistoryItem } from "@/models/Customer";
import type { NmiQuickPayTransactionDocument } from "@/models/NmiQuickPayTransaction";

export type UnifiedPaymentSource = "woocommerce" | "authorize_net" | "nmi_quick_pay";
export type UnifiedPaymentLedgerRow = {
  date: string;
  source: UnifiedPaymentSource;
  provider: string;
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
};

export type UnifiedPaymentLedgerMetrics = {
  paidTotal: number;
  attemptedTotal: number;
  refundTotal: number;
  paidCount: number;
  attemptedCount: number;
  duplicateSkipped: number;
  lastActivity: string;
};

type LedgerInput = {
  customer?: Partial<CustomerDocument> | null;
  authorizeNetTransactions?: Partial<AuthorizeNetTransactionDocument>[];
  nmiTransactions?: Partial<NmiQuickPayTransactionDocument>[];
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

function gatewayRow(payment: CustomerGatewayPayment): UnifiedPaymentLedgerRow {
  const provider = payment.provider === "nmi" || payment.provider === "cliq" ? "nmi_quick_pay" : payment.provider || "authorize_net";
  const source: UnifiedPaymentSource = provider === "nmi_quick_pay" ? "nmi_quick_pay" : "authorize_net";
  const revenueType = source === "nmi_quick_pay" ? nmiRevenueType(payment.status) : authRevenueType(payment.status);
  return {
    date: payment.date,
    source,
    provider,
    transactionId: payment.transactionId,
    invoiceNumber: payment.invoiceNumber,
    productDescription: source === "nmi_quick_pay" ? "NMI Quick Pay" : "Authorize.net Payment",
    status: payment.status,
    amount: money(payment.amount),
    cardLast4: payment.cardLast4,
    matchMethod: payment.matchedBy,
    confidence: payment.matchConfidence,
    revenueType,
    dedupeKeys: [],
  };
}

export function buildUnifiedPaymentLedger(input: LedgerInput) {
  const customer = input.customer ?? {};
  const rows: UnifiedPaymentLedgerRow[] = [];

  for (const order of customer.orders ?? []) {
    const provider = order.source === "authorize_net_only" ? "authorize_net" : order.source === "nmi_quick_pay_only" ? "nmi_quick_pay" : order.gatewayVerification?.provider || "woocommerce";
    rows.push({
      date: order.paidDate || order.attemptedDate || order.dateCreated,
      source: provider === "authorize_net" ? "authorize_net" : provider === "nmi_quick_pay" || provider === "nmi" ? "nmi_quick_pay" : "woocommerce",
      provider,
      transactionId: order.transactionId,
      invoiceNumber: order.orderNumber,
      productDescription: productNames(order),
      status: order.gatewayVerification?.transactionStatus || order.status,
      amount: money(order.total),
      cardLast4: order.gatewayVerification?.last4 || "",
      matchMethod: order.gatewayVerification?.matchedBy || order.matchedBy?.join(", ") || "",
      confidence: order.gatewayVerification?.confidence || order.matchConfidence || "",
      revenueType: orderRevenueType(order),
      dedupeKeys: order.orderNumber ? [`order:${order.orderNumber}`] : [],
    });
  }

  for (const payment of customer.gatewayPayments ?? []) rows.push(gatewayRow(payment));

  for (const transaction of input.authorizeNetTransactions ?? []) {
    rows.push({
      date: transaction.settledAt || transaction.submittedAt || "",
      source: "authorize_net",
      provider: "authorize_net",
      transactionId: transaction.transactionId ?? "",
      invoiceNumber: transaction.invoiceNumber ?? "",
      productDescription: transaction.description || "Authorize.net Payment",
      status: transaction.transactionStatus ?? "",
      amount: money(transaction.amount),
      cardLast4: transaction.cardLast4 ?? "",
      matchMethod: transaction.matchedBy || "candidate_lookup",
      confidence: transaction.matchConfidence || "medium",
      revenueType: authRevenueType(transaction.transactionStatus),
      dedupeKeys: [],
    });
  }

  for (const transaction of input.nmiTransactions ?? []) {
    rows.push({
      date: transaction.settledAt || transaction.submittedAt || "",
      source: "nmi_quick_pay",
      provider: "nmi_quick_pay",
      transactionId: transaction.transactionId ?? "",
      invoiceNumber: transaction.invoiceNumber ?? "",
      productDescription: transaction.description || "NMI Quick Pay",
      status: transaction.transactionStatus ?? "",
      amount: money(transaction.amount),
      cardLast4: transaction.cardLast4 ?? "",
      matchMethod: transaction.matchedBy || "candidate_lookup",
      confidence: transaction.matchConfidence || "medium",
      revenueType: nmiRevenueType(transaction.transactionStatus),
      dedupeKeys: [],
    });
  }

  const seen = new Set<string>();
  let duplicateSkipped = 0;
  const deduped: UnifiedPaymentLedgerRow[] = [];
  for (const row of rows.sort((a, b) => new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime())) {
    const keys = rowKeys(row);
    if (keys.length && keys.some((key) => seen.has(key))) {
      duplicateSkipped += 1;
      continue;
    }
    keys.forEach((key) => seen.add(key));
    deduped.push(row);
  }

  const metrics = deduped.reduce<UnifiedPaymentLedgerMetrics>((summary, row) => {
    if (row.revenueType === "paid") {
      summary.paidTotal += Math.abs(row.amount);
      summary.paidCount += 1;
    } else if (row.revenueType === "refund") {
      summary.paidTotal -= Math.abs(row.amount);
      summary.refundTotal += Math.abs(row.amount);
    } else if (row.revenueType === "attempted") {
      summary.attemptedTotal += Math.abs(row.amount);
      summary.attemptedCount += 1;
    }
    summary.lastActivity = latestDate(summary.lastActivity, row.date);
    return summary;
  }, { paidTotal: 0, attemptedTotal: 0, refundTotal: 0, paidCount: 0, attemptedCount: 0, duplicateSkipped, lastActivity: "" });

  return {
    rows: deduped,
    metrics: {
      ...metrics,
      paidTotal: roundMoney(Math.max(0, metrics.paidTotal)),
      attemptedTotal: roundMoney(metrics.attemptedTotal),
      refundTotal: roundMoney(metrics.refundTotal),
    },
  };
}

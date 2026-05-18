import { NextResponse } from "next/server";
import { connectToDatabase } from "@/lib/mongodb";
import { Customer, type CustomerDocument, type CustomerOrderHistoryItem } from "@/models/Customer";

export const dynamic = "force-dynamic";

type Provider = "authorize_net" | "nmi" | "stripe" | "crypto" | "woocommerce" | "unknown";
type StatusFilter = "all" | "paid" | "attempted" | "failed" | "refunded" | "verified" | "not_verified";
type Interval = "lifetime" | "year" | "month" | "week" | "day";

type Metric = {
  paidRevenue: number;
  attemptedPipeline: number;
  failedAmount: number;
  refundedAmount: number;
  totalOrders: number;
  paidOrders: number;
  attemptedOrders: number;
  failedOrders: number;
  verifiedRevenue: number;
  unverifiedPaidRevenue: number;
  manualReviewRevenue: number;
  matchedOrders: number;
  unmatchedOrders: number;
  lastTransactionDate: string;
};

type TimelineMetric = Omit<Metric, "totalOrders" | "matchedOrders" | "unmatchedOrders" | "manualReviewRevenue" | "lastTransactionDate"> & {
  period: string;
  provider: Provider;
};

type CustomerGatewayMetric = {
  provider: Provider;
  customerName: string;
  email: string;
  paidRevenue: number;
  attemptedPipeline: number;
  orderCount: number;
  lastOrderDate: string;
};

const defaultProviders: Provider[] = ["authorize_net", "nmi", "stripe", "crypto", "woocommerce", "unknown"];
const statusFilters: StatusFilter[] = ["all", "paid", "attempted", "failed", "refunded", "verified", "not_verified"];
const intervals: Interval[] = ["lifetime", "year", "month", "week", "day"];
const paidStatuses = new Set(["completed", "processing", "paid"]);
const attemptedStatuses = new Set(["pending", "failed", "cancelled", "canceled", "on-hold", "checkout-draft", "payment_pending", "crypto_pending", "refunded"]);
const failedGatewayStatuses = ["failed", "declined"];

function emptyMetric(): Metric {
  return {
    paidRevenue: 0,
    attemptedPipeline: 0,
    failedAmount: 0,
    refundedAmount: 0,
    totalOrders: 0,
    paidOrders: 0,
    attemptedOrders: 0,
    failedOrders: 0,
    verifiedRevenue: 0,
    unverifiedPaidRevenue: 0,
    manualReviewRevenue: 0,
    matchedOrders: 0,
    unmatchedOrders: 0,
    lastTransactionDate: "",
  };
}

function parseDateParam(value: string | null, fallback: Date, endOfDay = false) {
  if (!value) return fallback;
  const parsed = new Date(`${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}`);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

function orderDate(order: CustomerOrderHistoryItem) {
  const date = new Date(order.dateCreated || order.gatewayVerification?.transactionDate || "");
  return Number.isNaN(date.getTime()) ? null : date;
}

function money(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function statusOf(order: CustomerOrderHistoryItem) {
  return (order.status ?? "").trim().toLowerCase();
}

function isPaid(order: CustomerOrderHistoryItem) {
  return Boolean(order.isPaid) || paidStatuses.has(statusOf(order));
}

function isAttempted(order: CustomerOrderHistoryItem) {
  return Boolean(order.isAttempted) || attemptedStatuses.has(statusOf(order));
}

function isFailed(order: CustomerOrderHistoryItem) {
  const gatewayStatus = (order.gatewayVerification?.transactionStatus ?? "").toLowerCase();
  return statusOf(order) === "failed" || failedGatewayStatuses.some((status) => gatewayStatus.includes(status));
}

function isRefunded(order: CustomerOrderHistoryItem) {
  return statusOf(order) === "refunded" || Number(order.refundsCount ?? 0) > 0 || Number(order.refundsAmount ?? 0) > 0;
}

function normalizeProviderValue(value: string): Provider | "" {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return "";
  if (normalized.includes("authorize_net") || normalized.includes("authorize.net") || normalized.includes("authorize") || normalized.includes("cim")) return "authorize_net";
  if (normalized.includes("nmi") || normalized.includes("quick pay") || normalized.includes("cliq")) return "nmi";
  if (normalized.includes("stripe") || normalized.includes("payment_intent") || normalized.includes("payment intent")) return "stripe";
  if (normalized.includes("crypto")) return "crypto";
  if (normalized.includes("manual") || normalized.includes("woocommerce")) return "woocommerce";
  if (normalized === "unknown_gateway" || normalized.includes("unknown")) return "unknown";
  return "";
}

function normalizeProvider(order: CustomerOrderHistoryItem): Provider {
  const verificationProvider = normalizeProviderValue(order.gatewayVerification?.provider ?? "");
  if (verificationProvider) return verificationProvider;

  const method = `${order.paymentMethod ?? ""} ${order.paymentMethodTitle ?? ""}`.toLowerCase();
  const inferred = normalizeProviderValue(method);
  if (inferred) return inferred;
  if (method.includes("credit card payment")) return "authorize_net";
  if (!method.trim()) return "woocommerce";
  return "unknown";
}

function periodFor(date: Date, interval: Interval) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  if (interval === "lifetime") return "Lifetime";
  if (interval === "year") return String(year);
  if (interval === "month") return `${year}-${month}`;
  if (interval === "day") return `${year}-${month}-${day}`;

  const target = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNumber = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - dayNumber);
  const weekYear = target.getUTCFullYear();
  const yearStart = new Date(Date.UTC(weekYear, 0, 1));
  const week = Math.ceil((((target.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${weekYear}-W${String(week).padStart(2, "0")}`;
}

function includeStatus(order: CustomerOrderHistoryItem, status: StatusFilter) {
  if (status === "all") return true;
  if (status === "paid") return isPaid(order);
  if (status === "attempted") return isAttempted(order);
  if (status === "failed") return isFailed(order);
  if (status === "refunded") return isRefunded(order);
  if (status === "verified") return Boolean(order.gatewayVerification?.matched);
  if (status === "not_verified") return !order.gatewayVerification?.matched;
  return true;
}

function latestDate(a: string, b: string) {
  if (!a) return b;
  if (!b) return a;
  return new Date(b).getTime() > new Date(a).getTime() ? b : a;
}

function applyOrder(metric: Metric, order: CustomerOrderHistoryItem) {
  const amount = money(order.total);
  const paid = isPaid(order);
  const attempted = isAttempted(order);
  const failed = isFailed(order);
  const refunded = isRefunded(order);
  const matched = Boolean(order.gatewayVerification?.matched);
  const confidence = order.gatewayVerification?.confidence ?? "not_found";
  const provider = normalizeProvider(order);
  const transactionDate = order.gatewayVerification?.transactionDate || order.dateCreated || "";

  metric.totalOrders += 1;
  if (paid) {
    metric.paidRevenue += amount;
    metric.paidOrders += 1;
    if (matched) metric.verifiedRevenue += amount;
    else metric.unverifiedPaidRevenue += amount;
  }
  if (attempted) {
    metric.attemptedPipeline += amount;
    metric.attemptedOrders += 1;
  }
  if (failed) {
    metric.failedAmount += amount;
    metric.failedOrders += 1;
  }
  if (refunded) metric.refundedAmount += money(order.refundsAmount) || amount;
  if (matched) metric.matchedOrders += 1;
  else metric.unmatchedOrders += 1;
  if (provider === "unknown" || confidence === "low" || confidence === "not_found" || !matched) metric.manualReviewRevenue += amount;
  metric.lastTransactionDate = latestDate(metric.lastTransactionDate, transactionDate);
}

function addSummary(target: Metric, source: Metric) {
  target.paidRevenue += source.paidRevenue;
  target.attemptedPipeline += source.attemptedPipeline;
  target.failedAmount += source.failedAmount;
  target.refundedAmount += source.refundedAmount;
  target.totalOrders += source.totalOrders;
  target.paidOrders += source.paidOrders;
  target.attemptedOrders += source.attemptedOrders;
  target.failedOrders += source.failedOrders;
  target.verifiedRevenue += source.verifiedRevenue;
  target.unverifiedPaidRevenue += source.unverifiedPaidRevenue;
  target.manualReviewRevenue += source.manualReviewRevenue;
  target.matchedOrders += source.matchedOrders;
  target.unmatchedOrders += source.unmatchedOrders;
  target.lastTransactionDate = latestDate(target.lastTransactionDate, source.lastTransactionDate);
}

function metricToTimeline(period: string, provider: Provider, metric: Metric): TimelineMetric {
  return {
    period,
    provider,
    paidRevenue: metric.paidRevenue,
    attemptedPipeline: metric.attemptedPipeline,
    failedAmount: metric.failedAmount,
    refundedAmount: metric.refundedAmount,
    paidOrders: metric.paidOrders,
    attemptedOrders: metric.attemptedOrders,
    failedOrders: metric.failedOrders,
    verifiedRevenue: metric.verifiedRevenue,
    unverifiedPaidRevenue: metric.unverifiedPaidRevenue,
  };
}

export async function GET(request: Request) {
  await connectToDatabase();
  const { searchParams } = new URL(request.url);
  const now = new Date();
  const from = parseDateParam(searchParams.get("from"), new Date("2019-01-01T00:00:00.000"));
  const to = parseDateParam(searchParams.get("to"), now, true);
  const intervalParam = searchParams.get("interval") ?? "month";
  const providerParam = searchParams.get("provider") ?? "all";
  const statusParam = searchParams.get("status") ?? "all";
  const interval = intervals.includes(intervalParam as Interval) ? intervalParam as Interval : "month";
  const requestedProvider = providerParam === "all" || defaultProviders.includes(providerParam as Provider) ? providerParam as Provider | "all" : "all";
  const status = statusFilters.includes(statusParam as StatusFilter) ? statusParam as StatusFilter : "all";

  const customers = await Customer.find({}, { name: 1, email: 1, orders: 1 }).lean<Pick<CustomerDocument, "name" | "email" | "orders">[]>();
  const providerMetrics = new Map<Provider, Metric>();
  const timelineMetrics = new Map<string, Metric>();
  const customerMetrics = new Map<string, CustomerGatewayMetric>();

  for (const provider of defaultProviders) providerMetrics.set(provider, emptyMetric());

  for (const customer of customers) {
    for (const order of customer.orders ?? []) {
      const date = orderDate(order);
      if (!date || date < from || date > to) continue;
      const provider = normalizeProvider(order);
      if (requestedProvider !== "all" && provider !== requestedProvider) continue;
      if (!includeStatus(order, status)) continue;

      const providerMetric = providerMetrics.get(provider) ?? emptyMetric();
      applyOrder(providerMetric, order);
      providerMetrics.set(provider, providerMetric);

      const period = periodFor(date, interval);
      const timelineKey = `${period}:${provider}`;
      const timelineMetric = timelineMetrics.get(timelineKey) ?? emptyMetric();
      applyOrder(timelineMetric, order);
      timelineMetrics.set(timelineKey, timelineMetric);

      const customerKey = `${provider}:${customer.email}`;
      const customerMetric = customerMetrics.get(customerKey) ?? {
        provider,
        customerName: customer.name,
        email: customer.email,
        paidRevenue: 0,
        attemptedPipeline: 0,
        orderCount: 0,
        lastOrderDate: "",
      };
      if (isPaid(order)) customerMetric.paidRevenue += money(order.total);
      if (isAttempted(order)) customerMetric.attemptedPipeline += money(order.total);
      customerMetric.orderCount += 1;
      customerMetric.lastOrderDate = latestDate(customerMetric.lastOrderDate, order.dateCreated);
      customerMetrics.set(customerKey, customerMetric);
    }
  }

  const byProvider = Array.from(providerMetrics.entries())
    .filter(([, metric]) => metric.totalOrders > 0 || requestedProvider === "all")
    .map(([provider, metric]) => ({ provider, ...metric }))
    .sort((a, b) => b.paidRevenue - a.paidRevenue || b.attemptedPipeline - a.attemptedPipeline);

  const summaryMetric = emptyMetric();
  for (const metric of providerMetrics.values()) addSummary(summaryMetric, metric);

  const timeline = Array.from(timelineMetrics.entries())
    .map(([key, metric]) => {
      const separator = key.lastIndexOf(":");
      return metricToTimeline(key.slice(0, separator), key.slice(separator + 1) as Provider, metric);
    })
    .sort((a, b) => b.period.localeCompare(a.period) || a.provider.localeCompare(b.provider));

  const topCustomersByGateway = Array.from(customerMetrics.values())
    .sort((a, b) => b.paidRevenue - a.paidRevenue || b.attemptedPipeline - a.attemptedPipeline || b.orderCount - a.orderCount)
    .slice(0, 50);

  return NextResponse.json({
    filters: {
      from: from.toISOString().slice(0, 10),
      to: to.toISOString().slice(0, 10),
      interval,
      provider: requestedProvider,
      status,
    },
    summary: {
      totalPaidRevenue: summaryMetric.paidRevenue,
      totalAttemptedPipeline: summaryMetric.attemptedPipeline,
      totalFailedAmount: summaryMetric.failedAmount,
      totalRefundedAmount: summaryMetric.refundedAmount,
      totalOrders: summaryMetric.totalOrders,
      paidOrders: summaryMetric.paidOrders,
      attemptedOrders: summaryMetric.attemptedOrders,
      failedOrders: summaryMetric.failedOrders,
      verifiedRevenue: summaryMetric.verifiedRevenue,
      unverifiedPaidRevenue: summaryMetric.unverifiedPaidRevenue,
      manualReviewRevenue: summaryMetric.manualReviewRevenue,
      providersCount: byProvider.filter((provider) => provider.totalOrders > 0).length,
    },
    byProvider,
    timeline,
    topCustomersByGateway,
  });
}

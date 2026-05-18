import { getOrderStatus, isPaidOrder, parseMoney } from "@/lib/businessMetrics";
import {
  fetchWooCommerceCustomers,
  fetchWooCommerceOrders,
  type WooCommerceCustomer,
  type WooCommerceFetchResult,
  type WooCommerceOrder,
} from "@/lib/woocommerce";

export type WooMatchConfidence = "exact" | "high" | "medium" | "low";
export type WooMatchReason = "email" | "phone" | "name" | "company" | "customer_id";

export type WooMatchedOrder = WooCommerceOrder & {
  matchedBy: WooMatchReason[];
  matchConfidence: WooMatchConfidence;
};

export type WooCustomerMatchInput = {
  email: string;
  phone?: string;
  firstName?: string;
  lastName?: string;
  company?: string;
  customerName?: string;
};

type NormalizedInput = {
  email: string;
  phone: string;
  phoneLast10: string;
  phoneLast7: string;
  firstName: string;
  lastName: string;
  fullName: string;
  company: string;
};

type MatchBucket = {
  count: number;
  orderNumbers: string[];
  statuses: Record<string, number>;
  totals: number[];
};

export type WooSourceAudit = {
  input: WooCustomerMatchInput;
  normalizedInput: NormalizedInput;
  matches: {
    byEmail: MatchBucket;
    byPhone: MatchBucket;
    byName: MatchBucket;
    byCompany: MatchBucket;
    byCustomerUser: MatchBucket;
  };
  dedupedOrdersCount: number;
  dedupedOrderNumbers: string[];
  statusCounts: Record<string, number>;
  paymentMethodCounts: Record<string, number>;
  totalPaid: number;
  totalAttempted: number;
  matchReasonCounts: Record<string, number>;
  warnings: string[];
  fetchedBySource: Record<string, number>;
};

export type WooCustomerMatchResult = {
  orders: WooMatchedOrder[];
  audit: WooSourceAudit;
  pagesFetched: number;
  failedRequests: Array<{ status: string; page: number; message: string }>;
};

function normalizeText(value?: string) {
  return (value ?? "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizePhone(value?: string) {
  return (value ?? "").replace(/\D/g, "");
}

function splitName(value?: string) {
  const parts = normalizeText(value).split(" ").filter(Boolean);
  return {
    firstName: parts[0] ?? "",
    lastName: parts.length > 1 ? parts.slice(1).join(" ") : "",
  };
}

export function normalizeCustomerMatchInput(input: WooCustomerMatchInput): NormalizedInput {
  const split = splitName(input.customerName);
  const firstName = normalizeText(input.firstName) || split.firstName;
  const lastName = normalizeText(input.lastName) || split.lastName;
  const phone = normalizePhone(input.phone);
  return {
    email: input.email.trim().toLowerCase(),
    phone,
    phoneLast10: phone.length >= 10 ? phone.slice(-10) : "",
    phoneLast7: phone.length >= 7 ? phone.slice(-7) : "",
    firstName,
    lastName,
    fullName: normalizeText(input.customerName || `${firstName} ${lastName}`),
    company: normalizeText(input.company),
  };
}

function orderNumber(order: WooCommerceOrder) {
  return String(order.number ?? order.id);
}

function orderTotal(order: WooCommerceOrder) {
  const total = parseMoney(order.total);
  if (total > 0) return total;
  return (order.line_items ?? []).reduce((sum, item) => {
    const quantity = Number(item.quantity ?? 0);
    const itemTotal = parseMoney(item.total) || parseMoney(item.subtotal) || Number(item.price ?? 0) * quantity;
    return sum + itemTotal;
  }, 0);
}

function billingName(order: WooCommerceOrder) {
  return normalizeText(`${order.billing?.first_name ?? ""} ${order.billing?.last_name ?? ""}`);
}

function increment(counts: Record<string, number>, key: string) {
  const safeKey = key || "unknown";
  counts[safeKey] = (counts[safeKey] ?? 0) + 1;
}

function emptyBucket(): MatchBucket {
  return { count: 0, orderNumbers: [], statuses: {}, totals: [] };
}

function summarizeOrders(orders: WooMatchedOrder[], reason: WooMatchReason): MatchBucket {
  const bucket = emptyBucket();
  for (const order of orders) {
    if (!order.matchedBy?.includes(reason)) continue;
    bucket.count += 1;
    bucket.orderNumbers.push(orderNumber(order));
    bucket.totals.push(orderTotal(order));
    increment(bucket.statuses, getOrderStatus(order) || "unknown");
  }
  return bucket;
}

function phoneMatches(input: NormalizedInput, value?: string) {
  const phone = normalizePhone(value);
  if (!input.phone || !phone) return false;
  if (input.phoneLast10 && phone.endsWith(input.phoneLast10)) return true;
  return Boolean(input.phoneLast7 && phone.length >= 7 && phone.endsWith(input.phoneLast7));
}

function companyMatches(input: NormalizedInput, value?: string) {
  const company = normalizeText(value);
  if (!input.company || !company || input.company.length < 5) return false;
  return company === input.company || company.includes(input.company) || input.company.includes(company);
}

function fullNameMatches(input: NormalizedInput, firstName?: string, lastName?: string, fallbackName?: string) {
  const orderFirst = normalizeText(firstName);
  const orderLast = normalizeText(lastName);
  const orderFull = normalizeText(fallbackName || `${orderFirst} ${orderLast}`);
  if (input.firstName && input.lastName && orderFirst && orderLast) {
    return input.firstName === orderFirst && input.lastName === orderLast;
  }
  return Boolean(input.fullName && orderFull && input.fullName === orderFull);
}

function matchCustomer(customer: WooCommerceCustomer, input: NormalizedInput) {
  const reasons = new Set<WooMatchReason>();
  if (input.email && customer.email?.trim().toLowerCase() === input.email) reasons.add("email");
  if (phoneMatches(input, customer.billing?.phone)) reasons.add("phone");
  if (companyMatches(input, customer.billing?.company)) reasons.add("company");
  if (fullNameMatches(input, customer.first_name, customer.last_name, `${customer.first_name ?? ""} ${customer.last_name ?? ""}`)) reasons.add("name");

  const strong = reasons.has("email") || reasons.has("phone") || reasons.has("company");
  if (!strong && reasons.has("name")) return null;
  return reasons.size > 0 ? Array.from(reasons) : null;
}

function matchOrder(order: WooCommerceOrder, input: NormalizedInput, customerIds: Set<number>) {
  const reasons = new Set<WooMatchReason>();
  const billing = order.billing ?? {};
  const email = billing.email?.trim().toLowerCase() ?? "";
  if (input.email && email === input.email) reasons.add("email");
  if (phoneMatches(input, billing.phone)) reasons.add("phone");
  if (companyMatches(input, billing.company)) reasons.add("company");
  if (order.customer_id && customerIds.has(order.customer_id)) reasons.add("customer_id");

  const nameMatches = fullNameMatches(input, billing.first_name, billing.last_name, billingName(order));
  const hasStrongReason = reasons.has("email") || reasons.has("phone") || reasons.has("company") || reasons.has("customer_id");
  if (nameMatches && hasStrongReason) reasons.add("name");

  if (reasons.size === 0) return null;
  const matchedBy = Array.from(reasons);
  const confidence: WooMatchConfidence = reasons.has("email") || reasons.has("customer_id")
    ? "exact"
    : reasons.has("phone") && reasons.has("name")
      ? "high"
      : reasons.has("phone") || (reasons.has("company") && reasons.has("name"))
        ? "high"
        : reasons.has("company")
          ? "medium"
          : "low";
  return { matchedBy, matchConfidence: confidence };
}

function collectFetchWarning(source: string, result: WooCommerceFetchResult<unknown> | null, warnings: string[], failedRequests: WooCustomerMatchResult["failedRequests"]) {
  if (!result) {
    warnings.push(`${source}: WooCommerce request was not available.`);
    return 0;
  }
  if (result.warning) warnings.push(`${source}: ${result.warning}`);
  for (const request of result.failedRequests) failedRequests.push(request);
  return result.pagesFetched;
}

function addCandidates(
  result: WooCommerceFetchResult<WooCommerceOrder> | null,
  source: string,
  candidates: Map<number, WooCommerceOrder>,
  fetchedBySource: Record<string, number>
) {
  const items = result?.items ?? [];
  fetchedBySource[source] = (fetchedBySource[source] ?? 0) + items.length;
  for (const order of items) {
    candidates.set(order.id, order);
  }
}

function auditFor(input: WooCustomerMatchInput, normalizedInput: NormalizedInput, orders: WooMatchedOrder[], warnings: string[], fetchedBySource: Record<string, number>): WooSourceAudit {
  const statusCounts: Record<string, number> = {};
  const paymentMethodCounts: Record<string, number> = {};
  const matchReasonCounts: Record<string, number> = {};
  let totalPaid = 0;
  let totalAttempted = 0;

  for (const order of orders) {
    const total = orderTotal(order);
    increment(statusCounts, getOrderStatus(order) || "unknown");
    increment(paymentMethodCounts, order.payment_method_title || order.payment_method || "unknown");
    for (const reason of order.matchedBy ?? []) increment(matchReasonCounts, reason);
    if (isPaidOrder(order)) totalPaid += total;
    else totalAttempted += total;
  }

  return {
    input,
    normalizedInput,
    matches: {
      byEmail: summarizeOrders(orders, "email"),
      byPhone: summarizeOrders(orders, "phone"),
      byName: summarizeOrders(orders, "name"),
      byCompany: summarizeOrders(orders, "company"),
      byCustomerUser: summarizeOrders(orders, "customer_id"),
    },
    dedupedOrdersCount: orders.length,
    dedupedOrderNumbers: orders.map(orderNumber),
    statusCounts,
    paymentMethodCounts,
    totalPaid,
    totalAttempted,
    matchReasonCounts,
    warnings,
    fetchedBySource,
  };
}

export async function fetchWooCustomerMatches(input: WooCustomerMatchInput, options: { deepWooSearch?: boolean; maxPages?: number } = {}): Promise<WooCustomerMatchResult> {
  const normalizedInput = normalizeCustomerMatchInput(input);
  const maxPages = options.maxPages ?? 25;
  const deepWooSearch = options.deepWooSearch === true;
  const candidates = new Map<number, WooCommerceOrder>();
  const customerIds = new Set<number>();
  const warnings: string[] = [];
  const failedRequests: WooCustomerMatchResult["failedRequests"] = [];
  const fetchedBySource: Record<string, number> = {};
  let pagesFetched = 0;

  const emailResult = await fetchWooCommerceOrders({ email: normalizedInput.email, maxPages });
  pagesFetched += collectFetchWarning("email", emailResult, warnings, failedRequests);
  addCandidates(emailResult, "email", candidates, fetchedBySource);

  if (deepWooSearch) {
    const customerSearches = Array.from(new Set([normalizedInput.email, normalizedInput.phone, input.customerName, input.company].map((value) => value?.trim()).filter(Boolean) as string[]));
    for (const search of customerSearches) {
      const customerResult = await fetchWooCommerceCustomers({ search, maxPages: Math.min(5, maxPages) });
      pagesFetched += collectFetchWarning(`customer:${search}`, customerResult, warnings, failedRequests);
      for (const customer of customerResult?.items ?? []) {
        if (matchCustomer(customer, normalizedInput)) customerIds.add(customer.id);
      }
    }

    for (const customerId of customerIds) {
      const customerOrderResult = await fetchWooCommerceOrders({ customerId, maxPages });
      pagesFetched += collectFetchWarning(`customer_id:${customerId}`, customerOrderResult, warnings, failedRequests);
      addCandidates(customerOrderResult, "customer_id", candidates, fetchedBySource);
    }

    const orderSearches = Array.from(new Set([normalizedInput.email, normalizedInput.phone, input.customerName, input.company].map((value) => value?.trim()).filter(Boolean) as string[]));
    for (const search of orderSearches) {
      const orderResult = await fetchWooCommerceOrders({ search, maxPages });
      pagesFetched += collectFetchWarning(`order_search:${search}`, orderResult, warnings, failedRequests);
      addCandidates(orderResult, "search", candidates, fetchedBySource);
    }

    const allOrdersResult = await fetchWooCommerceOrders({ maxPages });
    pagesFetched += collectFetchWarning("all_orders_scan", allOrdersResult, warnings, failedRequests);
    addCandidates(allOrdersResult, "all_orders_scan", candidates, fetchedBySource);
  }

  const matchedOrders = Array.from(candidates.values())
    .map((order) => {
      const match = matchOrder(order, normalizedInput, customerIds);
      return match ? { ...order, matchedBy: match.matchedBy, matchConfidence: match.matchConfidence } satisfies WooMatchedOrder : null;
    })
    .filter((order): order is WooMatchedOrder => Boolean(order))
    .sort((a, b) => new Date(b.date_created ?? 0).getTime() - new Date(a.date_created ?? 0).getTime());

  return {
    orders: matchedOrders,
    audit: auditFor(input, normalizedInput, matchedOrders, Array.from(new Set(warnings)), fetchedBySource),
    pagesFetched,
    failedRequests,
  };
}

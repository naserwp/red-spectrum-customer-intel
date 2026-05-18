import type { WooCommerceOrder } from "@/lib/woocommerce";

export const paidOrderStatuses = new Set(["completed", "processing", "paid"]);
export const unpaidOrderStatuses = new Set(["pending", "failed", "cancelled", "canceled", "on-hold", "checkout-draft", "payment_pending", "crypto_pending", "refunded"]);
export const highValueThreshold = 2000;

export const getOrderStatus = (order: Pick<WooCommerceOrder, "status">) => (order.status ?? "").trim().toLowerCase();
export const isPaidOrder = (order: Pick<WooCommerceOrder, "status">) => paidOrderStatuses.has(getOrderStatus(order));
export const isUnpaidAttemptOrder = (order: Pick<WooCommerceOrder, "status">) => !isPaidOrder(order);

export const parseMoney = (value: string | number | undefined | null) => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

export function parseDate(value?: string | null) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function isInRange(value: string | undefined | null, start: Date, end: Date) {
  const date = parseDate(value);
  return Boolean(date && date >= start && date <= end);
}

export function monthStart(date = new Date()) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

export function rollingDaysStart(days: number, date = new Date()) {
  return new Date(date.getTime() - days * 86400000);
}

export function isRealSubscriptionRecord(sub: {
  isPlaceholder?: boolean | null;
  sourceStatus?: string | null;
  recordType?: string | null;
  status?: string | null;
}) {
  if (sub.isPlaceholder) return false;
  if (sub.sourceStatus === "placeholder") return false;
  if (sub.recordType === "subscription_candidate") return false;
  return sub.sourceStatus === "real" || sub.recordType === "subscription";
}

export type SalesPeriodMetric = {
  period: string;
  paidRevenue: number;
  attemptedPipeline: number;
  paidOrders: number;
  attemptedOrders: number;
  failedPayments: number;
  refunds: number;
  chargebacks: number;
  newPaidCustomers: number;
  newLeads: number;
  averageOrderValue: number;
};

function emptyMetric(period: string): SalesPeriodMetric {
  return {
    period,
    paidRevenue: 0,
    attemptedPipeline: 0,
    paidOrders: 0,
    attemptedOrders: 0,
    failedPayments: 0,
    refunds: 0,
    chargebacks: 0,
    newPaidCustomers: 0,
    newLeads: 0,
    averageOrderValue: 0,
  };
}

export function summarizeWooOrdersForSalesHistory(orders: WooCommerceOrder[], years = 5) {
  const now = new Date();
  const firstYear = now.getFullYear() - years + 1;
  const yearly = new Map<string, SalesPeriodMetric>();
  const monthly = new Map<string, SalesPeriodMetric>();
  const paidCustomerFirstPeriod = new Map<string, string>();
  const leadFirstPeriod = new Map<string, string>();

  for (let year = firstYear; year <= now.getFullYear(); year += 1) {
    yearly.set(String(year), emptyMetric(String(year)));
    for (let month = 1; month <= 12; month += 1) {
      monthly.set(`${year}-${String(month).padStart(2, "0")}`, emptyMetric(`${year}-${String(month).padStart(2, "0")}`));
    }
  }

  for (const order of orders) {
    const date = parseDate(order.date_created);
    if (!date || date.getFullYear() < firstYear || date > now) continue;

    const email = order.billing?.email?.trim().toLowerCase() ?? "";
    const yearKey = String(date.getFullYear());
    const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
    const targets = [yearly.get(yearKey), monthly.get(monthKey)].filter(Boolean) as SalesPeriodMetric[];
    const total = parseMoney(order.total);
    const paid = isPaidOrder(order);
    const failed = getOrderStatus(order) === "failed";
    const refunds = order.refunds?.length ?? (getOrderStatus(order) === "refunded" ? 1 : 0);

    for (const metric of targets) {
      if (paid) {
        metric.paidRevenue += total;
        metric.paidOrders += 1;
      } else {
        metric.attemptedPipeline += total;
        metric.attemptedOrders += 1;
      }
      if (failed) metric.failedPayments += 1;
      metric.refunds += refunds;
      if (metric.paidOrders > 0) metric.averageOrderValue = metric.paidRevenue / metric.paidOrders;
    }

    if (email && paid && !paidCustomerFirstPeriod.has(email)) paidCustomerFirstPeriod.set(email, yearKey);
    if (email && !paid && !leadFirstPeriod.has(email)) leadFirstPeriod.set(email, yearKey);
  }

  for (const period of paidCustomerFirstPeriod.values()) {
    const metric = yearly.get(period);
    if (metric) metric.newPaidCustomers += 1;
  }
  for (const period of leadFirstPeriod.values()) {
    const metric = yearly.get(period);
    if (metric) metric.newLeads += 1;
  }

  return {
    years,
    generatedAt: now.toISOString(),
    yearly: Array.from(yearly.values()).sort((a, b) => b.period.localeCompare(a.period)),
    monthly: Array.from(monthly.values()).sort((a, b) => b.period.localeCompare(a.period)),
  };
}

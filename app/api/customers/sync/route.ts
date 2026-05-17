import { NextResponse } from "next/server";
import { calculateCustomerScore, scoreToStars, type CustomerScoreInput } from "@/lib/customerScore";
import { connectToDatabase } from "@/lib/mongodb";
import { generateCustomerAiSummary } from "@/lib/openai";
import { fetchWooCommerceOrders, isWooCommerceConfigured, type WooCommerceCustomer, type WooCommerceOrder } from "@/lib/woocommerce";
import { Customer } from "@/models/Customer";

type SyncedCustomer = CustomerScoreInput & {
  _id: string;
  name: string;
  email: string;
  phone: string;
  orderCount: number;
  firstOrderDate: string;
  lastOrderAmount: number;
  averageOrderValue: number;
  activeSubscriptions: number;
  estimatedCreditLimit: number;
  actualCreditLimit: number | null;
  tier: string;
  riskLevel: "low" | "medium" | "high";
  tags: string[];
  notes: string;
  lastSyncedAt: string;
  aiSummary: string;
  aiSummaryPreview: string;
  riskExplanation: string;
  recommendedAction: string;
  score: number;
  stars: number;
};

type CustomerAccumulator = Omit<SyncedCustomer, "_id" | "score" | "stars" | "tier" | "aiSummary" | "aiSummaryPreview" | "riskExplanation" | "recommendedAction" | "averageOrderValue" | "estimatedCreditLimit" | "riskLevel" | "lastSyncedAt">;

const subscriptionStatuses: CustomerScoreInput["subscriptionStatus"][] = ["active", "inactive", "canceled", "past_due", "unknown"];
const todayIso = new Date().toISOString();

const parseMoney = (value: string | undefined) => Number.isFinite(Number(value ?? 0)) ? Number(value ?? 0) : 0;
const getOrderEmail = (order: WooCommerceOrder) => order.billing?.email?.trim().toLowerCase() ?? "";
const getOrderName = (order: WooCommerceOrder) => `${order.billing?.first_name?.trim() ?? ""} ${order.billing?.last_name?.trim() ?? ""}`.trim() || order.billing?.email || "WooCommerce Customer";

function getSubscriptionStatus(order: WooCommerceOrder): CustomerScoreInput["subscriptionStatus"] {
  const metaValue = order.meta_data?.find((meta) => meta.key?.toLowerCase().includes("subscription_status"))?.value?.toString().toLowerCase();
  if (metaValue && subscriptionStatuses.includes(metaValue as CustomerScoreInput["subscriptionStatus"])) return metaValue as CustomerScoreInput["subscriptionStatus"];
  return "unknown";
}

const getTier = (totalPaid: number) => totalPaid >= 2500 ? "Platinum" : totalPaid >= 999 ? "Gold" : totalPaid >= 200 ? "Silver" : "Bronze";
const getRiskLevel = (c: Pick<CustomerScoreInput, "chargebacks" | "failedPayments" | "refunds">, score: number) => (c.chargebacks > 0 || c.failedPayments > 2 || score < 45) ? "high" : (c.refunds > 1 || c.failedPayments > 0 || score < 70) ? "medium" : "low";

function estimateCreditLimit(totalPaid: number, orderCount: number, failedPayments: number, refunds: number, score: number) {
  const velocityFactor = Math.max(1, Math.min(3, orderCount / 4));
  const riskPenalty = failedPayments * 180 + refunds * 120 + (100 - score) * 5;
  return Math.max(300, Math.round(totalPaid * 0.8 * velocityFactor - riskPenalty));
}

function getActualCreditLimitFromMeta(source: WooCommerceOrder | WooCommerceCustomer | undefined): number | null {
  const meta = (source as { meta_data?: Array<{ key?: string; value?: unknown }> })?.meta_data;
  if (!meta) return null;
  const candidate = meta.find((m) => ["credit_limit", "actual_credit_limit", "reported_credit_limit"].includes((m.key ?? "").toLowerCase()));
  if (!candidate) return null;
  const parsed = Number(candidate.value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function transformOrdersToCustomers(orders: WooCommerceOrder[]) {
  const grouped = new Map<string, CustomerAccumulator>();

  for (const order of orders) {
    const email = getOrderEmail(order);
    if (!email) continue;

    const total = parseMoney(order.total);
    const orderDate = order.date_created ?? todayIso;
    const existing = grouped.get(email);
    const isLatest = !existing || new Date(orderDate).getTime() >= new Date(existing.lastOrderDate).getTime();
    const subscriptionStatus = getSubscriptionStatus(order);
    const actualFromMeta = getActualCreditLimitFromMeta(order);

    grouped.set(email, {
      name: isLatest || !existing ? getOrderName(order) : existing.name,
      email,
      phone: isLatest || !existing ? order.billing?.phone ?? "" : existing.phone,
      totalPaid: (existing?.totalPaid ?? 0) + total,
      orderCount: (existing?.orderCount ?? 0) + 1,
      firstOrderDate: !existing ? orderDate : new Date(orderDate) < new Date(existing.firstOrderDate) ? orderDate : existing.firstOrderDate,
      lastOrderDate: isLatest || !existing ? orderDate : existing.lastOrderDate,
      lastOrderAmount: isLatest || !existing ? total : existing.lastOrderAmount,
      subscriptionStatus: subscriptionStatus !== "unknown" ? subscriptionStatus : existing?.subscriptionStatus ?? "unknown",
      activeSubscriptions: subscriptionStatus === "active" ? Math.max(existing?.activeSubscriptions ?? 0, 1) : existing?.activeSubscriptions ?? 0,
      failedPayments: (existing?.failedPayments ?? 0) + (order.status === "failed" ? 1 : 0),
      refunds: (existing?.refunds ?? 0) + (order.refunds?.length ?? (order.status === "refunded" ? 1 : 0)),
      chargebacks: existing?.chargebacks ?? 0,
      actualCreditLimit: actualFromMeta ?? existing?.actualCreditLimit ?? null,
      notes: existing?.notes ?? "",
      tags: existing?.tags ?? [],
    });
  }

  return Promise.all(Array.from(grouped.values()).map(async (customer) => {
    const score = calculateCustomerScore(customer);
    const averageOrderValue = customer.orderCount > 0 ? customer.totalPaid / customer.orderCount : 0;
    const estimatedCreditLimit = estimateCreditLimit(customer.totalPaid, customer.orderCount, customer.failedPayments, customer.refunds, score);
    const baseCustomer = {
      ...customer,
      _id: `wc-${customer.email}`,
      averageOrderValue,
      estimatedCreditLimit,
      tier: getTier(customer.totalPaid),
      riskLevel: getRiskLevel(customer, score),
      lastSyncedAt: todayIso,
      score,
      stars: scoreToStars(score),
    };
    const aiSummary = await generateCustomerAiSummary(baseCustomer);
    return { ...baseCustomer, ...aiSummary };
  }));
}

async function saveCustomers(customers: SyncedCustomer[]) {
  await Promise.all(customers.map((customer) => Customer.findOneAndUpdate({ email: customer.email }, { $set: customer }, { upsert: true, new: true })));
}

export async function POST() {
  if (!isWooCommerceConfigured()) {
    return NextResponse.json({ message: "WooCommerce is not configured. Add WC_STORE_URL, WC_CONSUMER_KEY, and WC_CONSUMER_SECRET to enable sync.", customers: [], saved: false });
  }

  const orders = await fetchWooCommerceOrders();
  if (!orders) return NextResponse.json({ error: "Unable to fetch WooCommerce orders.", customers: [], saved: false }, { status: 502 });

  const customers = await transformOrdersToCustomers(orders);
  const connection = await connectToDatabase();
  if (!connection) return NextResponse.json({ message: "WooCommerce data transformed. MongoDB is unavailable, so customers were not saved.", customers, saved: false });

  await saveCustomers(customers);
  return NextResponse.json({ message: `Synced ${customers.length} WooCommerce customer${customers.length === 1 ? "" : "s"}.`, customers, saved: true });
}

import { NextResponse } from "next/server";
import { calculateCustomerScore, scoreToStars, type CustomerScoreInput } from "@/lib/customerScore";
import { connectToDatabase } from "@/lib/mongodb";
import { fetchWooCommerceOrders, isWooCommerceConfigured, type WooCommerceCustomer, type WooCommerceOrder } from "@/lib/woocommerce";
import { Customer } from "@/models/Customer";
import { Subscription } from "@/models/Subscription";
import { buildSourcePlaceholders, mapWooOrdersToSubscriptions } from "@/lib/subscriptions";

type SyncedCustomer = CustomerScoreInput & {
  name: string;
  email: string;
  phone: string;
  orderCount: number;
  paidOrderCount: number;
  attemptedOrderCount: number;
  paidTotal: number;
  attemptedTotal: number;
  firstOrderDate: string;
  lastOrderDate: string;
  lastOrderAmount: number;
  averageOrderValue: number;
  leadStatus: string;
  paymentStatus: string;
  lastAttemptDate: string;
  lastPaidDate: string;
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

type CustomerAccumulator = Omit<SyncedCustomer, "score" | "stars" | "tier" | "aiSummary" | "aiSummaryPreview" | "riskExplanation" | "recommendedAction" | "averageOrderValue" | "estimatedCreditLimit" | "riskLevel" | "lastSyncedAt" | "leadStatus" | "paymentStatus">;

const PAID_STATUSES = new Set(["completed", "processing", "paid"]);
const UNPAID_STATUSES = new Set(["pending", "failed", "cancelled", "on-hold", "checkout-draft", "payment_pending", "crypto_pending"]);
const subscriptionStatuses: CustomerScoreInput["subscriptionStatus"][] = ["active", "inactive", "canceled", "past_due", "unknown"];
const todayIso = new Date().toISOString();

const parseMoney = (value: string | undefined) => Number.isFinite(Number(value ?? 0)) ? Number(value ?? 0) : 0;
const getOrderEmail = (order: WooCommerceOrder) => order.billing?.email?.trim().toLowerCase() ?? "";
const getOrderName = (order: WooCommerceOrder) => `${order.billing?.first_name?.trim() ?? ""} ${order.billing?.last_name?.trim() ?? ""}`.trim() || order.billing?.email || "WooCommerce Customer";
const isPaidStatus = (s?: string) => PAID_STATUSES.has((s ?? "").toLowerCase());
const isAttemptStatus = (s?: string) => !isPaidStatus(s) && (UNPAID_STATUSES.has((s ?? "").toLowerCase()) || Boolean(s));

function getSubscriptionStatus(order: WooCommerceOrder): CustomerScoreInput["subscriptionStatus"] {
  const metaValue = order.meta_data?.find((meta) => meta.key?.toLowerCase().includes("subscription_status"))?.value?.toString().toLowerCase();
  if (metaValue && subscriptionStatuses.includes(metaValue as CustomerScoreInput["subscriptionStatus"])) return metaValue as CustomerScoreInput["subscriptionStatus"];
  return "unknown";
}

const getTier = (paidTotal: number, attemptedTotal: number) => {
  if (paidTotal <= 0 && attemptedTotal > 0) return "Lead";
  if (paidTotal >= 2500) return "Platinum";
  if (paidTotal >= 999) return "Gold";
  if (paidTotal >= 200) return "Silver";
  return "Bronze";
};

const getRiskLevel = (c: Pick<CustomerScoreInput, "chargebacks" | "failedPayments" | "refunds">, score: number): "low" | "medium" | "high" => {
  if (c.chargebacks > 0 || c.failedPayments > 2 || score < 45) return "high";
  if (c.refunds > 1 || c.failedPayments > 0 || score < 70) return "medium";
  return "low";
};

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

function buildSyncSummary(customer: { name: string; tier: string; paidTotal: number; attemptedTotal: number; paidOrderCount: number; failedPayments: number; }) {
  if (customer.paidTotal <= 0 && customer.attemptedTotal > 0) {
    const text = "This is a hot lead who attempted checkout but has not completed payment.";
    return { aiSummary: text, aiSummaryPreview: text, riskExplanation: "Payment was attempted but not completed.", recommendedAction: "Follow up quickly with assisted checkout and payment support." };
  }
  const text = `${customer.name} is a ${customer.tier} customer with ${customer.paidOrderCount} paid orders totaling $${customer.paidTotal.toFixed(2)}.`;
  return {
    aiSummary: text,
    aiSummaryPreview: `${text.slice(0, 110)}${text.length > 110 ? "…" : ""}`,
    riskExplanation: customer.failedPayments > 0 ? "Payment failures indicate moderate risk." : "Payment history is stable.",
    recommendedAction: customer.paidTotal >= 2000 ? "Prioritize VIP retention and tailored upsells." : "Continue lifecycle engagement and monitor payment behavior.",
  };
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
    const paid = isPaidStatus(order.status);
    const attempt = isAttemptStatus(order.status);

    grouped.set(email, {
      name: isLatest || !existing ? getOrderName(order) : existing.name,
      email,
      phone: isLatest || !existing ? order.billing?.phone ?? "" : existing.phone,
      totalPaid: (existing?.totalPaid ?? 0) + (paid ? total : 0),
      paidTotal: (existing?.paidTotal ?? 0) + (paid ? total : 0),
      attemptedTotal: (existing?.attemptedTotal ?? 0) + (attempt ? total : 0),
      orderCount: (existing?.orderCount ?? 0) + 1,
      paidOrderCount: (existing?.paidOrderCount ?? 0) + (paid ? 1 : 0),
      attemptedOrderCount: (existing?.attemptedOrderCount ?? 0) + (attempt ? 1 : 0),
      firstOrderDate: !existing ? orderDate : new Date(orderDate) < new Date(existing.firstOrderDate) ? orderDate : existing.firstOrderDate,
      lastOrderDate: isLatest || !existing ? orderDate : existing.lastOrderDate,
      lastOrderAmount: isLatest || !existing ? total : existing.lastOrderAmount,
      lastAttemptDate: attempt && (isLatest || !existing) ? orderDate : existing?.lastAttemptDate ?? "",
      lastPaidDate: paid && (isLatest || !existing) ? orderDate : existing?.lastPaidDate ?? "",
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

  return Array.from(grouped.values()).map((customer) => {
    const scoreInput: CustomerScoreInput = {
      totalPaid: customer.paidTotal,
      subscriptionStatus: customer.subscriptionStatus,
      lastOrderDate: customer.lastOrderDate,
      refunds: customer.refunds,
      chargebacks: customer.chargebacks,
      failedPayments: customer.failedPayments,
    };
    const score = calculateCustomerScore(scoreInput);
    const stars = scoreToStars(score);
    const averageOrderValue = customer.paidOrderCount > 0 ? customer.paidTotal / customer.paidOrderCount : 0;
    const estimatedCreditLimit = estimateCreditLimit(customer.paidTotal, customer.paidOrderCount, customer.failedPayments, customer.refunds, score);

    const baseCustomer = {
      ...customer,
      totalPaid: customer.paidTotal,
      averageOrderValue,
      estimatedCreditLimit,
      tier: getTier(customer.paidTotal, customer.attemptedTotal),
      riskLevel: getRiskLevel(customer, score),
      paymentStatus: customer.paidTotal > 0 ? "paid" : customer.attemptedTotal > 0 ? "attempted_unpaid" : "unpaid",
      leadStatus: customer.paidTotal > 0 ? "customer" : customer.attemptedTotal > 500 ? "very_hot_lead" : customer.attemptedTotal > 0 ? "hot_lead" : "cold_lead",
      lastSyncedAt: todayIso,
      score,
      stars,
    };

    return { ...baseCustomer, ...buildSyncSummary(baseCustomer) } as SyncedCustomer;
  });
}

async function saveCustomers(customers: SyncedCustomer[]) {
  await Promise.all(customers.map((customer) => {
    const safeCustomerData = { ...customer } as SyncedCustomer & { _id?: string; id?: string; customerId?: string; wooCustomerId?: string };
    delete safeCustomerData._id;
    delete safeCustomerData.id;
    delete safeCustomerData.customerId;
    delete safeCustomerData.wooCustomerId;
    return Customer.findOneAndUpdate(
      { email: customer.email },
      { $set: safeCustomerData },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  }));
}

export async function POST() {
  if (!isWooCommerceConfigured()) {
    return NextResponse.json({ message: "WooCommerce is not configured. Add WC_STORE_URL, WC_CONSUMER_KEY, and WC_CONSUMER_SECRET to enable sync.", customers: [], saved: false });
  }

  const orders = await fetchWooCommerceOrders();
  if (!orders) return NextResponse.json({ error: "Unable to fetch WooCommerce orders.", customers: [], saved: false }, { status: 502 });

  const customers = await transformOrdersToCustomers(orders);
  const wooSubscriptions = mapWooOrdersToSubscriptions(orders);
  const sourcePlaceholders = buildSourcePlaceholders(todayIso);
  const allSubscriptions = [
    ...wooSubscriptions,
    ...sourcePlaceholders.stripe,
    ...sourcePlaceholders.authorize_net,
    ...sourcePlaceholders.nmi,
    ...sourcePlaceholders.manual,
  ];

  const connection = await connectToDatabase();
  if (!connection) return NextResponse.json({ message: "WooCommerce data transformed. MongoDB is unavailable, so customers were not saved.", customers, saved: false });

  await saveCustomers(customers);
  await Promise.all(allSubscriptions.map((sub) => Subscription.findOneAndUpdate(
    { source: sub.source, subscriptionId: sub.subscriptionId },
    { $set: sub },
    { upsert: true, new: true }
  )));

  return NextResponse.json({
    message: `Synced ${customers.length} WooCommerce customer${customers.length === 1 ? "" : "s"}.`,
    customers,
    subscriptionsSynced: allSubscriptions.length,
    subscriptionSources: {
      woocommerce: wooSubscriptions.length,
      stripe: sourcePlaceholders.stripe.length,
      authorize_net: sourcePlaceholders.authorize_net.length,
      nmi: sourcePlaceholders.nmi.length,
      manual: sourcePlaceholders.manual.length,
    },
    saved: true,
    readOnlySync: true,
  });
}

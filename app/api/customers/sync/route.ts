import { NextResponse } from "next/server";
import { calculateCustomerScore, scoreToStars, type CustomerScoreInput } from "@/lib/customerScore";
import { connectToDatabase } from "@/lib/mongodb";
import { fetchWooCommerceOrders, isWooCommerceConfigured, type WooCommerceCustomer, type WooCommerceOrder } from "@/lib/woocommerce";
import { Customer } from "@/models/Customer";
import { SalesHistory } from "@/models/SalesHistory";
import { Subscription } from "@/models/Subscription";
import { buildSourcePlaceholders, mapWooOrdersToSubscriptions } from "@/lib/subscriptions";
import { getOrderStatus, isPaidOrder, parseMoney, summarizeWooOrdersForSalesHistory } from "@/lib/businessMetrics";

type SyncedCustomer = CustomerScoreInput & {
  name: string;
  email: string;
  phone: string;
  paidTotal: number;
  attemptedTotal: number;
  orderCount: number;
  paidOrderCount: number;
  attemptedOrderCount: number;
  firstOrderDate: string;
  lastPaidDate: string;
  lastAttemptDate: string;
  lastOrderAmount: number;
  averageOrderValue: number;
  activeSubscriptions: number;
  estimatedCreditLimit: number;
  actualCreditLimit: number | null;
  tier: string;
  leadStatus: string;
  paymentStatus: string;
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

type CustomerAccumulator = Omit<SyncedCustomer, "score" | "stars" | "tier" | "leadStatus" | "paymentStatus" | "aiSummary" | "aiSummaryPreview" | "riskExplanation" | "recommendedAction" | "averageOrderValue" | "estimatedCreditLimit" | "riskLevel" | "lastSyncedAt">;
type RuleSummaryCustomer = Omit<SyncedCustomer, "aiSummary" | "aiSummaryPreview" | "riskExplanation" | "recommendedAction">;

const subscriptionStatuses: CustomerScoreInput["subscriptionStatus"][] = ["active", "inactive", "canceled", "past_due", "unknown"];
const todayIso = new Date().toISOString();

const getOrderEmail = (order: WooCommerceOrder) => order.billing?.email?.trim().toLowerCase() ?? "";
const getOrderName = (order: WooCommerceOrder) => `${order.billing?.first_name?.trim() ?? ""} ${order.billing?.last_name?.trim() ?? ""}`.trim() || order.billing?.email || "WooCommerce Customer";

function getSubscriptionStatus(order: WooCommerceOrder): CustomerScoreInput["subscriptionStatus"] {
  const metaValue = order.meta_data?.find((meta) => meta.key?.toLowerCase().includes("subscription_status"))?.value?.toString().toLowerCase();
  if (metaValue && subscriptionStatuses.includes(metaValue as CustomerScoreInput["subscriptionStatus"])) return metaValue as CustomerScoreInput["subscriptionStatus"];
  return "unknown";
}

const getTier = (paidTotal: number, attemptedTotal: number) => paidTotal > 0 ? paidTotal >= 2500 ? "Platinum" : paidTotal >= 999 ? "Gold" : paidTotal >= 200 ? "Silver" : "Bronze" : attemptedTotal > 0 ? "Lead" : "Cold Lead";
const getLeadStatus = (paidTotal: number, attemptedTotal: number) => paidTotal > 0 ? "customer" : attemptedTotal >= 2000 ? "very_hot_lead" : attemptedTotal > 0 ? "hot_lead" : "cold_lead";
const getPaymentStatus = (paidTotal: number, attemptedTotal: number) => paidTotal > 0 ? "paid" : attemptedTotal > 0 ? "attempted_unpaid" : "unpaid";
const getRiskLevel = (
  c: Pick<CustomerScoreInput, "chargebacks" | "failedPayments" | "refunds">,
  score: number
): "low" | "medium" | "high" => (c.chargebacks > 0 || c.failedPayments > 2 || score < 45) ? "high" : (c.refunds > 1 || c.failedPayments > 0 || score < 70) ? "medium" : "low";

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

function buildRuleBasedSummary(customer: RuleSummaryCustomer) {
  const aiSummary =
    customer.paidTotal > 0
      ? `${customer.name} is a paid customer with ${customer.paidOrderCount} paid orders totaling $${customer.paidTotal.toFixed(2)}.`
      : customer.attemptedTotal > 0
        ? "This is a hot lead who attempted checkout but has not completed payment."
        : `${customer.name} has not completed payment yet.`;
  const riskExplanation =
    customer.chargebacks > 0
      ? "Chargeback history indicates elevated payment dispute risk."
      : customer.failedPayments > 1
        ? "Multiple failed or pending payments indicate checkout friction."
        : customer.refunds > 0
          ? "Refund activity is present and should be reviewed."
          : "Payment and refund patterns do not show elevated risk.";

  return {
    aiSummary,
    aiSummaryPreview: aiSummary.slice(0, 110) + (aiSummary.length > 110 ? "..." : ""),
    riskExplanation,
    recommendedAction:
      customer.paidTotal > 0
        ? customer.paidTotal >= 2000
          ? "Prioritize retention and account review for this high-value paid customer."
          : "Continue normal paid customer follow-up."
        : customer.attemptedTotal > 0
          ? "Follow up on the incomplete checkout and resolve payment friction."
          : "Keep in low-priority nurture until payment intent appears.",
  };
}

function toSafeCustomerData(customer: SyncedCustomer) {
  const safeCustomerData = { ...customer } as Record<string, unknown>;
  delete safeCustomerData._id;
  delete safeCustomerData.id;
  delete safeCustomerData.customerId;
  delete safeCustomerData.wooCustomerId;
  delete safeCustomerData.externalId;
  return safeCustomerData;
}

async function transformOrdersToCustomers(orders: WooCommerceOrder[]) {
  const grouped = new Map<string, CustomerAccumulator>();

  for (const order of orders) {
    const email = getOrderEmail(order);
    if (!email) continue;

    const total = parseMoney(order.total);
    const paidAmount = isPaidOrder(order) ? total : 0;
    const attemptedAmount = isPaidOrder(order) ? 0 : total;
    const orderDate = order.date_created ?? todayIso;
    const existing = grouped.get(email);
    const isLatest = !existing || new Date(orderDate).getTime() >= new Date(existing.lastOrderDate).getTime();
    const isLatestPaid = paidAmount > 0 && (!existing?.lastPaidDate || new Date(orderDate).getTime() >= new Date(existing.lastPaidDate).getTime());
    const isLatestAttempt = attemptedAmount > 0 && (!existing?.lastAttemptDate || new Date(orderDate).getTime() >= new Date(existing.lastAttemptDate).getTime());
    const subscriptionStatus = getSubscriptionStatus(order);
    const actualFromMeta = getActualCreditLimitFromMeta(order);
    const failedPayment = ["failed", "payment_pending", "crypto_pending"].includes(getOrderStatus(order)) ? 1 : 0;
    const refunded = order.refunds?.length ?? (getOrderStatus(order) === "refunded" ? 1 : 0);

    grouped.set(email, {
      name: isLatest || !existing ? getOrderName(order) : existing.name,
      email,
      phone: isLatest || !existing ? order.billing?.phone ?? "" : existing.phone,
      paidTotal: (existing?.paidTotal ?? 0) + paidAmount,
      attemptedTotal: (existing?.attemptedTotal ?? 0) + attemptedAmount,
      totalPaid: (existing?.paidTotal ?? 0) + paidAmount,
      orderCount: (existing?.orderCount ?? 0) + 1,
      paidOrderCount: (existing?.paidOrderCount ?? 0) + (paidAmount > 0 ? 1 : 0),
      attemptedOrderCount: (existing?.attemptedOrderCount ?? 0) + (attemptedAmount > 0 ? 1 : 0),
      firstOrderDate: !existing ? orderDate : new Date(orderDate) < new Date(existing.firstOrderDate) ? orderDate : existing.firstOrderDate,
      lastOrderDate: isLatest || !existing ? orderDate : existing.lastOrderDate,
      lastPaidDate: isLatestPaid ? orderDate : existing?.lastPaidDate ?? "",
      lastAttemptDate: isLatestAttempt ? orderDate : existing?.lastAttemptDate ?? "",
      lastOrderAmount: isLatest || !existing ? total : existing.lastOrderAmount,
      subscriptionStatus: subscriptionStatus !== "unknown" ? subscriptionStatus : existing?.subscriptionStatus ?? "unknown",
      activeSubscriptions: subscriptionStatus === "active" ? Math.max(existing?.activeSubscriptions ?? 0, 1) : existing?.activeSubscriptions ?? 0,
      failedPayments: (existing?.failedPayments ?? 0) + failedPayment,
      refunds: (existing?.refunds ?? 0) + refunded,
      chargebacks: existing?.chargebacks ?? 0,
      actualCreditLimit: actualFromMeta ?? existing?.actualCreditLimit ?? null,
      notes: existing?.notes ?? "",
      tags: existing?.tags ?? [],
    });
  }

  return Promise.all(Array.from(grouped.values()).map(async (customer) => {
    const score = calculateCustomerScore(customer);
    const averageOrderValue = customer.paidOrderCount > 0 ? customer.paidTotal / customer.paidOrderCount : 0;
    const estimatedCreditLimit = customer.paidTotal > 0 ? estimateCreditLimit(customer.paidTotal, customer.paidOrderCount, customer.failedPayments, customer.refunds, score) : 0;
    const baseCustomer = {
      ...customer,
      totalPaid: customer.paidTotal,
      averageOrderValue,
      estimatedCreditLimit,
      tier: getTier(customer.paidTotal, customer.attemptedTotal),
      leadStatus: getLeadStatus(customer.paidTotal, customer.attemptedTotal),
      paymentStatus: getPaymentStatus(customer.paidTotal, customer.attemptedTotal),
      riskLevel: getRiskLevel(customer, score),
      lastSyncedAt: todayIso,
      score,
      stars: scoreToStars(score),
    };
    const aiSummary = buildRuleBasedSummary(baseCustomer);
    return { ...baseCustomer, ...aiSummary };
  }));
}

async function saveCustomers(customers: SyncedCustomer[]) {
  await Promise.all(customers.map((customer) => Customer.findOneAndUpdate(
    { email: customer.email },
    { $set: toSafeCustomerData(customer) },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  )));
}

export async function POST() {
  if (!isWooCommerceConfigured()) {
    return NextResponse.json({ message: "WooCommerce is not configured. Add WC_STORE_URL, WC_CONSUMER_KEY, and WC_CONSUMER_SECRET to enable sync.", customers: [], saved: false });
  }

  const orderResult = await fetchWooCommerceOrders();
  if (!orderResult) return NextResponse.json({ error: "Unable to fetch WooCommerce orders.", customers: [], saved: false }, { status: 502 });

  const orders = orderResult.items;
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
  await SalesHistory.findOneAndUpdate(
    { source: "woocommerce" },
    { $set: { source: "woocommerce", ...summarizeWooOrdersForSalesHistory(orders, 5) } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  await Promise.all(allSubscriptions.map((sub) => Subscription.findOneAndUpdate(
    { source: sub.source, subscriptionId: sub.subscriptionId },
    { $set: sub },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  )));

  const paidOrders = orders.filter(isPaidOrder).length;
  const unpaidOrders = orders.length - paidOrders;
  const skippedOrdersWithoutEmail = orders.filter((order) => !getOrderEmail(order)).length;
  const paidCustomers = customers.filter((customer) => customer.paidTotal > 0).length;
  const attemptedCheckoutLeads = customers.filter((customer) => customer.paidTotal === 0 && customer.attemptedTotal > 0).length;

  return NextResponse.json({
    message: `Synced ${customers.length} unique WooCommerce customer${customers.length === 1 ? "" : "s"}.`,
    customers,
    totalOrdersFetched: orderResult.totalFetched,
    uniqueCustomersSynced: customers.length,
    paidCustomers,
    hotLeads: attemptedCheckoutLeads,
    attemptedCheckoutLeads,
    skippedOrdersWithoutEmail,
    unpaidOrders,
    paidOrders,
    pagesFetched: orderResult.pagesFetched,
    partialSync: orderResult.reachedPageLimit,
    warning: orderResult.reachedPageLimit ? "Partial sync, reached page limit." : "",
    subscriptionsSynced: allSubscriptions.length,
    subscriptionCandidatesSynced: wooSubscriptions.filter((sub) => sub.recordType === "subscription_candidate").length,
    realSubscriptionsSynced: wooSubscriptions.filter((sub) => sub.recordType === "subscription").length,
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

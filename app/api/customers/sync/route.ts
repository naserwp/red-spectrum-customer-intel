import { NextResponse } from "next/server";
import { calculateCustomerScore, scoreToStars, type CustomerScoreInput } from "@/lib/customerScore";
import { connectToDatabase } from "@/lib/mongodb";
import { fetchWooCommerceOrders, isWooCommerceConfigured, type WooCommerceCustomer, type WooCommerceOrder } from "@/lib/woocommerce";
import { Customer, type CustomerOrderHistoryItem, type CustomerOrderLineItem } from "@/models/Customer";
import { SalesHistory } from "@/models/SalesHistory";
import { Subscription } from "@/models/Subscription";
import { buildSourcePlaceholders, mapWooOrdersToSubscriptions } from "@/lib/subscriptions";
import { getOrderStatus, isPaidOrder, parseMoney, summarizeWooOrdersForSalesHistory } from "@/lib/businessMetrics";
import { getGatewayConfigurationSummary, hasConfiguredGateway, verifyOrderPayment } from "@/lib/paymentGateways";
import { buildProductJourneySummary, type ProductJourneySummary } from "@/lib/productClassification";

type SyncedCustomer = CustomerScoreInput & ProductJourneySummary & {
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
  orders: CustomerOrderHistoryItem[];
  lastProducts: string[];
  attemptedProducts: string[];
  paidProducts: string[];
  lastPaymentMethod: string;
  lastAttemptPaymentMethod: string;
  lastAttemptStatus: string;
  leadUrgency: string;
  recommendedContactMethod: string;
  nextAction: string;
  gatewayVerification: CustomerOrderHistoryItem["gatewayVerification"];
};

type CustomerAccumulator = Omit<SyncedCustomer, "score" | "stars" | "tier" | "leadStatus" | "paymentStatus" | "aiSummary" | "aiSummaryPreview" | "riskExplanation" | "recommendedAction" | "averageOrderValue" | "estimatedCreditLimit" | "riskLevel" | "lastSyncedAt" | "leadUrgency" | "recommendedContactMethod" | "nextAction" | "gatewayVerification" | keyof ProductJourneySummary>;
type RuleSummaryCustomer = Omit<SyncedCustomer, "aiSummary" | "aiSummaryPreview" | "riskExplanation" | "recommendedAction">;

const subscriptionStatuses: CustomerScoreInput["subscriptionStatus"][] = ["active", "inactive", "canceled", "past_due", "unknown"];
const todayIso = new Date().toISOString();

const getOrderEmail = (order: WooCommerceOrder) => order.billing?.email?.trim().toLowerCase() ?? "";
const getOrderName = (order: WooCommerceOrder) => `${order.billing?.first_name?.trim() ?? ""} ${order.billing?.last_name?.trim() ?? ""}`.trim() || order.billing?.email || "WooCommerce Customer";
const unique = (values: string[]) => Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));

function getLineItems(order: WooCommerceOrder): CustomerOrderLineItem[] {
  return (order.line_items ?? []).map((item) => {
    const quantity = Number(item.quantity ?? 0);
    const subtotal = parseMoney(item.subtotal);
    const parsedTotal = parseMoney(item.total);
    const price = Number.isFinite(Number(item.price)) ? Number(item.price) : 0;
    const total = parsedTotal > 0 ? parsedTotal : subtotal > 0 ? subtotal : price * quantity;
    return {
      productId: Number(item.product_id ?? 0),
      variationId: Number(item.variation_id ?? 0),
      name: item.name ?? "Unknown product",
      sku: item.sku ?? "",
      quantity,
      subtotal,
      total,
      price: price > 0 ? price : quantity > 0 ? total / quantity : total,
    };
  });
}

function getOrderTotal(order: WooCommerceOrder, lineItems = getLineItems(order)) {
  const total = parseMoney(order.total);
  if (total > 0) return total;
  return lineItems.reduce((sum, item) => sum + item.total, 0);
}

function getPaymentMethodLabel(order: WooCommerceOrder) {
  return order.payment_method_title || order.payment_method || "";
}

async function buildOrderHistoryItem(order: WooCommerceOrder): Promise<CustomerOrderHistoryItem> {
  const lineItems = getLineItems(order);
  const paid = isPaidOrder(order);
  const orderDate = order.date_created ?? todayIso;
  const item: CustomerOrderHistoryItem = {
    orderId: String(order.id),
    orderNumber: String(order.number ?? order.id),
    status: getOrderStatus(order) || "unknown",
    dateCreated: orderDate,
    dateModified: order.date_modified ?? "",
    total: getOrderTotal(order, lineItems),
    currency: order.currency ?? "",
    paymentMethod: order.payment_method ?? "",
    paymentMethodTitle: order.payment_method_title ?? "",
    transactionId: order.transaction_id ?? "",
    paidDate: order.date_paid ?? "",
    attemptedDate: paid ? "" : orderDate,
    isPaid: paid,
    isAttempted: !paid,
    billingName: getOrderName(order),
    billingEmail: getOrderEmail(order),
    billingPhone: order.billing?.phone ?? "",
    billingFirstName: order.billing?.first_name ?? "",
    billingLastName: order.billing?.last_name ?? "",
    billingCompany: order.billing?.company ?? "",
    billingAddress: {
      address1: order.billing?.address_1 ?? "",
      address2: order.billing?.address_2 ?? "",
      city: order.billing?.city ?? "",
      state: order.billing?.state ?? "",
      postcode: order.billing?.postcode ?? "",
      country: order.billing?.country ?? "",
    },
    lineItems,
    products: lineItems,
    refundsCount: order.refunds?.length ?? (getOrderStatus(order) === "refunded" ? 1 : 0),
    refundsAmount: (order.refunds ?? []).reduce((sum, refund) => sum + Math.abs(parseMoney(refund.total)), 0),
    customerNote: order.customer_note ?? "",
    checkoutSource: "woocommerce",
    source: "woocommerce",
    gatewayVerification: {
      provider: "",
      matched: false,
      confidence: "not_found",
      matchedBy: "",
      transactionId: order.transaction_id ?? "",
      transactionStatus: "",
      amount: getOrderTotal(order, lineItems),
      transactionDate: paid ? order.date_paid ?? orderDate : orderDate,
      paymentProfileId: "",
      rawSummary: "",
      lastCheckedAt: "",
      configured: false,
      notes: "",
    },
  };
  item.gatewayVerification = await verifyOrderPayment(item);
  return item;
}

function getLeadUrgency(paidTotal: number, attemptedTotal: number, attemptedOrderCount: number, lastAttemptDate: string) {
  if (paidTotal > 0) return "customer";
  const lastAttempt = lastAttemptDate ? new Date(lastAttemptDate) : null;
  const attemptedWithin24h = Boolean(lastAttempt && !Number.isNaN(lastAttempt.getTime()) && Date.now() - lastAttempt.getTime() <= 86400000);
  if (attemptedTotal >= 500 || attemptedWithin24h) return "very_high";
  if (attemptedTotal >= 100 || attemptedOrderCount > 1) return "high";
  return "medium";
}

function getRecommendedContactMethod(phone: string, leadUrgency: string, paidTotal: number) {
  if (paidTotal > 0) return phone ? "phone" : "email";
  if (phone && ["very_high", "high"].includes(leadUrgency)) return "phone";
  if (phone) return "SMS";
  return "email";
}

function getNextAction(paidTotal: number, recommendedContactMethod: string, attemptedTotal: number) {
  if (paidTotal > 0) return "Review upsell or renewal opportunity";
  if (attemptedTotal <= 0) return "Manual review";
  if (recommendedContactMethod === "phone") return "Call and resend payment link";
  if (recommendedContactMethod === "SMS") return "Send checkout recovery SMS";
  return "Send checkout recovery email";
}

function productList(values: string[]) {
  return values.length > 0 ? values.join(", ") : "selected product";
}

function getProductAwareNextAction(
  paidTotal: number,
  attemptedTotal: number,
  fallbackNextAction: string,
  productSummary: ProductJourneySummary
) {
  if (paidTotal > 0) {
    if (productSummary.baseProductsPurchased.length > 0 && productSummary.boostProductsPurchased.length > 0) {
      return "Review retention and cross-sell missing boosts or add-ons.";
    }
    if (productSummary.baseProductsPurchased.length > 0) {
      return "Suggest a boost upsell for the base product.";
    }
    return fallbackNextAction;
  }

  const attemptedProducts = [
    ...productSummary.attemptedBaseProducts,
    ...productSummary.attemptedBoostProducts,
    ...productSummary.attemptedAddOnProducts,
  ];
  if (attemptedTotal > 0 && productSummary.attemptedBoostProducts.length > 0 && productSummary.baseProductsPurchased.length === 0) {
    return `Requires review: attempted boost without paid base product (${productList(productSummary.attemptedBoostProducts)}).`;
  }
  if (attemptedTotal > 0 && attemptedProducts.length > 0) {
    return `Recover checkout for ${productList(attemptedProducts)}.`;
  }
  return fallbackNextAction;
}

function getSubscriptionStatus(order: WooCommerceOrder): CustomerScoreInput["subscriptionStatus"] {
  const metaValue = order.meta_data?.find((meta) => meta.key?.toLowerCase().includes("subscription_status"))?.value?.toString().toLowerCase();
  if (metaValue && subscriptionStatuses.includes(metaValue as CustomerScoreInput["subscriptionStatus"])) return metaValue as CustomerScoreInput["subscriptionStatus"];
  return "unknown";
}

const getTier = (paidTotal: number, attemptedTotal: number) => paidTotal > 0 ? paidTotal >= 2500 ? "Platinum" : paidTotal >= 999 ? "Gold" : paidTotal >= 200 ? "Silver" : "Bronze" : attemptedTotal > 0 ? "Lead" : "Cold Lead";
const getLeadStatus = (paidTotal: number, attemptedTotal: number) => paidTotal > 0 ? "customer" : attemptedTotal >= 2000 ? "very_hot_lead" : attemptedTotal > 0 ? "hot_lead" : "cold_lead";
const getPaymentStatus = (paidTotal: number, attemptedTotal: number, lastAttemptStatus = "", lastAttemptPaymentMethod = "") => {
  if (paidTotal > 0) return "paid";
  const paymentMethod = lastAttemptPaymentMethod.toLowerCase();
  if (attemptedTotal > 0 && lastAttemptStatus === "on-hold" && paymentMethod.includes("crypto")) return "crypto_on_hold";
  return attemptedTotal > 0 ? "attempted_unpaid" : "unpaid";
};
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

    const orderHistoryItem = await buildOrderHistoryItem(order);
    const productNames = orderHistoryItem.lineItems.map((item) => item.name);
    const paymentMethodLabel = getPaymentMethodLabel(order);
    const total = orderHistoryItem.total;
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
      paidOrderCount: (existing?.paidOrderCount ?? 0) + (isPaidOrder(order) ? 1 : 0),
      attemptedOrderCount: (existing?.attemptedOrderCount ?? 0) + (!isPaidOrder(order) ? 1 : 0),
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
      orders: [...(existing?.orders ?? []), orderHistoryItem],
      lastProducts: isLatest || !existing ? productNames : existing.lastProducts,
      attemptedProducts: unique([...(existing?.attemptedProducts ?? []), ...(!isPaidOrder(order) ? productNames : [])]),
      paidProducts: unique([...(existing?.paidProducts ?? []), ...(isPaidOrder(order) ? productNames : [])]),
      lastPaymentMethod: isLatestPaid ? paymentMethodLabel : existing?.lastPaymentMethod ?? "",
      lastAttemptPaymentMethod: isLatestAttempt ? paymentMethodLabel : existing?.lastAttemptPaymentMethod ?? "",
      lastAttemptStatus: isLatestAttempt ? getOrderStatus(order) : existing?.lastAttemptStatus ?? "",
    });
  }

  return Promise.all(Array.from(grouped.values()).map(async (customer) => {
    const score = calculateCustomerScore(customer);
    const averageOrderValue = customer.paidOrderCount > 0 ? customer.paidTotal / customer.paidOrderCount : 0;
    const estimatedCreditLimit = customer.paidTotal > 0 ? estimateCreditLimit(customer.paidTotal, customer.paidOrderCount, customer.failedPayments, customer.refunds, score) : 0;
    const sortedOrders = [...customer.orders].sort((a, b) => new Date(b.dateCreated).getTime() - new Date(a.dateCreated).getTime());
    const productSummary = buildProductJourneySummary(sortedOrders);
    const leadUrgency = getLeadUrgency(customer.paidTotal, customer.attemptedTotal, customer.attemptedOrderCount, customer.lastAttemptDate);
    const recommendedContactMethod = getRecommendedContactMethod(customer.phone, leadUrgency, customer.paidTotal);
    const nextAction = getNextAction(customer.paidTotal, recommendedContactMethod, customer.attemptedTotal);
    const productAwareNextAction = getProductAwareNextAction(customer.paidTotal, customer.attemptedTotal, nextAction, productSummary);
    const gatewayVerification = sortedOrders.find((order) => order.gatewayVerification?.matched)?.gatewayVerification ?? sortedOrders[0]?.gatewayVerification;
    const baseCustomer = {
      ...customer,
      orders: sortedOrders,
      ...productSummary,
      totalPaid: customer.paidTotal,
      averageOrderValue,
      estimatedCreditLimit,
      tier: getTier(customer.paidTotal, customer.attemptedTotal),
      leadStatus: getLeadStatus(customer.paidTotal, customer.attemptedTotal),
      paymentStatus: getPaymentStatus(customer.paidTotal, customer.attemptedTotal, customer.lastAttemptStatus, customer.lastAttemptPaymentMethod),
      riskLevel: getRiskLevel(customer, score),
      lastSyncedAt: todayIso,
      score,
      stars: scoreToStars(score),
      leadUrgency,
      recommendedContactMethod,
      nextAction: productAwareNextAction,
      gatewayVerification: gatewayVerification ?? {
        provider: "",
        matched: false,
        confidence: "not_found" as const,
        matchedBy: "",
        transactionId: "",
        transactionStatus: "",
        amount: 0,
        transactionDate: "",
        paymentProfileId: "",
        rawSummary: "",
        lastCheckedAt: "",
        configured: false,
        notes: "No WooCommerce orders found for gateway verification.",
      },
    };
    const aiSummary = buildRuleBasedSummary(baseCustomer);
    return { ...baseCustomer, ...aiSummary, recommendedAction: productAwareNextAction };
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
  const attemptedOrders = orders.length - paidOrders;
  const unpaidOrders = attemptedOrders;
  const onHoldOrders = orders.filter((order) => getOrderStatus(order) === "on-hold").length;
  const cryptoAttemptOrders = orders.filter((order) => !isPaidOrder(order) && getPaymentMethodLabel(order).toLowerCase().includes("crypto")).length;
  const ordersWithZeroTotal = orders.filter((order) => parseMoney(order.total) <= 0).length;
  const ordersRecoveredFromLineItems = orders.filter((order) => parseMoney(order.total) <= 0 && getOrderTotal(order) > 0).length;
  const skippedOrdersWithoutEmail = orders.filter((order) => !getOrderEmail(order)).length;
  const paidCustomers = customers.filter((customer) => customer.paidTotal > 0).length;
  const attemptedCheckoutLeads = customers.filter((customer) => customer.paidTotal === 0 && customer.attemptedTotal > 0).length;
  const customersWithOrderTimeline = customers.filter((customer) => customer.orders.length > 0).length;
  const customersWithAttemptedTimeline = customers.filter((customer) => customer.orders.some((order) => order.isAttempted)).length;
  const customersWithAttemptedProducts = customers.filter((customer) => customer.attemptedProducts.length > 0).length;
  const customersWithPaidProducts = customers.filter((customer) => customer.paidProducts.length > 0).length;
  const customersWithProductJourney = customers.filter((customer) => customer.productJourney.length > 0).length;
  const gatewayConfiguration = getGatewayConfigurationSummary();

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
    attemptedOrders,
    onHoldOrders,
    cryptoAttemptOrders,
    ordersWithZeroTotal,
    ordersRecoveredFromLineItems,
    customersWithOrderTimeline,
    customersWithAttemptedTimeline,
    customersWithAttemptedProducts,
    customersWithPaidProducts,
    customersWithProductJourney,
    gatewayVerificationChecked: orders.length,
    gatewayVerificationConfigured: hasConfiguredGateway(),
    gatewayConfiguration,
    pagesFetched: orderResult.pagesFetched,
    partialSync: orderResult.partialSync,
    warning: orderResult.warning || (orderResult.reachedPageLimit ? "Partial sync, reached page limit." : ""),
    fetchedByStatus: orderResult.fetchedByStatus,
    pagesFetchedByStatus: orderResult.pagesFetchedByStatus,
    failedRequests: orderResult.failedRequests,
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

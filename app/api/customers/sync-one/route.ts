import { NextResponse } from "next/server";
import { calculateCustomerScore, scoreToStars, type CustomerScoreInput } from "@/lib/customerScore";
import { getOrderStatus, isPaidOrder, parseMoney } from "@/lib/businessMetrics";
import { getGatewayConfigurationSummary, hasConfiguredGateway, verifyOrderPayment } from "@/lib/paymentGateways";
import { connectToDatabase } from "@/lib/mongodb";
import { buildProductJourneySummary, type ProductJourneySummary } from "@/lib/productClassification";
import { fetchWooCommerceOrders, isWooCommerceConfigured, type WooCommerceOrder } from "@/lib/woocommerce";
import { Customer, type CustomerDocument, type CustomerOrderHistoryItem, type CustomerOrderLineItem } from "@/models/Customer";

const todayIso = new Date().toISOString();
const syncOneMaxPages = () => {
  const value = Number(process.env.WC_SYNC_ONE_MAX_PAGES ?? process.env.WC_MAX_PAGES ?? 25);
  return Number.isFinite(value) && value > 0 ? value : 25;
};

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

function estimateCreditLimit(totalPaid: number, orderCount: number, failedPayments: number, refunds: number, score: number) {
  const velocityFactor = Math.max(1, Math.min(3, orderCount / 4));
  const riskPenalty = failedPayments * 180 + refunds * 120 + (100 - score) * 5;
  return Math.max(300, Math.round(totalPaid * 0.8 * velocityFactor - riskPenalty));
}

function getTier(paidTotal: number, attemptedTotal: number) {
  if (paidTotal > 0) return paidTotal >= 2500 ? "Platinum" : paidTotal >= 999 ? "Gold" : paidTotal >= 200 ? "Silver" : "Bronze";
  return attemptedTotal > 0 ? "Lead" : "Cold Lead";
}

function getLeadStatus(paidTotal: number, attemptedTotal: number, attemptedOrderCount: number) {
  if (paidTotal > 0) return "customer";
  if (attemptedTotal >= 500 || attemptedOrderCount > 1) return "very_hot_lead";
  return attemptedTotal > 0 ? "hot_lead" : "cold_lead";
}

function getPaymentStatus(paidTotal: number, attemptedTotal: number, lastAttemptStatus: string, lastAttemptPaymentMethod: string) {
  if (paidTotal > 0) return "paid";
  if (attemptedTotal > 0 && lastAttemptStatus === "on-hold" && lastAttemptPaymentMethod.toLowerCase().includes("crypto")) return "crypto_on_hold";
  return attemptedTotal > 0 ? "attempted_unpaid" : "unpaid";
}

function getLeadUrgency(paidTotal: number, attemptedTotal: number, attemptedOrderCount: number, lastAttemptDate: string) {
  if (paidTotal > 0) return "customer";
  const lastAttempt = lastAttemptDate ? new Date(lastAttemptDate) : null;
  const attemptedWithin24h = Boolean(lastAttempt && !Number.isNaN(lastAttempt.getTime()) && Date.now() - lastAttempt.getTime() <= 86400000);
  if (attemptedTotal >= 500 || attemptedWithin24h) return "very_high";
  if (attemptedTotal >= 100 || attemptedOrderCount > 1) return "high";
  return "medium";
}

function getNextAction(paidTotal: number, attemptedTotal: number, phone: string, leadUrgency: string) {
  if (paidTotal > 0) return { recommendedContactMethod: phone ? "phone" : "email", nextAction: "Review upsell or renewal opportunity" };
  if (attemptedTotal <= 0) return { recommendedContactMethod: phone ? "SMS" : "email", nextAction: "Manual review" };
  if (phone && ["very_high", "high"].includes(leadUrgency)) return { recommendedContactMethod: "phone", nextAction: "Call and resend secure payment link" };
  if (phone) return { recommendedContactMethod: "SMS", nextAction: "Send checkout recovery SMS" };
  return { recommendedContactMethod: "email", nextAction: "Send checkout recovery email" };
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

function getRiskLevel(input: Pick<CustomerScoreInput, "chargebacks" | "failedPayments" | "refunds">, score: number): "low" | "medium" | "high" {
  return (input.chargebacks > 0 || input.failedPayments > 2 || score < 45) ? "high" : (input.refunds > 1 || input.failedPayments > 0 || score < 70) ? "medium" : "low";
}

function buildRuleSummary(name: string, paidTotal: number, paidOrderCount: number, attemptedTotal: number) {
  const aiSummary = paidTotal > 0
    ? `${name} is a paid customer with ${paidOrderCount} paid orders totaling $${paidTotal.toFixed(2)}.`
    : attemptedTotal > 0
      ? "This is a hot lead who attempted checkout but has not completed payment."
      : `${name} has not completed payment yet.`;
  return {
    aiSummary,
    aiSummaryPreview: aiSummary.slice(0, 110) + (aiSummary.length > 110 ? "..." : ""),
    riskExplanation: attemptedTotal > 0 && paidTotal === 0 ? "Checkout attempt exists without completed payment." : "Payment and refund patterns do not show elevated risk.",
    recommendedAction: paidTotal > 0 ? "Review upsell, renewal, or support opportunity." : attemptedTotal > 0 ? "Call and resend secure payment link." : "Manual review.",
  };
}

async function fetchOrdersForEmail(email: string) {
  const maxPages = syncOneMaxPages();
  const searched = await fetchWooCommerceOrders({ email, maxPages });
  const searchedOrders = searched?.items.filter((order) => getOrderEmail(order) === email) ?? [];
  if (searchedOrders.length > 0 || !searched) {
    return { result: searched, orders: searchedOrders, fetchedWithSearch: true };
  }

  const fallback = await fetchWooCommerceOrders({ maxPages });
  return {
    result: fallback,
    orders: fallback?.items.filter((order) => getOrderEmail(order) === email) ?? [],
    fetchedWithSearch: false,
    warning: "WooCommerce email search returned no matching orders; used status-limited local filtering.",
  };
}

async function buildCustomerFromOrders(email: string, orders: WooCommerceOrder[], existing: CustomerDocument | null) {
  const orderHistory = (await Promise.all(orders.map(buildOrderHistoryItem)))
    .sort((a, b) => new Date(b.dateCreated).getTime() - new Date(a.dateCreated).getTime());
  const productSummary = buildProductJourneySummary(orderHistory);
  const paidOrders = orderHistory.filter((order) => order.isPaid);
  const attemptedOrders = orderHistory.filter((order) => order.isAttempted);
  const paidTotal = paidOrders.reduce((sum, order) => sum + order.total, 0);
  const attemptedTotal = attemptedOrders.reduce((sum, order) => sum + order.total, 0);
  const latest = orderHistory[0];
  const latestAttempt = attemptedOrders[0];
  const latestPaid = paidOrders[0];
  const first = [...orderHistory].sort((a, b) => new Date(a.dateCreated).getTime() - new Date(b.dateCreated).getTime())[0];
  const failedPayments = orderHistory.filter((order) => ["failed", "payment_pending", "crypto_pending"].includes(order.status)).length;
  const refunds = orderHistory.reduce((sum, order) => sum + order.refundsCount, 0);
  const baseScoreInput = {
    totalPaid: paidTotal,
    subscriptionStatus: existing?.subscriptionStatus ?? "unknown",
    lastOrderDate: latest?.dateCreated ?? todayIso,
    refunds,
    chargebacks: existing?.chargebacks ?? 0,
    failedPayments,
  } satisfies CustomerScoreInput;
  const score = calculateCustomerScore(baseScoreInput);
  const leadUrgency = getLeadUrgency(paidTotal, attemptedTotal, attemptedOrders.length, latestAttempt?.dateCreated ?? "");
  const { recommendedContactMethod, nextAction } = getNextAction(paidTotal, attemptedTotal, latest?.billingPhone ?? existing?.phone ?? "", leadUrgency);
  const productAwareNextAction = getProductAwareNextAction(paidTotal, attemptedTotal, nextAction, productSummary);
  const summary = buildRuleSummary(latest?.billingName || existing?.name || email, paidTotal, paidOrders.length, attemptedTotal);
  const gatewayVerification = orderHistory.find((order) => order.gatewayVerification?.matched)?.gatewayVerification ?? latest?.gatewayVerification;

  return {
    name: latest?.billingName || existing?.name || email,
    email,
    phone: latest?.billingPhone || existing?.phone || "",
    paidTotal,
    attemptedTotal,
    totalPaid: paidTotal,
    orderCount: orderHistory.length,
    paidOrderCount: paidOrders.length,
    attemptedOrderCount: attemptedOrders.length,
    firstOrderDate: first?.dateCreated ?? existing?.firstOrderDate ?? todayIso,
    lastOrderDate: latest?.dateCreated ?? existing?.lastOrderDate ?? todayIso,
    lastPaidDate: latestPaid?.dateCreated ?? "",
    lastAttemptDate: latestAttempt?.dateCreated ?? "",
    lastOrderAmount: latest?.total ?? 0,
    averageOrderValue: paidOrders.length > 0 ? paidTotal / paidOrders.length : 0,
    subscriptionStatus: existing?.subscriptionStatus ?? "unknown",
    activeSubscriptions: existing?.activeSubscriptions ?? 0,
    failedPayments,
    refunds,
    chargebacks: existing?.chargebacks ?? 0,
    actualCreditLimit: existing?.actualCreditLimit ?? null,
    estimatedCreditLimit: paidTotal > 0 ? estimateCreditLimit(paidTotal, paidOrders.length, failedPayments, refunds, score) : 0,
    tier: getTier(paidTotal, attemptedTotal),
    leadStatus: getLeadStatus(paidTotal, attemptedTotal, attemptedOrders.length),
    paymentStatus: getPaymentStatus(paidTotal, attemptedTotal, latestAttempt?.status ?? "", latestAttempt?.paymentMethodTitle || latestAttempt?.paymentMethod || ""),
    riskLevel: getRiskLevel(baseScoreInput, score),
    tags: existing?.tags ?? [],
    notes: existing?.notes ?? "",
    lastSyncedAt: todayIso,
    score,
    stars: scoreToStars(score),
    orders: orderHistory,
    lastProducts: unique(latest?.lineItems.map((item) => item.name) ?? []),
    attemptedProducts: unique(attemptedOrders.flatMap((order) => order.lineItems.map((item) => item.name))),
    paidProducts: unique(paidOrders.flatMap((order) => order.lineItems.map((item) => item.name))),
    ...productSummary,
    lastPaymentMethod: latestPaid?.paymentMethodTitle || latestPaid?.paymentMethod || "",
    lastAttemptPaymentMethod: latestAttempt?.paymentMethodTitle || latestAttempt?.paymentMethod || "",
    lastAttemptStatus: latestAttempt?.status ?? "",
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
    ...summary,
    recommendedAction: productAwareNextAction,
  };
}

export async function POST(request: Request) {
  if (!isWooCommerceConfigured()) {
    return NextResponse.json({ error: "WooCommerce is not configured.", saved: false }, { status: 400 });
  }

  const body = await request.json().catch(() => ({})) as { email?: string };
  const email = body.email?.trim().toLowerCase();
  if (!email) return NextResponse.json({ error: "email is required" }, { status: 400 });

  const { result, orders, fetchedWithSearch, warning } = await fetchOrdersForEmail(email);
  if (!result) {
    return NextResponse.json({ error: "Unable to fetch WooCommerce orders.", email, saved: false }, { status: 502 });
  }

  const connection = await connectToDatabase();
  if (!connection) return NextResponse.json({ error: "MongoDB is unavailable.", email, saved: false, ordersFetchedForEmail: orders.length }, { status: 503 });

  const existing = await Customer.findOne({ email }).lean<CustomerDocument | null>();
  const customer = await buildCustomerFromOrders(email, orders, existing);
  await Customer.findOneAndUpdate(
    { email },
    { $set: customer },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  const orderNumbers = customer.orders.map((order) => order.orderNumber);
  const statuses = unique(customer.orders.map((order) => order.status));
  const paymentMethods = unique(customer.orders.map((order) => order.paymentMethodTitle || order.paymentMethod));
  const products = unique(customer.orders.flatMap((order) => order.lineItems.map((item) => item.name)));
  const ordersWithZeroTotal = orders.filter((order) => parseMoney(order.total) <= 0).length;
  const ordersRecoveredFromLineItems = orders.filter((order) => parseMoney(order.total) <= 0 && getOrderTotal(order) > 0).length;

  return NextResponse.json({
    email,
    saved: true,
    fetchedWithSearch,
    ordersFetchedForEmail: orders.length,
    ordersSaved: customer.orders.length,
    attemptedTotal: customer.attemptedTotal,
    attemptedOrderCount: customer.attemptedOrderCount,
    attemptedProducts: customer.attemptedProducts,
    firstSignupProduct: customer.firstSignupProduct,
    firstSignupDate: customer.firstSignupDate,
    firstSignupAmount: customer.firstSignupAmount,
    baseProductsPurchased: customer.baseProductsPurchased,
    boostProductsPurchased: customer.boostProductsPurchased,
    attemptedBaseProducts: customer.attemptedBaseProducts,
    attemptedBoostProducts: customer.attemptedBoostProducts,
    attemptedAddOnProducts: customer.attemptedAddOnProducts,
    productJourneyCount: customer.productJourney.length,
    orderNumbers,
    statuses,
    paymentMethods,
    products,
    pagesFetched: result.pagesFetched,
    fetchedByStatus: result.fetchedByStatus,
    pagesFetchedByStatus: result.pagesFetchedByStatus,
    failedRequests: result.failedRequests,
    partialSync: result.partialSync,
    warning: [warning, result.warning].filter(Boolean).join(" "),
    ordersWithZeroTotal,
    ordersRecoveredFromLineItems,
    gatewayVerificationChecked: customer.orders.length,
    gatewayVerificationConfigured: hasConfiguredGateway(),
    gatewayConfiguration: getGatewayConfigurationSummary(),
  });
}

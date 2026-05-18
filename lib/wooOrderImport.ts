import { getOrderStatus, isPaidOrder, parseMoney } from "@/lib/businessMetrics";
import { buildProductJourneySummary } from "@/lib/productClassification";
import type { WooCommerceOrder } from "@/lib/woocommerce";
import type { CustomerBillingAddress, CustomerOrderHistoryItem, CustomerOrderLineItem, CustomerOrderMetaSummary } from "@/models/Customer";
import type { WooCommerceOrderDocument } from "@/models/WooCommerceOrder";

export function normalizeEmail(value?: string) {
  return (value ?? "").trim().toLowerCase();
}

export function normalizePhone(value?: string) {
  return (value ?? "").replace(/\D/g, "");
}

export function normalizeText(value?: string) {
  return (value ?? "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function unique(values: string[]) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

export function countBy(values: string[]) {
  return values.reduce<Record<string, number>>((acc, value) => {
    const key = value || "unknown";
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
}

export function getLineItems(order: WooCommerceOrder): CustomerOrderLineItem[] {
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

export function getOrderTotal(order: WooCommerceOrder, lineItems = getLineItems(order)) {
  const total = parseMoney(order.total);
  if (total > 0) return total;
  return lineItems.reduce((sum, item) => sum + item.total, 0);
}

function safeMetaValue(value: unknown) {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value).slice(0, 120);
  return "";
}

export function getSafeMetaData(order: WooCommerceOrder): CustomerOrderMetaSummary[] {
  const sensitive = /(token|secret|password|pass|key|card|cc|cvv|nonce|auth|signature)/i;
  return (order.meta_data ?? [])
    .map((meta) => ({ key: String(meta.key ?? ""), value: safeMetaValue(meta.value) }))
    .filter((meta) => meta.key && meta.value && !sensitive.test(meta.key))
    .slice(0, 25);
}

export function billingAddressFromWoo(order: WooCommerceOrder): CustomerBillingAddress {
  return {
    address1: order.billing?.address_1 ?? "",
    address2: order.billing?.address_2 ?? "",
    city: order.billing?.city ?? "",
    state: order.billing?.state ?? "",
    postcode: order.billing?.postcode ?? "",
    country: order.billing?.country ?? "",
  };
}

export function billingName(firstName?: string, lastName?: string, email?: string) {
  return `${firstName?.trim() ?? ""} ${lastName?.trim() ?? ""}`.trim() || email || "WooCommerce Customer";
}

export function orderHistoryItemFromWooOrder(order: WooCommerceOrder): CustomerOrderHistoryItem {
  const lineItems = getLineItems(order);
  const paid = isPaidOrder(order);
  const dateCreated = order.date_created ?? new Date().toISOString();
  const total = getOrderTotal(order, lineItems);
  const email = normalizeEmail(order.billing?.email);
  return {
    orderId: String(order.id),
    orderNumber: String(order.number ?? order.id),
    customerId: Number(order.customer_id ?? 0),
    status: getOrderStatus(order) || "unknown",
    dateCreated,
    dateModified: order.date_modified ?? "",
    total,
    currency: order.currency ?? "",
    paymentMethod: order.payment_method ?? "",
    paymentMethodTitle: order.payment_method_title ?? "",
    transactionId: order.transaction_id ?? "",
    paidDate: order.date_paid ?? "",
    attemptedDate: paid ? "" : dateCreated,
    isPaid: paid,
    isAttempted: !paid,
    billingName: billingName(order.billing?.first_name, order.billing?.last_name, order.billing?.email),
    billingEmail: email,
    billingPhone: order.billing?.phone ?? "",
    billingFirstName: order.billing?.first_name ?? "",
    billingLastName: order.billing?.last_name ?? "",
    billingCompany: order.billing?.company ?? "",
    billingAddress: billingAddressFromWoo(order),
    lineItems,
    products: lineItems,
    refundsCount: order.refunds?.length ?? (getOrderStatus(order) === "refunded" ? 1 : 0),
    refundsAmount: (order.refunds ?? []).reduce((sum, refund) => sum + Math.abs(parseMoney(refund.total)), 0),
    metaData: getSafeMetaData(order),
    customerNote: order.customer_note ?? "",
    checkoutSource: "woocommerce",
    source: "woocommerce",
    matchedBy: email ? ["email"] : normalizePhone(order.billing?.phone) ? ["phone"] : [],
    matchConfidence: email ? "exact" : normalizePhone(order.billing?.phone) ? "high" : "",
    gatewayVerification: {
      provider: "",
      matched: false,
      confidence: "not_found",
      matchedBy: "",
      transactionId: order.transaction_id ?? "",
      transactionStatus: "",
      amount: total,
      transactionDate: paid ? order.date_paid ?? dateCreated : dateCreated,
      customerVaultId: "",
      paymentProfileId: "",
      customerProfileId: "",
      paymentIntentId: "",
      chargeId: "",
      stripeCustomerId: "",
      paymentMethodId: "",
      last4: "",
      cardType: "",
      candidatesCount: 0,
      rawSummary: "",
      lastCheckedAt: "",
      configured: false,
      notes: "",
    },
  };
}

export function normalizeWooOrder(order: WooCommerceOrder, importedAt = new Date().toISOString()): Partial<WooCommerceOrderDocument> {
  const historyItem = orderHistoryItemFromWooOrder(order);
  const productJourneyItems = buildProductJourneySummary([historyItem]).productJourney;
  const normalizedEmail = normalizeEmail(order.billing?.email);
  const normalizedPhone = normalizePhone(order.billing?.phone);
  const normalizedCompany = normalizeText(order.billing?.company);
  return {
    wooOrderId: Number(order.id),
    orderNumber: historyItem.orderNumber,
    status: historyItem.status,
    dateCreated: historyItem.dateCreated,
    dateModified: historyItem.dateModified,
    total: historyItem.total,
    currency: historyItem.currency,
    paymentMethod: historyItem.paymentMethod,
    paymentMethodTitle: historyItem.paymentMethodTitle,
    transactionId: historyItem.transactionId,
    customerId: Number(order.customer_id ?? 0),
    billingFirstName: historyItem.billingFirstName,
    billingLastName: historyItem.billingLastName,
    billingName: historyItem.billingName,
    billingEmail: order.billing?.email ?? "",
    normalizedEmail,
    billingPhone: historyItem.billingPhone,
    normalizedPhone,
    billingCompany: historyItem.billingCompany,
    normalizedCompany,
    billingAddress: historyItem.billingAddress,
    lineItems: historyItem.lineItems,
    products: historyItem.products,
    refundsCount: historyItem.refundsCount,
    refundsAmount: historyItem.refundsAmount,
    customerNote: historyItem.customerNote,
    source: "woocommerce",
    rawSafeMeta: historyItem.metaData,
    isPaid: historyItem.isPaid,
    isAttempted: historyItem.isAttempted,
    paidAmount: historyItem.isPaid ? historyItem.total : 0,
    attemptedAmount: historyItem.isPaid ? 0 : historyItem.total,
    productJourneyItems,
    importedAt,
  };
}

export function orderHistoryItemFromStoredOrder(order: WooCommerceOrderDocument): CustomerOrderHistoryItem {
  return {
    orderId: String(order.wooOrderId),
    orderNumber: String(order.orderNumber || order.wooOrderId),
    customerId: Number(order.customerId ?? 0),
    status: order.status || "unknown",
    dateCreated: order.dateCreated,
    dateModified: order.dateModified,
    total: Number(order.total ?? 0),
    currency: order.currency ?? "",
    paymentMethod: order.paymentMethod ?? "",
    paymentMethodTitle: order.paymentMethodTitle ?? "",
    transactionId: order.transactionId ?? "",
    paidDate: order.isPaid ? order.dateCreated : "",
    attemptedDate: order.isPaid ? "" : order.dateCreated,
    isPaid: Boolean(order.isPaid),
    isAttempted: !order.isPaid,
    billingName: order.billingName ?? "",
    billingEmail: order.normalizedEmail || order.billingEmail || "",
    billingPhone: order.billingPhone ?? "",
    billingFirstName: order.billingFirstName ?? "",
    billingLastName: order.billingLastName ?? "",
    billingCompany: order.billingCompany ?? "",
    billingAddress: order.billingAddress,
    lineItems: order.lineItems ?? [],
    products: order.products ?? order.lineItems ?? [],
    refundsCount: Number(order.refundsCount ?? 0),
    refundsAmount: Number(order.refundsAmount ?? 0),
    metaData: order.rawSafeMeta ?? [],
    customerNote: order.customerNote ?? "",
    checkoutSource: "woocommerce",
    source: "woocommerce_order_backfill",
    matchedBy: order.normalizedEmail ? ["email"] : order.normalizedPhone ? ["phone"] : order.customerId ? ["customer_id"] : [],
    matchConfidence: order.normalizedEmail || order.customerId ? "exact" : order.normalizedPhone ? "high" : "",
    gatewayVerification: {
      provider: "",
      matched: false,
      confidence: "not_found",
      matchedBy: "",
      transactionId: order.transactionId ?? "",
      transactionStatus: "",
      amount: Number(order.total ?? 0),
      transactionDate: order.dateCreated,
      customerVaultId: "",
      paymentProfileId: "",
      customerProfileId: "",
      paymentIntentId: "",
      chargeId: "",
      stripeCustomerId: "",
      paymentMethodId: "",
      last4: "",
      cardType: "",
      candidatesCount: 0,
      rawSummary: "",
      lastCheckedAt: "",
      configured: false,
      notes: "",
    },
  };
}

import { parseMoney } from "@/lib/businessMetrics";
import type { WooCommerceSubscription } from "@/lib/woocommerce";
import { normalizeEmail } from "@/lib/wooOrderImport";
import type { WooCommerceSubscriptionDocument } from "@/models/WooCommerceSubscription";

function customerName(subscription: WooCommerceSubscription) {
  return `${subscription.billing?.first_name?.trim() ?? ""} ${subscription.billing?.last_name?.trim() ?? ""}`.trim() || subscription.billing?.email || "WooCommerce Subscriber";
}

function relatedOrderIds(subscription: WooCommerceSubscription) {
  const ids = [
    subscription.parent_id,
    ...(subscription.related_orders ?? []),
  ].filter((value): value is number => Number.isFinite(Number(value)) && Number(value) > 0);
  return Array.from(new Set(ids.map(Number)));
}

export function normalizeWooSubscription(subscription: WooCommerceSubscription, importedAt = new Date().toISOString()): Partial<WooCommerceSubscriptionDocument> {
  return {
    wooSubscriptionId: Number(subscription.id),
    subscriptionNumber: String(subscription.number ?? subscription.id),
    status: (subscription.status ?? "unknown").trim().toLowerCase(),
    customerId: Number(subscription.customer_id ?? 0),
    customerName: customerName(subscription),
    customerEmail: subscription.billing?.email ?? "",
    normalizedEmail: normalizeEmail(subscription.billing?.email),
    customerPhone: subscription.billing?.phone ?? "",
    productNames: Array.from(new Set((subscription.line_items ?? []).map((item) => item.name ?? "").filter(Boolean))),
    amount: parseMoney(subscription.total),
    currency: subscription.currency ?? "",
    billingInterval: String(subscription.billing_interval ?? ""),
    billingPeriod: subscription.billing_period ?? "",
    startDate: subscription.start_date ?? subscription.date_created ?? "",
    nextPaymentDate: subscription.next_payment_date ?? subscription.next_payment_date_gmt ?? "",
    lastPaymentDate: subscription.last_payment_date ?? subscription.last_payment_date_gmt ?? "",
    endDate: subscription.end_date ?? "",
    paymentMethod: subscription.payment_method ?? "",
    paymentMethodTitle: subscription.payment_method_title ?? "",
    relatedOrderIds: relatedOrderIds(subscription),
    importedAt,
  };
}

import type { SubscriptionDocument } from "@/models/Subscription";
import type { WooCommerceOrder } from "@/lib/woocommerce";

const toIso = (value?: string) => {
  if (!value) return "";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
};

export function mapWooOrdersToSubscriptions(orders: WooCommerceOrder[]): Partial<SubscriptionDocument>[] {
  return orders.reduce<Partial<SubscriptionDocument>[]>((acc, order) => {
    const email = order.billing?.email?.trim().toLowerCase();
    if (!email) return acc;
    const nextBillingMeta = order.meta_data?.find((m) => (m.key ?? "").toLowerCase().includes("next_payment"))?.value?.toString();
    const subStatus = order.meta_data?.find((m) => (m.key ?? "").toLowerCase().includes("subscription_status"))?.value?.toString().toLowerCase() ?? "unknown";
    const nextBillingDate = toIso(nextBillingMeta);
    const isRealSubscription = subStatus === "active" && Boolean(nextBillingDate);
    const amount = Number(order.total ?? 0);
    acc.push({
      subscriptionId: `wc-order-${order.id}`,
      source: "woocommerce",
      customerEmail: email,
      customerName: `${order.billing?.first_name ?? ""} ${order.billing?.last_name ?? ""}`.trim(),
      customerPhone: order.billing?.phone ?? "",
      gatewayCustomerId: "",
      gatewayProfileId: "",
      status: isRealSubscription ? "active" : subStatus as SubscriptionDocument["status"],
      amount: Number.isFinite(amount) ? amount : 0,
      billingInterval: "monthly",
      nextBillingDate,
      lastBillingDate: toIso(order.date_created),
      failedPaymentCount: order.status === "failed" ? 1 : 0,
      lastPaymentStatus: order.status ?? "unknown",
      monthlyRecurringRevenue: isRealSubscription && Number.isFinite(amount) ? amount : 0,
      isPlaceholder: false,
      sourceStatus: isRealSubscription ? "real" : "candidate",
      recordType: isRealSubscription ? "subscription" : "subscription_candidate",
      lastSyncedAt: new Date().toISOString(),
    });
    return acc;
  }, []);
}

export function buildSourcePlaceholders(nowIso: string) {
  return {
    stripe: [] as Partial<SubscriptionDocument>[],
    authorize_net: [] as Partial<SubscriptionDocument>[],
    nmi: [] as Partial<SubscriptionDocument>[],
    manual: [] as Partial<SubscriptionDocument>[],
    readOnlyNote: `Prepared source connectors for Stripe/Authorize.net/NMI/manual as of ${nowIso}. No charging/retry actions performed.`,
  };
}

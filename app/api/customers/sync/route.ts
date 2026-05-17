import { NextResponse } from "next/server";
import { calculateCustomerScore, scoreToStars, type CustomerScoreInput } from "@/lib/customerScore";
import { connectToDatabase } from "@/lib/mongodb";
import { generateCustomerAiSummary } from "@/lib/openai";
import {
  fetchWooCommerceCustomers,
  fetchWooCommerceOrders,
  isWooCommerceConfigured,
  type WooCommerceOrder,
} from "@/lib/woocommerce";
import { Customer } from "@/models/Customer";

type SyncedCustomer = CustomerScoreInput & {
  _id: string;
  name: string;
  email: string;
  phone: string;
  orderCount: number;
  lastOrderAmount: number;
  activeSubscriptions: number;
  creditLimit: number;
  tier: string;
  aiSummary: string;
  recommendedAction: string;
  score: number;
  stars: number;
};

type CustomerAccumulator = Omit<SyncedCustomer, "_id" | "score" | "stars" | "tier" | "aiSummary" | "recommendedAction">;

const subscriptionStatuses: CustomerScoreInput["subscriptionStatus"][] = [
  "active",
  "inactive",
  "canceled",
  "past_due",
  "unknown",
];

function parseMoney(value: string | undefined) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function getOrderEmail(order: WooCommerceOrder) {
  return order.billing?.email?.trim().toLowerCase() ?? "";
}

function getOrderName(order: WooCommerceOrder) {
  const first = order.billing?.first_name?.trim() ?? "";
  const last = order.billing?.last_name?.trim() ?? "";
  return `${first} ${last}`.trim() || order.billing?.email || "WooCommerce Customer";
}

function getSubscriptionStatus(order: WooCommerceOrder): CustomerScoreInput["subscriptionStatus"] {
  const metaValue = order.meta_data
    ?.find((meta) => meta.key?.toLowerCase().includes("subscription_status"))
    ?.value?.toString()
    .toLowerCase();

  if (metaValue && subscriptionStatuses.includes(metaValue as CustomerScoreInput["subscriptionStatus"])) {
    return metaValue as CustomerScoreInput["subscriptionStatus"];
  }

  return "unknown";
}

function getTier(totalPaid: number) {
  if (totalPaid >= 2500) return "Platinum";
  if (totalPaid >= 999) return "Gold";
  if (totalPaid >= 200) return "Silver";
  return "Bronze";
}

async function transformOrdersToCustomers(orders: WooCommerceOrder[]) {
  const grouped = new Map<string, CustomerAccumulator>();

  orders.forEach((order) => {
    const email = getOrderEmail(order);
    if (!email) return;

    const total = parseMoney(order.total);
    const orderDate = order.date_created ?? new Date().toISOString();
    const existing = grouped.get(email);
    const isLatest = !existing || new Date(orderDate).getTime() >= new Date(existing.lastOrderDate).getTime();
    const subscriptionStatus = getSubscriptionStatus(order);

    grouped.set(email, {
      name: isLatest || !existing ? getOrderName(order) : existing.name,
      email,
      phone: isLatest || !existing ? order.billing?.phone ?? "" : existing.phone,
      totalPaid: (existing?.totalPaid ?? 0) + total,
      orderCount: (existing?.orderCount ?? 0) + 1,
      lastOrderDate: isLatest || !existing ? orderDate : existing.lastOrderDate,
      lastOrderAmount: isLatest || !existing ? total : existing.lastOrderAmount,
      subscriptionStatus: subscriptionStatus !== "unknown" ? subscriptionStatus : existing?.subscriptionStatus ?? "unknown",
      activeSubscriptions:
        subscriptionStatus === "active" ? Math.max(existing?.activeSubscriptions ?? 0, 1) : existing?.activeSubscriptions ?? 0,
      failedPayments: (existing?.failedPayments ?? 0) + (order.status === "failed" ? 1 : 0),
      refunds: (existing?.refunds ?? 0) + (order.refunds?.length ?? (order.status === "refunded" ? 1 : 0)),
      chargebacks: existing?.chargebacks ?? 0,
      creditLimit: Math.max(existing?.creditLimit ?? 0, Math.round(total * 2)),
    });
  });

  return Promise.all(Array.from(grouped.values()).map(async (customer) => {
    const score = calculateCustomerScore(customer);
    const baseCustomer = {
      ...customer,
      _id: `wc-${customer.email}`,
      creditLimit: Math.max(customer.creditLimit, Math.round(customer.totalPaid * 1.5)),
      tier: getTier(customer.totalPaid),
      score,
      stars: scoreToStars(score),
    };
    const aiSummary = await generateCustomerAiSummary(baseCustomer);

    return {
      ...baseCustomer,
      ...aiSummary,
    };
  }));
}

async function saveCustomers(customers: SyncedCustomer[]) {
  await Promise.all(
    customers.map((customer) => {
      const customerUpdate = {
        name: customer.name,
        email: customer.email,
        phone: customer.phone,
        totalPaid: customer.totalPaid,
        orderCount: customer.orderCount,
        lastOrderDate: customer.lastOrderDate,
        lastOrderAmount: customer.lastOrderAmount,
        subscriptionStatus: customer.subscriptionStatus,
        activeSubscriptions: customer.activeSubscriptions,
        failedPayments: customer.failedPayments,
        refunds: customer.refunds,
        chargebacks: customer.chargebacks,
        creditLimit: customer.creditLimit,
        tier: customer.tier,
        aiSummary: customer.aiSummary,
        recommendedAction: customer.recommendedAction,
      };

      return Customer.findOneAndUpdate(
        { email: customer.email },
        { $set: customerUpdate },
        { upsert: true, new: true }
      );
    })
  );
}

export async function POST() {
  if (!isWooCommerceConfigured()) {
    console.warn("[woocommerce] Sync skipped because WooCommerce environment variables are missing.");
    return NextResponse.json({
      message: "WooCommerce is not configured. Add WC_STORE_URL, WC_CONSUMER_KEY, and WC_CONSUMER_SECRET to enable sync.",
      customers: [],
      saved: false,
    });
  }

  await fetchWooCommerceCustomers();
  const orders = await fetchWooCommerceOrders();
  if (!orders) {
    return NextResponse.json({ error: "Unable to fetch WooCommerce orders.", customers: [], saved: false }, { status: 502 });
  }

  const customers = await transformOrdersToCustomers(orders);
  const connection = await connectToDatabase();
  if (!connection) {
    return NextResponse.json({
      message: "WooCommerce data transformed. MongoDB is unavailable, so customers were not saved.",
      customers,
      saved: false,
    });
  }

  await saveCustomers(customers);

  return NextResponse.json({
    message: `Synced ${customers.length} WooCommerce customer${customers.length === 1 ? "" : "s"}.`,
    customers,
    saved: true,
  });
}

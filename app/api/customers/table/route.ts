import { NextResponse } from "next/server";
import { connectToDatabase } from "@/lib/mongodb";
import { Customer, type CustomerDocument } from "@/models/Customer";
import { WooCommerceOrderRecord, type WooCommerceOrderDocument } from "@/models/WooCommerceOrder";

const attemptedStatuses = ["failed", "pending", "pending payment", "on-hold", "checkout-draft", "payment_pending", "crypto_pending"];
type LeanCustomer = CustomerDocument & { _id: unknown };
type HotLeadRow = Record<string, unknown> & {
  name?: string;
  email?: string;
  phone?: string;
  attemptedTotal?: number;
  attemptedOrderCount?: number;
  lastAttemptDate?: string;
  attemptedProducts?: string[];
};

function orderGroupKey(order: WooCommerceOrderDocument) {
  if (order.normalizedEmail) return `email:${order.normalizedEmail}`;
  if (order.normalizedPhone) return `phone:${order.normalizedPhone}`;
  if (order.customerId) return `customer:${order.customerId}`;
  return `order:${order.wooOrderId}`;
}

function customerKey(customer: LeanCustomer) {
  const email = customer.normalizedEmail || customer.email?.trim().toLowerCase();
  if (email) return `email:${email}`;
  return `customer-doc:${String(customer._id)}`;
}

function newerThan(value?: string, compare?: string) {
  const first = value ? new Date(value).getTime() : 0;
  const second = compare ? new Date(compare).getTime() : 0;
  return first > second;
}

function productsAttempted(order: WooCommerceOrderDocument) {
  return Array.from(new Set((order.products ?? order.lineItems ?? []).map((item) => item.name).filter(Boolean)));
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function GET(request: Request) {
  const started = Date.now();
  await connectToDatabase();
  const { searchParams } = new URL(request.url);
  const page = Math.max(1, Number(searchParams.get("page") ?? 1));
  const limit = Math.min(100, Math.max(1, Number(searchParams.get("limit") ?? 20)));
  const q = (searchParams.get("q") ?? "").trim();
  const risk = searchParams.get("risk") ?? "";
  const kind = searchParams.get("kind") ?? "";
  if (kind === "hot-leads") {
    const textMatch = (row: { name?: string; email?: string; phone?: string }) => {
      if (!q) return true;
      const needle = q.toLowerCase();
      return [row.name, row.email, row.phone].some((value) => String(value ?? "").toLowerCase().includes(needle));
    };
    const [attemptedOrders, paidOrders, customers] = await Promise.all([
      WooCommerceOrderRecord.find({ $or: [{ isAttempted: true }, { status: { $in: attemptedStatuses } }] }).sort({ dateCreated: -1 }).lean<WooCommerceOrderDocument[]>(),
      WooCommerceOrderRecord.find({ isPaid: true }).sort({ dateCreated: -1 }).lean<WooCommerceOrderDocument[]>(),
      Customer.find({ $or: [{ attemptedTotal: { $gt: 0 } }, { attemptedOrderCount: { $gt: 0 } }] }).lean<LeanCustomer[]>(),
    ]);
    const latestPaidByKey = new Map<string, string>();
    for (const order of paidOrders) {
      const key = orderGroupKey(order);
      if (!latestPaidByKey.has(key)) latestPaidByKey.set(key, order.dateCreated);
    }
    const customerByKey = new Map(customers.map((customer) => [customerKey(customer), customer]));
    const rowsByKey = new Map<string, HotLeadRow>();
    for (const order of attemptedOrders) {
      const key = orderGroupKey(order);
      const latestPaid = latestPaidByKey.get(key) ?? "";
      if (latestPaid && !newerThan(order.dateCreated, latestPaid)) continue;
      const customer = customerByKey.get(key);
      const existing = rowsByKey.get(key);
      const attemptedTotal = Number(existing?.attemptedTotal ?? customer?.attemptedTotal ?? 0) + Number(order.attemptedAmount ?? order.total ?? 0);
      const attemptedProducts = Array.from(new Set([...(existing?.attemptedProducts as string[] | undefined ?? []), ...productsAttempted(order)]));
      rowsByKey.set(key, {
        _id: customer?._id ?? `woo-order-${order.wooOrderId}`,
        name: customer?.name || order.billingName || order.billingEmail || "WooCommerce Lead",
        email: customer?.email || order.normalizedEmail || order.billingEmail || "",
        phone: customer?.phone || order.billingPhone || "",
        totalPaid: Number(customer?.totalPaid ?? customer?.paidTotal ?? 0),
        paidTotal: Number(customer?.paidTotal ?? customer?.totalPaid ?? 0),
        attemptedTotal,
        paidOrderCount: Number(customer?.paidOrderCount ?? 0),
        attemptedOrderCount: Number(existing?.attemptedOrderCount ?? customer?.attemptedOrderCount ?? 0) + 1,
        paymentStatus: customer?.paymentStatus || order.status || "attempted",
        leadStatus: customer?.leadStatus || "hot_lead",
        lastAttemptDate: String(existing?.lastAttemptDate ?? "") > order.dateCreated ? existing?.lastAttemptDate : order.dateCreated,
        lastPaidDate: customer?.lastPaidDate ?? latestPaid,
        attemptedProducts,
        lastAttemptedProduct: attemptedProducts[0] ?? "",
        tier: customer?.tier ?? "Lead",
        riskLevel: customer?.riskLevel ?? "medium",
        score: customer?.score ?? 0,
        stars: customer?.stars ?? 0,
      });
    }
    for (const customer of customers) {
      const paidTotal = Number(customer.paidTotal ?? customer.totalPaid ?? 0);
      const attemptedTotal = Number(customer.attemptedTotal ?? 0);
      const attemptedCount = Number(customer.attemptedOrderCount ?? 0);
      const latestAttemptAfterPaid = attemptedCount > 0 && newerThan(customer.lastAttemptDate, customer.lastPaidDate);
      const unpaidAttempt = paidTotal <= 0 && (attemptedTotal > 0 || attemptedCount > 0);
      if (!unpaidAttempt && !latestAttemptAfterPaid) continue;
      const key = customerKey(customer);
      if (rowsByKey.has(key)) continue;
      rowsByKey.set(key, { ...customer, _id: customer._id });
    }
    const rows = Array.from(rowsByKey.values())
      .filter((row) => textMatch({ name: String(row.name ?? ""), email: String(row.email ?? ""), phone: String(row.phone ?? "") }))
      .sort((a, b) => Number(b.attemptedTotal ?? 0) - Number(a.attemptedTotal ?? 0) || String(b.lastAttemptDate ?? "").localeCompare(String(a.lastAttemptDate ?? "")));
    const start = (page - 1) * limit;
    const payload = { page, limit, total: rows.length, rows: rows.slice(start, start + limit) };
    console.log(`[api] customers-table durationMs=${Date.now() - started} mongoMs=${Date.now() - started} cache=none responseBytes=${JSON.stringify(payload).length}`);
    return NextResponse.json(payload);
  }
  const and: Record<string, unknown>[] = [
    { $or: [{ name: { $type: "string", $ne: "" } }, { email: { $type: "string", $ne: "" } }] },
  ];
  if (risk) and.push({ riskLevel: risk });
  if (q) {
    const normalizedQuery = q.toLowerCase();
    const looksLikeExactEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedQuery);
    and.push(looksLikeExactEmail
      ? { $or: [{ normalizedEmail: normalizedQuery }, { email: normalizedQuery }, { email: q }] }
      : { $or: [{ name: { $regex: escapeRegex(q), $options: "i" } }, { email: { $regex: escapeRegex(q), $options: "i" } }, { phone: { $regex: escapeRegex(q), $options: "i" } }] });
  }
  const query: Record<string, unknown> = { $and: and };
  const sort: Record<string, 1 | -1> = { paidTotal: -1, attemptedTotal: -1 };
  const [total, rows] = await Promise.all([
    Customer.countDocuments(query),
    Customer.find(query).sort(sort).skip((page - 1) * limit).limit(limit).lean(),
  ]);
  const payload = { page, limit, total, rows };
  console.log(`[api] customers-table durationMs=${Date.now() - started} mongoMs=${Date.now() - started} cache=none responseBytes=${JSON.stringify(payload).length}`);
  return NextResponse.json(payload);
}

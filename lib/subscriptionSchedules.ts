import { readAnalyticsSnapshot } from "@/lib/analyticsCache";
import { resolveBusinessName } from "@/lib/customerBusiness";
import { enrichCustomerProfile } from "@/lib/customerEnrichment";
import { connectToDatabase } from "@/lib/mongodb";
import { monthEnd } from "@/lib/revenueAnalytics";
import { Customer } from "@/models/Customer";
import { CustomerRanking } from "@/models/CustomerRanking";
import { Subscription, type SubscriptionDocument } from "@/models/Subscription";
import { WooCommerceSubscriptionRecord, type WooCommerceSubscriptionDocument } from "@/models/WooCommerceSubscription";
import { AnalyticsSnapshot } from "@/models/AnalyticsSnapshot";
import type { Types } from "mongoose";

type LeanWooSubscription = WooCommerceSubscriptionDocument & { _id: Types.ObjectId | string };
type LeanSubscription = SubscriptionDocument & { _id: Types.ObjectId | string };

type ScheduleResult = {
  nextPaymentDate: string;
  scheduleNeedsReview: boolean;
  scheduleSource: string;
};

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function validDate(value: unknown) {
  const text = clean(value);
  if (!text) return false;
  return !Number.isNaN(new Date(text).getTime());
}

function startOfToday(now = new Date()) {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

export function businessDateKey(value: unknown, timeZone = process.env.BUSINESS_TIME_ZONE || "Asia/Almaty") {
  const date = value instanceof Date ? value : new Date(clean(value));
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function storedDateKey(value: unknown) {
  const text = clean(value);
  const match = text.match(/^(\d{4}-\d{2}-\d{2})/);
  return match?.[1] || businessDateKey(value);
}

function isFutureOrToday(value: unknown, now = new Date()) {
  if (!validDate(value)) return false;
  return storedDateKey(value) >= businessDateKey(now);
}

function toIso(value: Date) {
  return value.toISOString();
}

function intervalParts(interval?: unknown, period?: unknown) {
  const amount = Math.max(1, Number(interval || 1) || 1);
  const rawPeriod = clean(period || "month").toLowerCase();
  const normalized = rawPeriod.includes("year") ? "year" : rawPeriod.includes("week") ? "week" : rawPeriod.includes("day") ? "day" : "month";
  return { amount, period: normalized };
}

function addInterval(date: Date, interval?: unknown, period?: unknown) {
  const next = new Date(date.getTime());
  const parts = intervalParts(interval, period);
  if (parts.period === "year") next.setFullYear(next.getFullYear() + parts.amount);
  else if (parts.period === "week") next.setDate(next.getDate() + parts.amount * 7);
  else if (parts.period === "day") next.setDate(next.getDate() + parts.amount);
  else next.setMonth(next.getMonth() + parts.amount);
  return next;
}

function computeFutureByInterval(anchor: unknown, interval?: unknown, period?: unknown, now = new Date()) {
  if (!validDate(anchor)) return "";
  let next = new Date(clean(anchor));
  const floor = startOfToday(now).getTime();
  let guard = 0;
  while (next.getTime() < floor && guard < 240) {
    next = addInterval(next, interval, period);
    guard += 1;
  }
  while (storedDateKey(toIso(next)) < businessDateKey(now) && guard < 250) {
    next.setDate(next.getDate() + 1);
    guard += 1;
  }
  return next.getTime() >= floor && storedDateKey(toIso(next)) >= businessDateKey(now) ? toIso(next) : "";
}

export function repairWooSchedule(record: Pick<WooCommerceSubscriptionDocument, "status" | "nextPaymentDate" | "lastPaymentDate" | "startDate" | "billingInterval" | "billingPeriod">, now = new Date()): ScheduleResult {
  if (record.status !== "active") return { nextPaymentDate: "", scheduleNeedsReview: false, scheduleSource: "inactive" };
  if (isFutureOrToday(record.nextPaymentDate, now)) {
    return { nextPaymentDate: clean(record.nextPaymentDate), scheduleNeedsReview: false, scheduleSource: "woocommerce_next_payment_date" };
  }
  const fromLast = computeFutureByInterval(record.lastPaymentDate, record.billingInterval || 1, record.billingPeriod || "month", now);
  if (fromLast) return { nextPaymentDate: fromLast, scheduleNeedsReview: false, scheduleSource: "lastPaymentDate+interval" };
  const fromStart = computeFutureByInterval(record.startDate, record.billingInterval || 1, record.billingPeriod || "month", now);
  if (fromStart) return { nextPaymentDate: fromStart, scheduleNeedsReview: false, scheduleSource: "startDate+interval" };
  return { nextPaymentDate: "", scheduleNeedsReview: true, scheduleSource: "unable_to_compute" };
}

export function repairGatewaySchedule(record: Pick<SubscriptionDocument, "status" | "nextBillingDate" | "lastBillingDate" | "billingInterval" | "lastSyncedAt">, now = new Date()): ScheduleResult {
  if (record.status !== "active") return { nextPaymentDate: "", scheduleNeedsReview: false, scheduleSource: "inactive" };
  if (isFutureOrToday(record.nextBillingDate, now)) {
    return { nextPaymentDate: clean(record.nextBillingDate), scheduleNeedsReview: false, scheduleSource: "gateway_next_billing_date" };
  }
  const fromLast = computeFutureByInterval(record.lastBillingDate, 1, record.billingInterval || "month", now);
  if (fromLast) return { nextPaymentDate: fromLast, scheduleNeedsReview: false, scheduleSource: "lastBillingDate+interval" };
  const fromSync = computeFutureByInterval(record.lastSyncedAt, 1, record.billingInterval || "month", now);
  if (fromSync) return { nextPaymentDate: fromSync, scheduleNeedsReview: true, scheduleSource: "lastSyncedAt+interval" };
  return { nextPaymentDate: "", scheduleNeedsReview: true, scheduleSource: "unable_to_compute" };
}

export function validUpcomingDate(value: unknown, from = startOfToday(), to?: Date) {
  if (!validDate(value)) return false;
  const key = storedDateKey(value);
  const fromKey = businessDateKey(from);
  const toKey = to ? businessDateKey(to) : "";
  return key >= fromKey && (!toKey || key <= toKey);
}

export async function buildUpcomingBillsSnapshot(now = new Date()) {
  const start = startOfToday(now);
  const end = monthEnd(now);
  const [wooRows, authRows] = await Promise.all([
    WooCommerceSubscriptionRecord.find({ status: "active", nextPaymentDate: { $ne: "" }, scheduleNeedsReview: { $ne: true } }).sort({ nextPaymentDate: 1 }).limit(500).lean<LeanWooSubscription[]>(),
    Subscription.find({ source: "authorize_net", status: "active", recordType: "subscription", sourceStatus: "real", nextBillingDate: { $ne: "" }, scheduleNeedsReview: { $ne: true } }).sort({ nextBillingDate: 1 }).limit(250).lean<LeanSubscription[]>(),
  ]);
  const rows = [
    ...wooRows.filter((row) => validUpcomingDate(row.nextPaymentDate, start, end)).map((row) => ({
      _id: String(row._id),
      subscriptionId: String(row.wooSubscriptionId),
      subscriptionNumber: row.subscriptionNumber,
      source: "woocommerce",
      customerEmail: row.customerEmail,
      customerName: row.customerName,
      customerPhone: row.customerPhone,
      businessName: "",
      status: row.status,
      amount: Number(row.recurringTotal ?? row.amount ?? 0),
      monthlyRecurringRevenue: Number(row.recurringTotal ?? row.amount ?? 0),
      billingInterval: [row.billingInterval, row.billingPeriod].filter(Boolean).join(" "),
      nextBillingDate: row.nextPaymentDate,
      lastBillingDate: row.lastPaymentDate,
      startDate: row.startDate,
      paymentMethodTitle: row.paymentMethodTitle || row.paymentMethod,
      productNames: row.productNames,
      sourceStatus: "real",
      recordType: "subscription",
      scheduleNeedsReview: false,
      churnRisk: "low",
      action: "Review subscription renewal",
    })),
    ...authRows.filter((row) => validUpcomingDate(row.nextBillingDate, start, end)).map((row) => ({
      _id: String(row._id),
      subscriptionId: row.subscriptionId,
      subscriptionNumber: row.subscriptionId,
      source: "authorize_net",
      customerEmail: row.customerEmail,
      customerName: row.customerName,
      customerPhone: row.customerPhone,
      businessName: "",
      status: row.status,
      amount: Number(row.monthlyRecurringRevenue || row.amount || 0),
      monthlyRecurringRevenue: Number(row.monthlyRecurringRevenue || row.amount || 0),
      billingInterval: row.billingInterval || "monthly",
      nextBillingDate: row.nextBillingDate,
      lastBillingDate: row.lastBillingDate,
      startDate: row.lastSyncedAt,
      paymentMethodTitle: "Authorize.net ARB",
      productNames: ["Authorize.net ARB Subscription"],
      sourceStatus: row.sourceStatus,
      recordType: row.recordType,
      scheduleNeedsReview: false,
      churnRisk: "low",
      action: "Review Authorize.net ARB subscription",
    })),
  ].sort((a, b) => String(a.nextBillingDate ?? "").localeCompare(String(b.nextBillingDate ?? "")));
  const todayKey = now.toISOString().slice(0, 10);
  const next7 = new Date(startOfToday(now).getTime() + 7 * 86400000);
  return {
    upcomingRows: rows,
    totalUpcomingThisMonth: rows.length,
    totalUpcomingAmountThisMonth: rows.reduce((sum, row) => sum + Number(row.amount ?? 0), 0),
    upcomingRevenueThisMonth: rows.reduce((sum, row) => sum + Number(row.amount ?? 0), 0),
    upcomingCustomerCountThisMonth: rows.length,
    upcomingToday: rows.filter((row) => String(row.nextBillingDate ?? "").slice(0, 10) === todayKey).length,
    upcomingNext7Days: rows.filter((row) => validUpcomingDate(String(row.nextBillingDate ?? ""), startOfToday(now), next7)).length,
  };
}

export async function refreshUpcomingBillsSnapshot() {
  const upcoming = await buildUpcomingBillsSnapshot();
  const current = await readAnalyticsSnapshot<Record<string, unknown>>("dashboard_analytics", {});
  await AnalyticsSnapshot.updateOne(
    { key: "dashboard_analytics" },
    {
      $set: {
        payload: { ...current, ...upcoming },
        generatedAt: new Date().toISOString(),
        status: "ready",
      },
    },
    { upsert: true }
  );
  return upcoming;
}

export async function repairSubscriptionSchedules({ dryRun = true, limit = 500, cursor = null }: { dryRun?: boolean; limit?: number; cursor?: string | null }) {
  await connectToDatabase();
  const safeLimit = Math.min(1000, Math.max(1, Number(limit || 500)));
  const query = cursor ? { _id: { $gt: cursor } } : {};
  const [wooRows, authRows] = await Promise.all([
    WooCommerceSubscriptionRecord.find(query).sort({ _id: 1 }).limit(safeLimit).lean<LeanWooSubscription[]>(),
    Subscription.find({ ...query, source: "authorize_net", recordType: "subscription", sourceStatus: "real" }).sort({ _id: 1 }).limit(safeLimit).lean<LeanSubscription[]>(),
  ]);
  const rows = [
    ...wooRows.map((row) => ({ kind: "woocommerce" as const, row })),
    ...authRows.map((row) => ({ kind: "authorize_net" as const, row })),
  ].sort((a, b) => String(a.row._id).localeCompare(String(b.row._id))).slice(0, safeLimit);
  const nextCursor = rows.length ? String(rows[rows.length - 1].row._id) : cursor;
  const hasMore = rows.length === safeLimit;
  let staleNextPayment = 0;
  let recomputedFromWoo = 0;
  let recomputedFromAuthorizeNet = 0;
  let recomputedFromInterval = 0;
  let unableToCompute = 0;
  const sampleFixed: Array<Record<string, unknown>> = [];
  const wooWrites: Parameters<typeof WooCommerceSubscriptionRecord.bulkWrite>[0] = [];
  const authWrites: Parameters<typeof Subscription.bulkWrite>[0] = [];
  const customerWrites: Parameters<typeof Customer.bulkWrite>[0] = [];
  const rankingWrites: Parameters<typeof CustomerRanking.bulkWrite>[0] = [];
  for (const item of rows) {
    if (item.kind === "woocommerce") {
      const row = item.row;
      const before = clean(row.nextPaymentDate);
      const result = repairWooSchedule(row);
      const stale = row.status === "active" && !isFutureOrToday(before);
      if (stale) staleNextPayment += 1;
      if (result.scheduleSource === "woocommerce_next_payment_date") recomputedFromWoo += stale ? 1 : 0;
      if (result.scheduleSource.endsWith("+interval")) recomputedFromInterval += stale ? 1 : 0;
      if (result.scheduleNeedsReview) unableToCompute += 1;
      const changed = before !== result.nextPaymentDate || Boolean(row.scheduleNeedsReview) !== result.scheduleNeedsReview || clean(row.scheduleSource) !== result.scheduleSource;
      if (changed) {
        const set = { nextPaymentDate: result.nextPaymentDate, scheduleNeedsReview: result.scheduleNeedsReview, scheduleSource: result.scheduleSource };
        wooWrites.push({ updateOne: { filter: { _id: row._id }, update: { $set: set } } });
        const email = clean(row.normalizedEmail || row.customerEmail).toLowerCase();
        if (email) {
          customerWrites.push({ updateOne: { filter: { normalizedEmail: email }, update: { $set: { recurringNextEstimatedPayment: result.nextPaymentDate, recurringLastPayment: row.lastPaymentDate, "sourceCoverage.lastSubscriptionSyncAt": new Date().toISOString() } } } });
          rankingWrites.push({ updateOne: { filter: { email: row.customerEmail }, update: { $set: { subscriptionNextPaymentDate: result.nextPaymentDate, subscriptionLastPaymentDate: row.lastPaymentDate, scheduleNeedsReview: result.scheduleNeedsReview } } } });
        }
        if (sampleFixed.length < 10) sampleFixed.push({ source: "woocommerce", subscriptionId: row.wooSubscriptionId, customerEmail: row.customerEmail, before, after: result.nextPaymentDate || "-", scheduleSource: result.scheduleSource, scheduleNeedsReview: result.scheduleNeedsReview });
      }
    } else {
      const row = item.row;
      const before = clean(row.nextBillingDate);
      const result = repairGatewaySchedule(row);
      const stale = row.status === "active" && !isFutureOrToday(before);
      if (stale) staleNextPayment += 1;
      if (result.scheduleSource === "gateway_next_billing_date") recomputedFromAuthorizeNet += stale ? 1 : 0;
      if (result.scheduleSource.endsWith("+interval")) recomputedFromInterval += stale ? 1 : 0;
      if (result.scheduleNeedsReview) unableToCompute += 1;
      const changed = before !== result.nextPaymentDate || Boolean(row.scheduleNeedsReview) !== result.scheduleNeedsReview || clean(row.scheduleSource) !== result.scheduleSource;
      if (changed) {
        const set = { nextBillingDate: result.nextPaymentDate, scheduleNeedsReview: result.scheduleNeedsReview, scheduleSource: result.scheduleSource };
        authWrites.push({ updateOne: { filter: { _id: row._id }, update: { $set: set } } });
        const email = clean(row.customerEmail).toLowerCase();
        if (email && !email.endsWith("@authorize.local")) {
          customerWrites.push({ updateOne: { filter: { normalizedEmail: email }, update: { $set: { recurringNextEstimatedPayment: result.nextPaymentDate, recurringLastPayment: row.lastBillingDate, "sourceCoverage.lastSubscriptionSyncAt": new Date().toISOString() } } } });
          rankingWrites.push({ updateOne: { filter: { email: row.customerEmail }, update: { $set: { subscriptionNextPaymentDate: result.nextPaymentDate, subscriptionLastPaymentDate: row.lastBillingDate, scheduleNeedsReview: result.scheduleNeedsReview } } } });
        }
        if (sampleFixed.length < 10) sampleFixed.push({ source: "authorize_net", subscriptionId: row.subscriptionId, customerEmail: row.customerEmail, before, after: result.nextPaymentDate || "-", scheduleSource: result.scheduleSource, scheduleNeedsReview: result.scheduleNeedsReview });
      }
    }
  }
  if (!dryRun) {
    if (wooWrites.length) await WooCommerceSubscriptionRecord.bulkWrite(wooWrites, { ordered: false });
    if (authWrites.length) await Subscription.bulkWrite(authWrites, { ordered: false });
    if (customerWrites.length) await Customer.bulkWrite(customerWrites, { ordered: false });
    if (rankingWrites.length) await CustomerRanking.bulkWrite(rankingWrites, { ordered: false });
    await refreshUpcomingBillsSnapshot();
  }
  return {
    dryRun,
    checked: rows.length,
    staleNextPayment,
    recomputedFromWoo,
    recomputedFromAuthorizeNet,
    recomputedFromInterval,
    unableToCompute,
    sampleFixed,
    cursor: nextCursor,
    hasMore,
  };
}

export async function enrichUpcomingRows(rows: Array<Record<string, unknown>>) {
  const rowEmails = rows.map((row) => clean(row.customerEmail).toLowerCase()).filter(Boolean);
  const customers = rowEmails.length ? await Customer.find({ normalizedEmail: { $in: rowEmails } }, { normalizedEmail: 1, email: 1, businessProfile: 1, orders: 1, factiivProfile: 1, publicEnrichment: 1 }).lean() : [];
  const customerByEmail = new Map(customers.map((customer) => [clean(customer.normalizedEmail || customer.email).toLowerCase(), customer]));
  return rows.map((row) => {
    const email = clean(row.customerEmail).toLowerCase();
    const customer = customerByEmail.get(email);
    const enrichment = enrichCustomerProfile(customer);
    return {
      ...row,
      businessName: row.businessName || resolveBusinessName(customer).businessName,
      stateCode: enrichment.stateCode,
      stateName: enrichment.stateName,
      stateSource: enrichment.stateSource,
    };
  });
}

import { NextResponse } from "next/server";
import { cachedJson } from "@/lib/apiCache";
import { buildStateOptions } from "@/lib/customerBusinessResolver";
import { readAnalyticsSnapshot } from "@/lib/analyticsCache";
import { readSubscriptionDashboardMetrics } from "@/lib/subscriptionSync";
import { enrichCustomerProfile } from "@/lib/customerEnrichment";
import { normalizedStateParam } from "@/lib/customerTableQuery";
import { resolveBusinessName } from "@/lib/customerBusiness";
import { connectToDatabase } from "@/lib/mongodb";
import { repairGatewaySchedule, repairWooSchedule } from "@/lib/subscriptionSchedules";
import { Customer, type CustomerDocument } from "@/models/Customer";
import { Subscription, type SubscriptionDocument } from "@/models/Subscription";
import { WooCommerceSubscriptionRecord, type WooCommerceSubscriptionDocument } from "@/models/WooCommerceSubscription";

type LeanWooSubscription = WooCommerceSubscriptionDocument & { _id: unknown };
type LeanCustomer = CustomerDocument & { _id: unknown };
type LeanSubscription = SubscriptionDocument & { _id: unknown };

function activeWooQuery(search: string) {
  const query: Record<string, unknown> = { status: "active" };
  if (search) query.$or = [{ customerName: { $regex: search, $options: "i" } }, { customerEmail: { $regex: search, $options: "i" } }, { subscriptionNumber: { $regex: search, $options: "i" } }];
  return query;
}

function authorizeNetSubscriptionRow(record: LeanSubscription, customer?: LeanCustomer) {
  const businessInfo = resolveBusinessName(customer);
  const enrichment = enrichCustomerProfile(customer);
  const schedule = repairGatewaySchedule(record);
  return {
    _id: String(record._id),
    subscriptionId: record.subscriptionId,
    subscriptionNumber: record.subscriptionId,
    source: "authorize_net",
    customerEmail: record.customerEmail,
    customerName: record.customerName,
    businessName: businessInfo.businessName,
    stateCode: enrichment.stateCode,
    stateName: enrichment.stateName,
    stateSource: enrichment.stateSource,
    customerPhone: record.customerPhone,
    status: record.status,
    amount: Number(record.amount ?? 0),
    monthlyRecurringRevenue: record.status === "active" ? Number(record.monthlyRecurringRevenue || record.amount || 0) : 0,
    billingInterval: record.billingInterval || "monthly",
    nextBillingDate: schedule.nextPaymentDate,
    lastBillingDate: record.lastBillingDate,
    startDate: record.lastSyncedAt,
    paymentMethodTitle: "Authorize.net ARB",
    productNames: ["Authorize.net ARB Subscription"],
    sourceStatus: record.sourceStatus,
    recordType: record.recordType,
    scheduleNeedsReview: schedule.scheduleNeedsReview,
    scheduleSource: schedule.scheduleSource,
    churnRisk: customer?.riskLevel ?? "low",
    action: "Review Authorize.net ARB subscription",
  };
}

function wooSubscriptionRow(record: LeanWooSubscription, customer?: LeanCustomer) {
  const businessInfo = resolveBusinessName(customer);
  const enrichment = enrichCustomerProfile(customer);
  const schedule = repairWooSchedule(record);
  return {
    customerProfile: customer,
    _id: String(record._id),
    subscriptionId: String(record.wooSubscriptionId),
    subscriptionNumber: record.subscriptionNumber,
    source: "woocommerce",
    customerEmail: record.customerEmail,
    customerName: record.customerName,
    businessName: businessInfo.businessName,
    stateCode: enrichment.stateCode,
    stateName: enrichment.stateName,
    stateSource: enrichment.stateSource,
    customerPhone: record.customerPhone,
    status: record.status,
    amount: record.recurringTotal || record.amount,
    monthlyRecurringRevenue: record.status === "active" ? (record.recurringTotal || record.amount) : 0,
    billingInterval: [record.billingInterval, record.billingPeriod].filter(Boolean).join(" "),
    nextBillingDate: schedule.nextPaymentDate,
    lastBillingDate: record.lastPaymentDate,
    startDate: record.startDate,
    paymentMethodTitle: record.paymentMethodTitle || record.paymentMethod,
    productNames: record.productNames,
    sourceStatus: "real",
    recordType: "subscription",
    scheduleNeedsReview: schedule.scheduleNeedsReview,
    scheduleSource: schedule.scheduleSource,
  };
}

function candidateRow(customer: LeanCustomer) {
  const businessInfo = resolveBusinessName(customer);
  const enrichment = enrichCustomerProfile(customer);
  return {
    _id: String(customer._id),
    subscriptionId: `candidate-${String(customer._id)}`,
    source: "candidate",
    customerEmail: customer.email,
    customerName: customer.name,
    businessName: businessInfo.businessName,
    stateCode: enrichment.stateCode,
    stateName: enrichment.stateName,
    stateSource: enrichment.stateSource,
    customerPhone: customer.phone,
    status: "candidate",
    amount: Number(customer.averageOrderValue ?? 0),
    monthlyRecurringRevenue: 0,
    billingInterval: "review",
    nextBillingDate: "",
    lastBillingDate: customer.lastPaidDate,
    startDate: customer.firstPaidDate || customer.firstOrderDate,
    paymentMethodTitle: customer.lastPaymentMethod,
    productNames: customer.paidProducts?.length ? customer.paidProducts : ["Recurring-like customer"],
    sourceStatus: "candidate",
    recordType: "subscription_candidate",
    churnRisk: customer.riskLevel ?? "low",
    action: "Review recurring eligibility",
  };
}

export async function GET(request: Request) {
  await connectToDatabase();
  const { searchParams } = new URL(request.url);
  const page = Math.max(1, Number(searchParams.get("page") ?? 1));
  const limit = Math.min(100, Math.max(1, Number(searchParams.get("limit") ?? 20)));
  const source = searchParams.get("source") ?? "";
  const status = searchParams.get("status") ?? "";
  const kind = searchParams.get("kind") ?? "real";
  const search = (searchParams.get("q") ?? "").trim();
  const dashboard = searchParams.get("dashboard") === "1";
  const state = normalizedStateParam(searchParams.get("state"));
  if (dashboard) {
    return cachedJson(`subscriptions-dashboard:${page}:${limit}:${search}:${state || "all"}`, async () => {
      const [metrics, snapshot, records, authorizeNetRecords, candidateRows] = await Promise.all([
        readSubscriptionDashboardMetrics(),
        readAnalyticsSnapshot<Record<string, unknown>>("dashboard_analytics", {}),
        WooCommerceSubscriptionRecord.find(activeWooQuery(search)).sort({ nextPaymentDate: 1 }).skip((page - 1) * limit).limit(limit).lean<LeanWooSubscription[]>(),
        Subscription.find({ source: "authorize_net", status: "active", recordType: "subscription", sourceStatus: "real" }).sort({ nextBillingDate: 1 }).limit(limit).lean<LeanSubscription[]>(),
        Customer.find({ isGatewayRecurring: { $ne: true }, activeSubscriptions: { $lte: 0 }, paidOrderCount: { $gte: 2 }, paidTotal: { $gt: 0 } }, { name: 1, email: 1, phone: 1, averageOrderValue: 1, lastPaidDate: 1, firstPaidDate: 1, firstOrderDate: 1, lastPaymentMethod: 1, paidProducts: 1, riskLevel: 1, businessProfile: 1, orders: 1 }).sort({ paidTotal: -1 }).limit(limit).lean<LeanCustomer[]>(),
      ]);
      const rowEmails = [...records.map((record) => record.customerEmail), ...authorizeNetRecords.map((record) => record.customerEmail)].map((email) => email?.trim().toLowerCase()).filter(Boolean);
      const customerByEmail = new Map((await Customer.find({ normalizedEmail: { $in: rowEmails } }, { normalizedEmail: 1, email: 1, businessProfile: 1, orders: 1, factiivProfile: 1, publicEnrichment: 1, riskLevel: 1 }).lean<LeanCustomer[]>()).map((customer) => [(customer.normalizedEmail || customer.email || "").toLowerCase(), customer]));
      const rows = records.map((record) => wooSubscriptionRow(record, customerByEmail.get(record.customerEmail?.trim().toLowerCase() || "")));
      const authorizeNetRows = authorizeNetRecords.map((record) => authorizeNetSubscriptionRow(record, customerByEmail.get(record.customerEmail?.trim().toLowerCase() || "")));
      const allRows = [...rows, ...authorizeNetRows];
      const filteredRows = state ? allRows.filter((row) => row.stateCode === state) : allRows;
      return {
        page,
        limit,
        total: state ? filteredRows.length : metrics.totalSubscriptions,
        rows: filteredRows.slice(0, limit),
        candidateRows: candidateRows.map(candidateRow),
        state,
        stateOptions: buildStateOptions(allRows),
        summary: {
          totalSubscriptions: Number(snapshot.totalSubscriptions ?? metrics.totalSubscriptions),
          activeWooSubscriptions: Number(snapshot.activeWooSubscriptions ?? metrics.activeWooSubscriptions),
          activeAuthorizeNetSubscriptions: Number(snapshot.activeAuthorizeNetSubscriptions ?? metrics.activeAuthorizeNetSubscriptions),
          activeGatewayRecurringCustomers: Number(snapshot.activeGatewayRecurringCustomers ?? metrics.activeAuthorizeNetSubscriptions),
          totalActiveRecurringCustomers: Number(snapshot.totalActiveRecurringCustomers ?? metrics.activeSubscriptions),
          activeSubscriptions: Number(snapshot.totalActiveRecurringCustomers ?? metrics.activeSubscriptions),
          wooTotalSubscriptions: Number(snapshot.wooTotalSubscriptions ?? metrics.wooTotalSubscriptions),
          authorizeNetTotalSubscriptions: Number(snapshot.authorizeNetTotalSubscriptions ?? metrics.authorizeNetTotalSubscriptions),
          activeWooSubscriptionsDbCount: metrics.activeWooSubscriptions,
          activeWooSubscriptionsDisplayed: rows.length,
          monthlyRecurringRevenue: Number(snapshot.totalMonthlyRecurringRevenue ?? snapshot.activeMRR ?? metrics.monthlyRecurringRevenue),
          totalMonthlyRecurringRevenue: Number(snapshot.totalMonthlyRecurringRevenue ?? snapshot.activeMRR ?? metrics.monthlyRecurringRevenue),
          subscriptionCandidates: candidateRows.length,
          subscriptionSourceBreakdown: metrics,
          subscriptionNote: metrics.sourceNotes,
          analyticsCacheReady: Boolean(snapshot.analyticsCacheReady),
        },
      };
    });
  }
  const q: Record<string, unknown> = {};
  if (kind === "real") {
    if (source && source !== "woocommerce") return NextResponse.json({ page, limit, total: 0, rows: [] });
    if (status) q.status = status;
    const wooQuery: Record<string, unknown> = {};
    if (status) wooQuery.status = status;
    if (search) wooQuery.$or = [{ customerName: { $regex: search, $options: "i" } }, { customerEmail: { $regex: search, $options: "i" } }, { subscriptionNumber: { $regex: search, $options: "i" } }];
    const [total, records] = await Promise.all([
      WooCommerceSubscriptionRecord.countDocuments(wooQuery),
      WooCommerceSubscriptionRecord.find(wooQuery).sort({ nextPaymentDate: 1 }).skip((page - 1) * limit).limit(limit).lean<LeanWooSubscription[]>(),
    ]);
    const customerByEmail = new Map((await Customer.find({ normalizedEmail: { $in: records.map((record) => record.customerEmail?.trim().toLowerCase()).filter(Boolean) } }, { normalizedEmail: 1, email: 1, businessProfile: 1, orders: 1, factiivProfile: 1, publicEnrichment: 1 }).lean<LeanCustomer[]>()).map((customer) => [(customer.normalizedEmail || customer.email || "").toLowerCase(), customer]));
    const rows = records.map((record) => wooSubscriptionRow(record, customerByEmail.get(record.customerEmail?.trim().toLowerCase() || "")));
    const filteredRows = state ? rows.filter((row) => row.stateCode === state) : rows;
    return NextResponse.json({ page, limit, total: state ? filteredRows.length : total, rows: filteredRows, state, stateOptions: buildStateOptions(rows) });
  } else if (kind === "candidates") {
    const candidateCustomers = await Customer.find({ isGatewayRecurring: { $ne: true }, activeSubscriptions: { $lte: 0 }, paidOrderCount: { $gte: 2 }, paidTotal: { $gt: 0 } }, { name: 1, email: 1, phone: 1, averageOrderValue: 1, lastPaidDate: 1, firstPaidDate: 1, firstOrderDate: 1, lastPaymentMethod: 1, paidProducts: 1, riskLevel: 1, businessProfile: 1, orders: 1 }).sort({ paidTotal: -1 }).skip((page - 1) * limit).limit(limit).lean<LeanCustomer[]>();
    return NextResponse.json({ page, limit, total: candidateCustomers.length, rows: candidateCustomers.map(candidateRow) });
  } else if (kind === "all-real-data") {
    const wooQuery: Record<string, unknown> = {};
    if (search) wooQuery.$or = [{ customerName: { $regex: search, $options: "i" } }, { customerEmail: { $regex: search, $options: "i" } }, { subscriptionNumber: { $regex: search, $options: "i" } }];
    const [total, records] = await Promise.all([
      WooCommerceSubscriptionRecord.countDocuments(wooQuery),
      WooCommerceSubscriptionRecord.find(wooQuery).sort({ status: 1, nextPaymentDate: 1 }).skip((page - 1) * limit).limit(limit).lean<LeanWooSubscription[]>(),
    ]);
    const customerByEmail = new Map((await Customer.find({ normalizedEmail: { $in: records.map((record) => record.customerEmail?.trim().toLowerCase()).filter(Boolean) } }, { normalizedEmail: 1, email: 1, businessProfile: 1, orders: 1 }).lean<LeanCustomer[]>()).map((customer) => [(customer.normalizedEmail || customer.email || "").toLowerCase(), customer]));
    const rows = records.map((record) => wooSubscriptionRow(record, customerByEmail.get(record.customerEmail?.trim().toLowerCase() || "")));
    return NextResponse.json({ page, limit, total, rows });
  }
  if (source) q.source = source;
  if (status) q.status = status;
  if (search) q.$or = [{ customerName: { $regex: search, $options: "i" } }, { customerEmail: { $regex: search, $options: "i" } }, { subscriptionId: { $regex: search, $options: "i" } }];
  const [total, rows] = await Promise.all([
    Subscription.countDocuments(q),
    Subscription.find(q).sort({ nextBillingDate: 1 }).skip((page - 1) * limit).limit(limit).lean(),
  ]);
  return NextResponse.json({ page, limit, total, rows });
}

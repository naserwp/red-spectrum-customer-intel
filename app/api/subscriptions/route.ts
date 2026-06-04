import { NextResponse } from "next/server";
import { cachedJson } from "@/lib/apiCache";
import { buildStateOptions } from "@/lib/customerBusinessResolver";
import { readAnalyticsSnapshot } from "@/lib/analyticsCache";
import { enrichCustomerProfile } from "@/lib/customerEnrichment";
import { normalizedStateParam } from "@/lib/customerTableQuery";
import { resolveBusinessName } from "@/lib/customerBusiness";
import { connectToDatabase } from "@/lib/mongodb";
import { Customer, type CustomerDocument } from "@/models/Customer";
import { Subscription } from "@/models/Subscription";
import { WooCommerceSubscriptionRecord, type WooCommerceSubscriptionDocument } from "@/models/WooCommerceSubscription";

type LeanWooSubscription = WooCommerceSubscriptionDocument & { _id: unknown };
type LeanCustomer = CustomerDocument & { _id: unknown };

function activeWooQuery(search: string) {
  const query: Record<string, unknown> = { status: "active" };
  if (search) query.$or = [{ customerName: { $regex: search, $options: "i" } }, { customerEmail: { $regex: search, $options: "i" } }, { subscriptionNumber: { $regex: search, $options: "i" } }];
  return query;
}

function gatewaySubscriptionRow(customer: LeanCustomer) {
  const businessInfo = resolveBusinessName(customer);
  const enrichment = enrichCustomerProfile(customer);
  return {
    _id: String(customer._id),
    subscriptionId: `authorize-net-${String(customer._id)}`,
    subscriptionNumber: "",
    source: "authorize_net",
    customerEmail: customer.email,
    customerName: customer.name,
    businessName: businessInfo.businessName,
    stateCode: enrichment.stateCode,
    stateName: enrichment.stateName,
    stateSource: enrichment.stateSource,
    customerPhone: customer.phone,
    status: "active",
    amount: Number(customer.recurringAmount ?? 0),
    monthlyRecurringRevenue: Number(customer.recurringAmount ?? 0),
    billingInterval: customer.recurringFrequencyEstimate || "monthly",
    nextBillingDate: customer.recurringNextEstimatedPayment,
    lastBillingDate: customer.recurringLastPayment,
    startDate: customer.firstPaidDate || customer.firstOrderDate,
    paymentMethodTitle: "Credit Card Payment",
    productNames: ["Authorize.net Recurring Payment"],
    sourceStatus: "gateway_recurring",
    recordType: "subscription",
    churnRisk: customer.riskLevel ?? "low",
    action: "Review Authorize.net recurring payment",
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
      const [total, activeWooSubscriptions, activeWooMrr, snapshot, records, gatewayRecurring, candidateRows] = await Promise.all([
        WooCommerceSubscriptionRecord.countDocuments({}),
        WooCommerceSubscriptionRecord.countDocuments({ status: "active" }),
        WooCommerceSubscriptionRecord.aggregate<{ _id: null; mrr: number }>([
          { $match: { status: "active" } },
          { $group: { _id: null, mrr: { $sum: { $ifNull: ["$recurringTotal", "$amount"] } } } },
        ]),
        readAnalyticsSnapshot<Record<string, unknown>>("dashboard_analytics", {}),
        WooCommerceSubscriptionRecord.find(activeWooQuery(search)).sort({ nextPaymentDate: 1 }).skip((page - 1) * limit).limit(limit).lean<LeanWooSubscription[]>(),
        Customer.find({ isGatewayRecurring: true }, { name: 1, email: 1, phone: 1, recurringAmount: 1, recurringFrequencyEstimate: 1, recurringNextEstimatedPayment: 1, recurringLastPayment: 1, firstPaidDate: 1, firstOrderDate: 1, riskLevel: 1, businessProfile: 1, orders: 1 }).sort({ recurringNextEstimatedPayment: 1 }).limit(limit).lean<LeanCustomer[]>(),
        Customer.find({ isGatewayRecurring: { $ne: true }, activeSubscriptions: { $lte: 0 }, paidOrderCount: { $gte: 2 }, paidTotal: { $gt: 0 } }, { name: 1, email: 1, phone: 1, averageOrderValue: 1, lastPaidDate: 1, firstPaidDate: 1, firstOrderDate: 1, lastPaymentMethod: 1, paidProducts: 1, riskLevel: 1, businessProfile: 1, orders: 1 }).sort({ paidTotal: -1 }).limit(limit).lean<LeanCustomer[]>(),
      ]);
      const customerByEmail = new Map((await Customer.find({ normalizedEmail: { $in: records.map((record) => record.customerEmail?.trim().toLowerCase()).filter(Boolean) } }, { normalizedEmail: 1, email: 1, businessProfile: 1, orders: 1, factiivProfile: 1, publicEnrichment: 1 }).lean<LeanCustomer[]>()).map((customer) => [(customer.normalizedEmail || customer.email || "").toLowerCase(), customer]));
      const rows = records.map((record) => ({
        customerProfile: customerByEmail.get(record.customerEmail?.trim().toLowerCase() || ""),
        _id: String(record._id),
        subscriptionId: String(record.wooSubscriptionId),
        subscriptionNumber: record.subscriptionNumber,
        source: "woocommerce",
        customerEmail: record.customerEmail,
        customerName: record.customerName,
        businessName: resolveBusinessName(customerByEmail.get(record.customerEmail?.trim().toLowerCase() || "")).businessName,
        stateCode: enrichCustomerProfile(customerByEmail.get(record.customerEmail?.trim().toLowerCase() || "")).stateCode,
        stateName: enrichCustomerProfile(customerByEmail.get(record.customerEmail?.trim().toLowerCase() || "")).stateName,
        stateSource: enrichCustomerProfile(customerByEmail.get(record.customerEmail?.trim().toLowerCase() || "")).stateSource,
        customerPhone: record.customerPhone,
        status: record.status,
        amount: record.recurringTotal || record.amount,
        monthlyRecurringRevenue: record.status === "active" ? (record.recurringTotal || record.amount) : 0,
        billingInterval: [record.billingInterval, record.billingPeriod].filter(Boolean).join(" "),
        nextBillingDate: record.nextPaymentDate,
        lastBillingDate: record.lastPaymentDate,
        startDate: record.startDate,
        paymentMethodTitle: record.paymentMethodTitle || record.paymentMethod,
        productNames: record.productNames,
        sourceStatus: "real",
        recordType: "subscription",
      }));
      const allRows = [...rows, ...gatewayRecurring.map(gatewaySubscriptionRow)];
      const filteredRows = state ? allRows.filter((row) => row.stateCode === state) : allRows;
      return {
        page,
        limit,
        total: state ? filteredRows.length : total,
        rows: filteredRows.slice(0, limit),
        candidateRows: candidateRows.map(candidateRow),
        state,
        stateOptions: buildStateOptions(allRows),
        summary: {
          totalSubscriptions: Number(snapshot.totalSubscriptions ?? total),
          activeWooSubscriptions: Number(snapshot.activeWooSubscriptions ?? activeWooSubscriptions),
          activeGatewayRecurringCustomers: Number(snapshot.activeGatewayRecurringCustomers ?? gatewayRecurring.length),
          totalActiveRecurringCustomers: Number(snapshot.totalActiveRecurringCustomers ?? activeWooSubscriptions + gatewayRecurring.length),
          activeSubscriptions: Number(snapshot.totalActiveRecurringCustomers ?? activeWooSubscriptions + gatewayRecurring.length),
          activeWooSubscriptionsDbCount: activeWooSubscriptions,
          activeWooSubscriptionsDisplayed: rows.length,
          monthlyRecurringRevenue: Number(snapshot.totalMonthlyRecurringRevenue ?? snapshot.activeMRR ?? activeWooMrr[0]?.mrr ?? 0),
          totalMonthlyRecurringRevenue: Number(snapshot.totalMonthlyRecurringRevenue ?? snapshot.activeMRR ?? activeWooMrr[0]?.mrr ?? 0),
          subscriptionCandidates: candidateRows.length,
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
    const rows = records.map((record) => ({
      _id: String(record._id),
      subscriptionId: String(record.wooSubscriptionId),
      subscriptionNumber: record.subscriptionNumber,
      source: "woocommerce",
      customerEmail: record.customerEmail,
      customerName: record.customerName,
      businessName: resolveBusinessName(customerByEmail.get(record.customerEmail?.trim().toLowerCase() || "")).businessName,
      stateCode: enrichCustomerProfile(customerByEmail.get(record.customerEmail?.trim().toLowerCase() || "")).stateCode,
      stateName: enrichCustomerProfile(customerByEmail.get(record.customerEmail?.trim().toLowerCase() || "")).stateName,
      stateSource: enrichCustomerProfile(customerByEmail.get(record.customerEmail?.trim().toLowerCase() || "")).stateSource,
      customerPhone: record.customerPhone,
      status: record.status,
      amount: record.recurringTotal || record.amount,
      monthlyRecurringRevenue: record.status === "active" ? (record.recurringTotal || record.amount) : 0,
      billingInterval: [record.billingInterval, record.billingPeriod].filter(Boolean).join(" "),
      nextBillingDate: record.nextPaymentDate,
      lastBillingDate: record.lastPaymentDate,
      startDate: record.startDate,
      paymentMethodTitle: record.paymentMethodTitle || record.paymentMethod,
      productNames: record.productNames,
      sourceStatus: "real",
      recordType: "subscription",
    }));
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
    const rows = records.map((record) => ({
      _id: String(record._id),
      subscriptionId: String(record.wooSubscriptionId),
      subscriptionNumber: record.subscriptionNumber,
      source: "woocommerce",
      customerEmail: record.customerEmail,
      customerName: record.customerName,
      businessName: resolveBusinessName(customerByEmail.get(record.customerEmail?.trim().toLowerCase() || "")).businessName,
      customerPhone: record.customerPhone,
      status: record.status,
      amount: record.recurringTotal || record.amount,
      monthlyRecurringRevenue: record.status === "active" ? (record.recurringTotal || record.amount) : 0,
      billingInterval: [record.billingInterval, record.billingPeriod].filter(Boolean).join(" "),
      nextBillingDate: record.nextPaymentDate,
      lastBillingDate: record.lastPaymentDate,
      startDate: record.startDate,
      paymentMethodTitle: record.paymentMethodTitle || record.paymentMethod,
      productNames: record.productNames,
      sourceStatus: "real",
      recordType: "subscription",
    }));
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

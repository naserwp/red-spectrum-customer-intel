import { NextResponse } from "next/server";
import { buildStateOptions, normalizeStateCode } from "@/lib/customerBusinessResolver";
import { enrichCustomerProfile } from "@/lib/customerEnrichment";
import { rankingSort } from "@/lib/customerTableQuery";
import { connectToDatabase } from "@/lib/mongodb";
import { Customer, type CustomerDocument } from "@/models/Customer";
import { CustomerRanking, type CustomerRankingDocument } from "@/models/CustomerRanking";
import { WooCommerceOrderRecord, type WooCommerceOrderDocument } from "@/models/WooCommerceOrder";

export const dynamic = "force-dynamic";

function periodSpent(row: CustomerRankingDocument, period: string) {
  if (period === "monthly") return row.monthlySpent;
  if (period === "yearly") return row.yearlySpent;
  return row.lifetimeSpent;
}

function verifiedCreditValue(customer?: Partial<CustomerDocument> | null) {
  if (!customer?.businessProfile?.creditMetaVerified) return 0;
  return Number(
    customer.businessProfile?.approvedCredits ||
    customer.businessProfile?.creditLimit ||
    customer.actualCreditLimit ||
    customer.businessProfile?.potentialCreditLimit ||
    0
  );
}

function normalizedEmail(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

async function latestWooOrdersByEmail(customers: Array<Partial<CustomerDocument> & { email?: string; normalizedEmail?: string }>) {
  const emails = Array.from(new Set(customers.map((customer) => normalizedEmail(customer.normalizedEmail || customer.email)).filter(Boolean)));
  if (!emails.length) return new Map<string, WooCommerceOrderDocument>();
  const orders = await WooCommerceOrderRecord.find(
    { normalizedEmail: { $in: emails } },
    { normalizedEmail: 1, billingCompany: 1, billingState: 1, billing: 1, billingAddress: 1, dateCreated: 1, isPaid: 1 },
  ).sort({ isPaid: -1, dateCreated: -1 }).limit(Math.min(5000, emails.length * 5)).lean<WooCommerceOrderDocument[]>();
  const byEmail = new Map<string, WooCommerceOrderDocument>();
  for (const order of orders) {
    const email = normalizedEmail(order.normalizedEmail);
    if (email && !byEmail.has(email)) byEmail.set(email, order);
  }
  return byEmail;
}

export async function GET(request: Request) {
  const started = Date.now();
  await connectToDatabase();
  const dbStarted = Date.now();
  const { searchParams } = new URL(request.url);
  const period = searchParams.get("period") ?? "all";
  const state = normalizeStateCode(searchParams.get("state"));
  const page = Math.max(1, Number(searchParams.get("page") ?? 1));
  const limit = Math.min(100, Math.max(1, Number(searchParams.get("limit") ?? 25)));
  const sort = rankingSort(searchParams, period);
  const [total, records] = await Promise.all([
    CustomerRanking.countDocuments({}),
    CustomerRanking.find({}).sort(sort).limit(10000).lean<CustomerRankingDocument[]>(),
  ]);
  if (total === 0) {
    const fallbackQuery = { $or: [{ lifetimeValue: { $gt: 0 } }, { rankingPaidTotal: { $gt: 0 } }, { paidTotal: { $gt: 0 } }, { attemptedTotal: { $gt: 0 } }] };
    const [fallbackTotal, fallbackCustomers] = await Promise.all([
      Customer.countDocuments({ $or: [{ lifetimeValue: { $gt: 0 } }, { rankingPaidTotal: { $gt: 0 } }, { paidTotal: { $gt: 0 } }, { attemptedTotal: { $gt: 0 } }] }),
      Customer.find(
        fallbackQuery,
        { name: 1, email: 1, normalizedEmail: 1, phone: 1, lifetimeValue: 1, rankingPaidTotal: 1, paidTotal: 1, totalPaid: 1, attemptedTotal: 1, paidMonths: 1, paidOrderCount: 1, firstPaidDate: 1, firstOrderDate: 1, lastPaidDate: 1, lastOrderDate: 1, activeSubscriptions: 1, isGatewayRecurring: 1, recurringAmount: 1, stayWithUsMonths: 1, tier: 1, paymentStatus: 1, riskLevel: 1, score: 1, estimatedCreditLimit: 1, actualCreditLimit: 1, businessProfile: 1, profile: 1, billingState: 1, billingAddress: 1, shippingState: 1, address: 1, billing: 1, shipping: 1, state: 1, orders: 1, factiivProfile: 1, publicEnrichment: 1 },
      ).sort({ lifetimeValue: -1, rankingPaidTotal: -1, paidTotal: -1 }).limit(10000).lean<Array<CustomerDocument & { _id: unknown }>>(),
    ]);
    const latestOrders = await latestWooOrdersByEmail(fallbackCustomers);
    const allRows = fallbackCustomers.map((customer, index) => {
      const lifetimeSpent = Number(customer.lifetimeValue ?? customer.rankingPaidTotal ?? customer.paidTotal ?? customer.totalPaid ?? 0);
      const latestWooOrder = latestOrders.get(normalizedEmail(customer.normalizedEmail || customer.email));
      const resolverInput = latestWooOrder ? { ...customer, latestWooOrder } : customer;
      const enrichment = enrichCustomerProfile(resolverInput);
      return {
        _id: String(customer._id),
        name: customer.name,
        email: customer.email,
        phone: customer.phone,
        rank: (page - 1) * limit + index + 1,
        lifetimeSpent,
        periodSpent: lifetimeSpent,
        monthlySpent: 0,
        yearlySpent: lifetimeSpent,
        paidMonths: Number(customer.paidMonths ?? customer.paidOrderCount ?? 0),
        firstPaidDate: customer.firstPaidDate || customer.firstOrderDate,
        latestPaidDate: customer.lastPaidDate || customer.lastOrderDate,
        lastPaidDate: customer.lastPaidDate || customer.lastOrderDate,
        activeSubscriptionCount: Number(customer.activeSubscriptions ?? 0) + (customer.isGatewayRecurring ? 1 : 0),
        estimatedMRR: Number(customer.recurringAmount ?? 0),
        stayWithUsMonths: Number(customer.stayWithUsMonths ?? 0),
        attemptedPipeline: Number(customer.attemptedTotal ?? 0),
        category: lifetimeSpent >= 2000 ? "VIP Paid Customer" : lifetimeSpent > 0 ? "Paying Customer" : "Hot Lead",
        businessName: enrichment.businessName,
        businessNameSource: enrichment.businessNameSource,
        businessNameConfidence: enrichment.businessNameConfidence,
        stateCode: enrichment.stateCode,
        stateName: enrichment.stateName,
        stateSource: enrichment.stateSource,
        stateConfidence: enrichment.stateConfidence,
        enrichmentSource: enrichment.enrichmentSource,
        tier: customer.tier,
        paymentStatus: customer.paymentStatus,
        riskLevel: customer.riskLevel,
        score: customer.score,
        estimatedCreditLimit: verifiedCreditValue(customer),
        businessProfile: customer.businessProfile,
        paidTotal: lifetimeSpent,
        totalPaid: lifetimeSpent,
        attemptedTotal: Number(customer.attemptedTotal ?? 0),
      };
    });
    const rows = state ? allRows.filter((row) => row.stateCode === state) : allRows;
    const pagedRows = rows.slice((page - 1) * limit, page * limit);
    const payload = {
      page,
      limit,
      total: state ? rows.length : fallbackTotal,
      rows: pagedRows,
      period,
      state,
      stateOptions: buildStateOptions(allRows),
      from: searchParams.get("from") ?? "",
      to: searchParams.get("to") ?? "",
      analyticsCacheReady: false,
      message: "Analytics cache is rebuilding...",
      warning: "Analytics cache is empty. Showing fallback customer rankings from stored Customer totals.",
    };
    return NextResponse.json(payload);
  }
  const customerIds = records.map((row) => row.customerId);
  const customerDetails = customerIds.length ? await Customer.find({ _id: { $in: customerIds } }, {
    email: 1, normalizedEmail: 1, businessProfile: 1, profile: 1, tier: 1, paymentStatus: 1, riskLevel: 1, score: 1, estimatedCreditLimit: 1, actualCreditLimit: 1, billingState: 1, billingAddress: 1, shippingState: 1, address: 1, billing: 1, shipping: 1, state: 1, orders: 1, factiivProfile: 1, publicEnrichment: 1,
  }).lean<Array<CustomerDocument & { _id: unknown }>>() : [];
  const latestOrders = await latestWooOrdersByEmail(customerDetails);
  const customerDetailById = new Map(customerDetails.map((customer) => [String(customer._id), customer]));
  const allRows = records.map((row, index) => {
    const detail = customerDetailById.get(row.customerId);
    const latestWooOrder = latestOrders.get(normalizedEmail(detail?.normalizedEmail || detail?.email || row.email));
    const resolverInput = detail && latestWooOrder ? { ...detail, latestWooOrder } : detail;
    const enrichment = enrichCustomerProfile(resolverInput);
    const businessName = enrichment.businessName || row.businessName || "";
    const stateCode = enrichment.stateCode || row.stateCode || "";
    return ({
    _id: row.customerId,
    name: row.name,
    email: row.email,
    phone: row.phone,
    rank: (page - 1) * limit + index + 1,
    lifetimeSpent: row.lifetimeSpent,
    periodSpent: periodSpent(row, period),
    monthlySpent: row.monthlySpent,
    yearlySpent: row.yearlySpent,
    paidMonths: row.paidMonths,
    firstPaidDate: row.firstPaidDate,
    latestPaidDate: row.latestPaidDate,
    lastPaidDate: row.latestPaidDate,
    activeSubscriptionCount: row.activeSubscriptionCount,
    estimatedMRR: row.estimatedMRR,
    stayWithUsMonths: row.stayWithUsMonths,
    attemptedPipeline: row.attemptedPipeline,
    category: row.category,
    businessName,
    businessNameSource: enrichment.businessNameSource || row.businessNameSource || "",
    businessNameConfidence: enrichment.businessName ? enrichment.businessNameConfidence : row.businessNameConfidence || "",
    stateCode,
    stateName: enrichment.stateName || row.stateName || "",
    stateSource: enrichment.stateSource || row.stateSource || "",
    stateConfidence: enrichment.stateCode ? enrichment.stateConfidence : row.stateConfidence || "",
    enrichmentSource: enrichment.enrichmentSource !== "unresolved" ? enrichment.enrichmentSource : row.enrichmentSource || "",
    tier: detail?.tier || "",
    paymentStatus: detail?.paymentStatus || "",
    riskLevel: detail?.riskLevel || "",
    score: detail?.score ?? 0,
    estimatedCreditLimit: verifiedCreditValue(detail),
    businessProfile: detail?.businessProfile,
    paidTotal: row.lifetimeSpent,
    totalPaid: row.lifetimeSpent,
    attemptedTotal: row.attemptedPipeline,
  });
  });
  const rows = state ? allRows.filter((row) => row.stateCode === state) : allRows;
  const pagedRows = rows.slice((page - 1) * limit, page * limit);
  const payload = {
    page,
    limit,
    total: state ? rows.length : total,
    rows: pagedRows,
    period,
    state,
    stateOptions: buildStateOptions(allRows),
    from: searchParams.get("from") ?? "",
    to: searchParams.get("to") ?? "",
    analyticsCacheReady: total > 0,
    warning: total === 0 ? "Analytics cache is empty. Run Sync Now to rebuild dashboard analytics." : "",
  };
  if (process.env.NODE_ENV === "development") {
    console.log(`[api] analytics-high-value durationMs=${Date.now() - started} mongoMs=${Date.now() - dbStarted} recordsReturned=${rows.length} cache=stored responseBytes=${JSON.stringify(payload).length}`);
  }
  return NextResponse.json(payload);
}

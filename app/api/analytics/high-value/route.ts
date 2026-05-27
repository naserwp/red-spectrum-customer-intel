import { NextResponse } from "next/server";
import { normalizeStateCode, resolveCustomerStateCode, uniqueStateCodes } from "@/lib/customerState";
import { connectToDatabase } from "@/lib/mongodb";
import { Customer, type CustomerDocument } from "@/models/Customer";
import { CustomerRanking, type CustomerRankingDocument } from "@/models/CustomerRanking";

export const dynamic = "force-dynamic";

function sortForPeriod(period: string): Record<string, 1 | -1> {
  if (period === "monthly") return { monthlySpent: -1, lifetimeSpent: -1 };
  if (period === "yearly") return { yearlySpent: -1, lifetimeSpent: -1 };
  return { lifetimeSpent: -1 };
}

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

export async function GET(request: Request) {
  const started = Date.now();
  await connectToDatabase();
  const dbStarted = Date.now();
  const { searchParams } = new URL(request.url);
  const period = searchParams.get("period") ?? "all";
  const state = normalizeStateCode(searchParams.get("state"));
  const page = Math.max(1, Number(searchParams.get("page") ?? 1));
  const limit = Math.min(100, Math.max(1, Number(searchParams.get("limit") ?? 25)));
  const sort = sortForPeriod(period);
  const shouldFilterState = Boolean(state);
  const [total, records] = await Promise.all([
    CustomerRanking.countDocuments({}),
    CustomerRanking.find({}).sort(sort).skip(shouldFilterState ? 0 : (page - 1) * limit).limit(shouldFilterState ? 5000 : limit).lean<CustomerRankingDocument[]>(),
  ]);
  if (total === 0) {
    const fallbackQuery = { $or: [{ lifetimeValue: { $gt: 0 } }, { rankingPaidTotal: { $gt: 0 } }, { paidTotal: { $gt: 0 } }, { attemptedTotal: { $gt: 0 } }] };
    const [fallbackTotal, fallbackCustomers] = await Promise.all([
      Customer.countDocuments({ $or: [{ lifetimeValue: { $gt: 0 } }, { rankingPaidTotal: { $gt: 0 } }, { paidTotal: { $gt: 0 } }, { attemptedTotal: { $gt: 0 } }] }),
      Customer.find(
        fallbackQuery,
        { name: 1, email: 1, phone: 1, lifetimeValue: 1, rankingPaidTotal: 1, paidTotal: 1, totalPaid: 1, attemptedTotal: 1, paidMonths: 1, paidOrderCount: 1, firstPaidDate: 1, firstOrderDate: 1, lastPaidDate: 1, lastOrderDate: 1, activeSubscriptions: 1, isGatewayRecurring: 1, recurringAmount: 1, stayWithUsMonths: 1, tier: 1, paymentStatus: 1, riskLevel: 1, score: 1, estimatedCreditLimit: 1, actualCreditLimit: 1, businessProfile: 1, billingState: 1, shippingState: 1, address: 1, billing: 1, shipping: 1 },
      ).sort({ lifetimeValue: -1, rankingPaidTotal: -1, paidTotal: -1 }).skip(shouldFilterState ? 0 : (page - 1) * limit).limit(shouldFilterState ? 5000 : limit).lean<Array<CustomerDocument & { _id: unknown }>>(),
    ]);
    const allRows = fallbackCustomers.map((customer, index) => {
      const lifetimeSpent = Number(customer.lifetimeValue ?? customer.rankingPaidTotal ?? customer.paidTotal ?? customer.totalPaid ?? 0);
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
        businessName: customer.businessProfile?.company || "",
        stateCode: resolveCustomerStateCode(customer),
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
    const pagedRows = state ? rows.slice((page - 1) * limit, page * limit) : rows;
    const payload = {
      page,
      limit,
      total: state ? rows.length : fallbackTotal,
      rows: pagedRows,
      period,
      state,
      stateOptions: uniqueStateCodes(allRows),
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
    businessProfile: 1, tier: 1, paymentStatus: 1, riskLevel: 1, score: 1, estimatedCreditLimit: 1, actualCreditLimit: 1, billingState: 1, shippingState: 1, address: 1, billing: 1, shipping: 1,
  }).lean<Array<CustomerDocument & { _id: unknown }>>() : [];
  const customerDetailById = new Map(customerDetails.map((customer) => [String(customer._id), customer]));
  const allRows = records.map((row, index) => {
    const detail = customerDetailById.get(row.customerId);
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
    businessName: detail?.businessProfile?.company || "",
    stateCode: resolveCustomerStateCode(detail),
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
  const pagedRows = state ? rows.slice((page - 1) * limit, page * limit) : rows;
  const payload = {
    page,
    limit,
    total: state ? rows.length : total,
    rows: pagedRows,
    period,
    state,
    stateOptions: uniqueStateCodes(allRows),
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

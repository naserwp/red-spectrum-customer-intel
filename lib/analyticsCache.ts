import { dateInRange, monthEnd, monthStart, monthsBetween, wooSubscriptionMrr } from "@/lib/revenueAnalytics";
import { resolveBusinessName } from "@/lib/customerBusiness";
import { enrichCustomerProfile } from "@/lib/customerEnrichment";
import { calculateCustomerValueMetrics } from "@/lib/customerValue";
import { AnalyticsSnapshot } from "@/models/AnalyticsSnapshot";
import { AuthorizeNetTransaction, type AuthorizeNetTransactionDocument } from "@/models/AuthorizeNetTransaction";
import { Customer, type CustomerDocument } from "@/models/Customer";
import { CustomerRanking } from "@/models/CustomerRanking";
import { NmiQuickPayTransaction, type NmiQuickPayTransactionDocument } from "@/models/NmiQuickPayTransaction";
import { StripeTransaction, type StripeTransactionDocument } from "@/models/StripeTransaction";
import { Subscription } from "@/models/Subscription";
import { WooCommerceOrderRecord, type WooCommerceOrderDocument } from "@/models/WooCommerceOrder";
import { WooCommerceSubscriptionRecord, type WooCommerceSubscriptionDocument } from "@/models/WooCommerceSubscription";

type LeanWooSubscription = WooCommerceSubscriptionDocument & { _id: unknown };
type LeanAuthorizeNetTransaction = AuthorizeNetTransactionDocument & { _id: unknown };
type LeanNmiQuickPayTransaction = NmiQuickPayTransactionDocument & { _id: unknown };
type LeanStripeTransaction = StripeTransactionDocument & { _id: unknown };

function category(lifetimeSpent: number, attemptedPipeline: number) {
  if (lifetimeSpent >= 2000) return "VIP Paid Customer";
  if (lifetimeSpent > 0) return "Paying Customer";
  if (attemptedPipeline > 0) return "Hot Lead";
  return "Cold Lead";
}

function paidValue(customer: Partial<CustomerDocument>) {
  return Number(customer.lifetimeValue ?? customer.rankingPaidTotal ?? customer.paidTotal ?? customer.totalPaid ?? 0);
}

function normalizedEmail(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

function startOfDay(date = new Date()) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function validUpcomingDate(value: string, from: Date, to?: Date) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  const time = date.getTime();
  return time >= startOfDay(from).getTime() && (!to || time <= to.getTime());
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

export async function readAnalyticsSnapshot<T extends Record<string, unknown>>(key: string, fallback: T) {
  const snapshot = await AnalyticsSnapshot.findOne({ key }).lean<{ payload?: T; generatedAt?: string; warnings?: string[] } | null>().exec();
  return {
    ...fallback,
    ...(snapshot?.payload ?? {}),
    analyticsGeneratedAt: snapshot?.generatedAt ?? "",
    analyticsCacheReady: Boolean(snapshot),
    warnings: snapshot?.warnings ?? [],
  };
}

export async function rebuildAnalyticsCacheBatch({ limit = 100, offset = 0, maxRuntimeMs = 8000 }: { limit?: number; offset?: number; maxRuntimeMs?: number } = {}) {
  const started = Date.now();
  const generatedAt = new Date().toISOString();
  const now = new Date();
  const currentMonthStart = monthStart(now);
  const currentMonthEnd = monthEnd(now);
  const currentYearStart = new Date(now.getFullYear(), 0, 1);
  const safeLimit = Math.min(100, Math.max(1, Math.floor(limit)));
  const safeOffset = Math.max(0, Math.floor(offset));
  const [customers, totalCustomers, subscriptions, summaryAgg, authSubscriptionAgg] = await Promise.all([
    Customer.find({}, {
      name: 1, email: 1, normalizedEmail: 1, phone: 1, attemptedTotal: 1, attemptedOrderCount: 1, firstPaidDate: 1, firstOrderDate: 1, lastPaidDate: 1, lastOrderDate: 1,
      activeSubscriptions: 1, isGatewayRecurring: 1, recurringAmount: 1, recurringNextEstimatedPayment: 1, recurringLastPayment: 1, paidMonths: 1, stayWithUsMonths: 1, riskLevel: 1,
      lifetimeValue: 1, rankingPaidTotal: 1, paidTotal: 1, totalPaid: 1, orders: 1, gatewayPayments: 1, paidOrderCount: 1, businessProfile: 1, profile: 1, company: 1, billing: 1, billingCompany: 1, billingAddress: 1, billingState: 1, address: 1, state: 1,
    }).sort({ lifetimeValue: -1, rankingPaidTotal: -1, paidTotal: -1 }).skip(safeOffset).limit(safeLimit).lean<Array<CustomerDocument & { _id: unknown }>>(),
    Customer.estimatedDocumentCount(),
    WooCommerceSubscriptionRecord.find({}).lean<LeanWooSubscription[]>(),
    Customer.aggregate<{ _id: null; paidRevenue: number; attemptedRevenue: number; activeGatewayRecurringCustomers: number; gatewayMrr: number; highValueCustomers: number }>([
      {
        $group: {
          _id: null,
          paidRevenue: { $sum: { $ifNull: ["$lifetimeValue", { $ifNull: ["$rankingPaidTotal", { $ifNull: ["$paidTotal", "$totalPaid"] }] }] } },
          attemptedRevenue: { $sum: { $ifNull: ["$attemptedTotal", 0] } },
          activeGatewayRecurringCustomers: { $sum: { $cond: ["$isGatewayRecurring", 1, 0] } },
          gatewayMrr: { $sum: { $cond: ["$isGatewayRecurring", { $ifNull: ["$recurringAmount", 0] }, 0] } },
          highValueCustomers: { $sum: { $cond: [{ $gte: [{ $ifNull: ["$lifetimeValue", { $ifNull: ["$rankingPaidTotal", { $ifNull: ["$paidTotal", "$totalPaid"] }] }] }, 2000] }, 1, 0] } },
        },
      },
    ]),
    Subscription.aggregate<{ _id: null; total: number; active: number; mrr: number }>([
      { $match: { source: "authorize_net", recordType: "subscription", sourceStatus: "real" } },
      { $group: { _id: null, total: { $sum: 1 }, active: { $sum: { $cond: [{ $eq: ["$status", "active"] }, 1, 0] } }, mrr: { $sum: { $cond: [{ $eq: ["$status", "active"] }, { $ifNull: ["$monthlyRecurringRevenue", "$amount"] }, 0] } } } },
    ]),
  ]);
  const summary = summaryAgg[0];
  const authSubscriptionSummary = authSubscriptionAgg[0] ?? { total: 0, active: 0, mrr: 0 };
  const batchEmails = Array.from(new Set(customers.map((customer) => customer.normalizedEmail || customer.email?.trim().toLowerCase()).filter(Boolean)));
  const batchIds = customers.map((customer) => String(customer._id));
  const authConditions = [
    ...(batchEmails.length ? [{ normalizedEmail: { $in: batchEmails } }, { emailNormalized: { $in: batchEmails } }, { customerEmail: { $in: batchEmails } }] : []),
    ...(batchIds.length ? [{ matchedCustomerId: { $in: batchIds } }] : []),
  ];
  const authTransactions = authConditions.length ? await AuthorizeNetTransaction.find({ $or: authConditions }, {
    transactionId: 1, transactionStatus: 1, invoiceNumber: 1, amount: 1, settledAt: 1, submittedAt: 1, normalizedEmail: 1, emailNormalized: 1, customerEmail: 1,
    matchedCustomerId: 1, wooOrderNumberMatched: 1, wooOrderIdMatched: 1, customerName: 1,
  }).limit(Math.max(100, customers.length * 25)).lean<LeanAuthorizeNetTransaction[]>() : [];
  const authByCustomerId = new Map<string, LeanAuthorizeNetTransaction[]>();
  const authByEmail = new Map<string, LeanAuthorizeNetTransaction[]>();
  for (const transaction of authTransactions) {
    if (transaction.matchedCustomerId) authByCustomerId.set(transaction.matchedCustomerId, [...(authByCustomerId.get(transaction.matchedCustomerId) ?? []), transaction]);
    const email = transaction.normalizedEmail || transaction.emailNormalized || transaction.customerEmail;
    if (email) authByEmail.set(email, [...(authByEmail.get(email) ?? []), transaction]);
  }
  const nmiConditions = [
    ...(batchEmails.length ? [{ normalizedEmail: { $in: batchEmails } }, { emailNormalized: { $in: batchEmails } }, { customerEmail: { $in: batchEmails } }] : []),
    ...(batchIds.length ? [{ matchedCustomerId: { $in: batchIds } }] : []),
  ];
  const nmiTransactions = nmiConditions.length ? await NmiQuickPayTransaction.find({ $or: nmiConditions }, {
    transactionId: 1, transactionStatus: 1, invoiceNumber: 1, amount: 1, settledAt: 1, submittedAt: 1, normalizedEmail: 1, emailNormalized: 1, customerEmail: 1,
    matchedCustomerId: 1, wooOrderNumberMatched: 1, wooOrderIdMatched: 1, customerName: 1,
  }).limit(Math.max(100, customers.length * 25)).lean<LeanNmiQuickPayTransaction[]>() : [];
  const nmiByCustomerId = new Map<string, LeanNmiQuickPayTransaction[]>();
  const nmiByEmail = new Map<string, LeanNmiQuickPayTransaction[]>();
  for (const transaction of nmiTransactions) {
    if (transaction.matchedCustomerId) nmiByCustomerId.set(transaction.matchedCustomerId, [...(nmiByCustomerId.get(transaction.matchedCustomerId) ?? []), transaction]);
    const email = transaction.normalizedEmail || transaction.emailNormalized || transaction.customerEmail;
    if (email) nmiByEmail.set(email, [...(nmiByEmail.get(email) ?? []), transaction]);
  }
  const stripeConditions = [
    ...(batchEmails.length ? [{ normalizedEmail: { $in: batchEmails } }, { emailNormalized: { $in: batchEmails } }, { email: { $in: batchEmails } }] : []),
    ...(batchIds.length ? [{ matchedCustomerId: { $in: batchIds } }] : []),
  ];
  const stripeTransactions = stripeConditions.length ? await StripeTransaction.find({ $or: stripeConditions }, {
    transactionId: 1, chargeId: 1, stripePaymentIntentId: 1, status: 1, invoiceNumber: 1, amount: 1, amountRefunded: 1, paidAt: 1, stripeCreatedAt: 1,
    normalizedEmail: 1, emailNormalized: 1, email: 1, matchedCustomerId: 1, wooOrderNumberMatched: 1, wooOrderIdMatched: 1, name: 1,
  }).limit(Math.max(100, customers.length * 25)).lean<LeanStripeTransaction[]>() : [];
  const stripeByCustomerId = new Map<string, LeanStripeTransaction[]>();
  const stripeByEmail = new Map<string, LeanStripeTransaction[]>();
  for (const transaction of stripeTransactions) {
    if (transaction.matchedCustomerId) stripeByCustomerId.set(transaction.matchedCustomerId, [...(stripeByCustomerId.get(transaction.matchedCustomerId) ?? []), transaction]);
    const email = transaction.normalizedEmail || transaction.emailNormalized || transaction.email;
    if (email) stripeByEmail.set(email, [...(stripeByEmail.get(email) ?? []), transaction]);
  }
  const latestOrders = await latestWooOrdersByEmail(customers);
  const rankingRows = [];
  const customerMetricUpdates = [];
  for (const customer of customers) {
    if (rankingRows.length > 0 && Date.now() - started > maxRuntimeMs - 500) break;
    const customerEmail = customer.normalizedEmail || customer.email?.trim().toLowerCase() || "";
    const customerAuthTransactions = [
      ...(authByCustomerId.get(String(customer._id)) ?? []),
      ...(customerEmail ? authByEmail.get(customerEmail) ?? [] : []),
    ].filter((transaction, index, rows) => rows.findIndex((row) => row.transactionId === transaction.transactionId) === index);
    const customerNmiTransactions = [
      ...(nmiByCustomerId.get(String(customer._id)) ?? []),
      ...(customerEmail ? nmiByEmail.get(customerEmail) ?? [] : []),
    ].filter((transaction, index, rows) => rows.findIndex((row) => row.transactionId === transaction.transactionId) === index);
    const customerStripeTransactions = [
      ...(stripeByCustomerId.get(String(customer._id)) ?? []),
      ...(customerEmail ? stripeByEmail.get(customerEmail) ?? [] : []),
    ].filter((transaction, index, rows) => rows.findIndex((row) => row.transactionId === transaction.transactionId) === index);
    const metrics = calculateCustomerValueMetrics({ customer, authorizeNetTransactions: customerAuthTransactions, nmiTransactions: customerNmiTransactions, stripeTransactions: customerStripeTransactions, subscriptions: subscriptions.filter((sub) => sub.normalizedEmail === customerEmail) });
    const lifetimeSpent = metrics.rankingTotal || paidValue(customer);
    const latestWooOrder = latestOrders.get(customerEmail);
    const resolverInput = latestWooOrder ? { ...customer, latestWooOrder } : customer;
    const enrichment = enrichCustomerProfile(resolverInput);
    console.log("[business-resolver]", customerEmail, enrichment.businessName, enrichment.stateCode);
    const firstPaidDate = metrics.firstPaidDate || customer.firstPaidDate || customer.firstOrderDate || "";
    const latestPaidDate = metrics.lastPaidDate || customer.lastPaidDate || customer.lastOrderDate || "";
    const attemptedPipeline = metrics.attemptedTotal;
    const customerSet: Record<string, unknown> = {
      lifetimeValue: lifetimeSpent,
      rankingPaidTotal: lifetimeSpent,
      paidTotal: lifetimeSpent,
      totalPaid: lifetimeSpent,
      wooPaidTotal: metrics.wooPaidTotal,
      authorizeNetPaidTotal: metrics.authorizeNetPaidTotal,
      gatewayOnlyPaidTotal: metrics.gatewayOnlyPaidTotal,
      nmiQuickPayPaidTotal: metrics.nmiQuickPayPaidTotal,
      stripePaidTotal: metrics.stripePaidTotal,
      subscriptionPaidTotal: metrics.subscriptionPaidTotal,
      attemptedTotal: attemptedPipeline,
      paidMonths: metrics.paidMonths,
      firstPaidDate,
      lastPaidDate: latestPaidDate,
      stayWithUsMonths: metrics.stayWithUsMonths,
    };
    if (enrichment.businessName) {
      customerSet["businessProfile.businessName"] = enrichment.businessName;
      customerSet["businessProfile.company"] = enrichment.businessName;
      customerSet["businessProfile.businessNameSource"] = enrichment.businessNameSource;
      customerSet["businessProfile.businessNameConfidence"] = enrichment.businessNameConfidence;
      customerSet["sourceCoverage.businessNameSource"] = enrichment.businessNameSource;
    }
    if (enrichment.stateCode) {
      customerSet["businessProfile.state"] = enrichment.stateCode;
      customerSet["businessProfile.stateCode"] = enrichment.stateCode;
      customerSet["businessProfile.stateSource"] = enrichment.stateSource;
      customerSet["businessProfile.stateConfidence"] = enrichment.stateConfidence;
      customerSet["sourceCoverage.stateSource"] = enrichment.stateSource;
    }
    if (enrichment.resolved) customerSet["businessProfile.enrichmentSource"] = enrichment.enrichmentSource;
    customerMetricUpdates.push({
      updateOne: {
        filter: { _id: customer._id },
        update: {
          $set: customerSet,
        },
      },
    });
    rankingRows.push({
      customerId: String(customer._id),
      name: customer.name,
      email: customer.email,
      phone: customer.phone,
      businessName: enrichment.businessName,
      businessNameSource: enrichment.businessNameSource,
      businessNameConfidence: enrichment.businessNameConfidence,
      stateCode: enrichment.stateCode,
      stateName: enrichment.stateName,
      stateSource: enrichment.stateSource,
      stateConfidence: enrichment.stateConfidence,
      enrichmentSource: enrichment.enrichmentSource,
      lifetimeSpent,
      periodSpent: lifetimeSpent,
      monthlySpent: dateInRange(latestPaidDate, currentMonthStart, now) ? lifetimeSpent : 0,
      yearlySpent: dateInRange(latestPaidDate, currentYearStart, now) ? lifetimeSpent : 0,
      paidMonths: Number(customer.paidMonths ?? 0),
      firstPaidDate,
      latestPaidDate,
      activeSubscriptionCount: Number(customer.activeSubscriptions ?? 0) + (customer.isGatewayRecurring ? 1 : 0),
      estimatedMRR: Number(customer.recurringAmount ?? 0),
      stayWithUsMonths: Math.max(monthsBetween(firstPaidDate), Number(customer.stayWithUsMonths ?? 0)),
      attemptedPipeline,
      category: category(lifetimeSpent, attemptedPipeline),
      generatedAt,
    });
  }
  const filteredRankingRows = rankingRows.filter((row) => row.lifetimeSpent > 0 || row.attemptedPipeline > 0);

  if (filteredRankingRows.length) {
    await CustomerRanking.bulkWrite(filteredRankingRows.map((row) => ({
      updateOne: { filter: { customerId: row.customerId }, update: { $set: row }, upsert: true },
    })), { ordered: false });
  }
  if (customerMetricUpdates.length) {
    await Customer.bulkWrite(customerMetricUpdates, { ordered: false });
  }

  const activeWooSubscriptions = subscriptions.filter((subscription) => subscription.status === "active");
  const gatewayRecurringCustomers = customers.filter((customer) => customer.isGatewayRecurring);
  const upcomingWooRows = activeWooSubscriptions.filter((subscription) => subscription.scheduleNeedsReview !== true && validUpcomingDate(subscription.nextPaymentDate ?? "", now, currentMonthEnd)).map((record) => ({
    _id: String(record._id),
    subscriptionId: String(record.wooSubscriptionId),
    subscriptionNumber: record.subscriptionNumber,
    source: "woocommerce",
    customerEmail: record.customerEmail,
    customerName: record.customerName,
    customerPhone: record.customerPhone,
    businessName: "",
    status: record.status,
    amount: Number(record.recurringTotal ?? record.amount ?? 0),
    monthlyRecurringRevenue: Number(record.recurringTotal ?? record.amount ?? 0),
    billingInterval: [record.billingInterval, record.billingPeriod].filter(Boolean).join(" "),
    nextBillingDate: record.nextPaymentDate,
    lastBillingDate: record.lastPaymentDate,
    startDate: record.startDate,
    paymentMethodTitle: record.paymentMethodTitle || record.paymentMethod,
    productNames: record.productNames,
    sourceStatus: "real",
    recordType: "subscription",
    churnRisk: "low",
    action: "Review subscription renewal",
  }));
  const upcomingGatewayRows = gatewayRecurringCustomers.filter((customer) => validUpcomingDate(customer.recurringNextEstimatedPayment ?? "", now, currentMonthEnd)).map((customer) => ({
    _id: String(customer._id),
    subscriptionId: `authorize-net-${String(customer._id)}`,
    subscriptionNumber: "",
    source: "authorize_net",
    customerEmail: customer.email,
    customerName: customer.name,
    customerPhone: customer.phone,
    businessName: resolveBusinessName(customer).businessName,
    status: "estimated_recurring",
    amount: Number(customer.recurringAmount ?? 0),
    monthlyRecurringRevenue: Number(customer.recurringAmount ?? 0),
    billingInterval: "monthly",
    nextBillingDate: customer.recurringNextEstimatedPayment,
    lastBillingDate: customer.recurringLastPayment,
    startDate: "",
    paymentMethodTitle: "Credit Card Payment",
    productNames: ["Authorize.net Recurring Payment"],
    sourceStatus: "gateway_estimated",
    recordType: "gateway_recurring",
    churnRisk: customer.riskLevel ?? "low",
    action: "Review Authorize.net recurring payment",
  }));
  const upcomingRows = [...upcomingWooRows, ...upcomingGatewayRows].sort((a, b) => String(a.nextBillingDate ?? "").localeCompare(String(b.nextBillingDate ?? "")));
  const activeMRR = wooSubscriptionMrr(subscriptions) + Number(authSubscriptionSummary.mrr ?? summary?.gatewayMrr ?? 0);
  const payload = {
    currentMonthRevenue: rankingRows.reduce((sum, row) => sum + Number(row.monthlySpent ?? 0), 0),
    previousMonthRevenue: 0,
    currentYearRevenue: Number(summary?.paidRevenue ?? 0),
    rolling12MonthRevenue: Number(summary?.paidRevenue ?? 0),
    paidRevenue: Number(summary?.paidRevenue ?? 0),
    attemptedRevenue: Number(summary?.attemptedRevenue ?? 0),
    activeMRR,
    monthlyRecurringRevenue: activeMRR,
    totalMonthlyRecurringRevenue: activeMRR,
    totalSubscriptions: subscriptions.length + Number(authSubscriptionSummary.total ?? 0),
    wooTotalSubscriptions: subscriptions.length,
    authorizeNetTotalSubscriptions: Number(authSubscriptionSummary.total ?? 0),
    activeWooSubscriptions: activeWooSubscriptions.length,
    activeAuthorizeNetSubscriptions: Number(authSubscriptionSummary.active ?? 0),
    activeGatewayRecurringCustomers: Number(authSubscriptionSummary.active ?? 0),
    totalActiveRecurringCustomers: activeWooSubscriptions.length + Number(authSubscriptionSummary.active ?? 0),
    activeSubscriptions: activeWooSubscriptions.length + Number(authSubscriptionSummary.active ?? 0),
    subscriptionNote: `${activeWooSubscriptions.length} WooCommerce active + ${Number(authSubscriptionSummary.active ?? 0)} Authorize.net active ARB`,
    totalUpcomingThisMonth: upcomingRows.length,
    totalUpcomingAmountThisMonth: upcomingRows.reduce((sum, row) => sum + Number(row.amount ?? 0), 0),
    upcomingRevenueThisMonth: upcomingRows.reduce((sum, row) => sum + Number(row.amount ?? 0), 0),
    upcomingCustomerCountThisMonth: upcomingRows.length,
    upcomingToday: upcomingRows.filter((row) => String(row.nextBillingDate ?? "").slice(0, 10) === now.toISOString().slice(0, 10)).length,
    upcomingNext7Days: upcomingRows.filter((row) => validUpcomingDate(String(row.nextBillingDate ?? ""), now, new Date(now.getTime() + 7 * 86400000))).length,
    upcomingRows,
    highValueCustomers: Number(summary?.highValueCustomers ?? 0),
    totalCustomers,
  };
  const previousMonthRevenue = Number(payload.previousMonthRevenue ?? 0);
  const currentMonthRevenue = Number(payload.currentMonthRevenue ?? 0);
  await AnalyticsSnapshot.updateOne(
    { key: "dashboard_analytics" },
    {
      $set: {
        payload: {
          ...payload,
          monthGrowthPercent: previousMonthRevenue > 0 ? ((currentMonthRevenue - previousMonthRevenue) / previousMonthRevenue) * 100 : currentMonthRevenue > 0 ? 100 : 0,
        },
        generatedAt,
        status: safeOffset + rankingRows.length < totalCustomers ? "partial" : rankingRows.length ? "ready" : "empty",
        warnings: safeOffset + rankingRows.length < totalCustomers ? ["Partial analytics rebuild completed. Continue next batch."] : [],
      },
    },
    { upsert: true }
  );
  const customersProcessed = rankingRows.length;
  const hasMore = safeOffset + customersProcessed < totalCustomers;
  return {
    customersProcessed,
    rankingUpdated: filteredRankingRows.length,
    summaryUpdated: true,
    subscriptionMetricsUpdated: true,
    hasMore,
    nextOffset: safeOffset + customersProcessed,
    generatedAt,
    partial: hasMore,
  };
}

export async function rebuildAnalyticsCache() {
  return rebuildAnalyticsCacheBatch({ limit: 500, offset: 0 });
}

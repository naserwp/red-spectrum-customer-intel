import { NextResponse } from "next/server";
import { resolveBusinessName } from "@/lib/customerBusiness";
import { calculateCustomerScore, scoreToStars, type CustomerScoreInput } from "@/lib/customerScore";
import { monthsSince } from "@/lib/customerValue";
import { customerLedgerRecords, detectAuthorizeNetRecurring } from "@/lib/revenueAnalytics";
import { buildProductJourneySummary } from "@/lib/productClassification";
import { countBy, normalizeText, orderHistoryItemFromStoredOrder, unique } from "@/lib/wooOrderImport";
import { importWordPressCreditBatch } from "@/lib/wordpressCreditSync";
import { connectToDatabase } from "@/lib/mongodb";
import { Customer, type CustomerDocument } from "@/models/Customer";
import { SyncJob } from "@/models/SyncJob";
import { WooCommerceOrderRecord, type WooCommerceOrderDocument } from "@/models/WooCommerceOrder";
import { WooCommerceSubscriptionRecord } from "@/models/WooCommerceSubscription";

export const dynamic = "force-dynamic";
const maxRebuildRuntimeMs = 8000;

type AggregationKeyType = "email" | "phone" | "customerId" | "company";

type OrderGroup = {
  key: string;
  keyType: AggregationKeyType;
  orders: WooCommerceOrderDocument[];
};

function safeNumber(value: unknown, fallback: number, max: number) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.min(max, Math.floor(parsed));
}

function dateFilter(from?: string, to?: string) {
  const filter: Record<string, unknown> = {};
  if (from || to) {
    filter.dateCreated = {};
    if (from) (filter.dateCreated as Record<string, string>).$gte = from;
    if (to) (filter.dateCreated as Record<string, string>).$lte = `${to}T23:59:59`;
  }
  return filter;
}

function addressKey(order: WooCommerceOrderDocument) {
  return normalizeText(`${order.billingAddress?.address1 ?? ""} ${order.billingAddress?.postcode ?? ""}`);
}

function groupKeyFor(order: WooCommerceOrderDocument): { key: string; keyType: AggregationKeyType } {
  if (order.normalizedEmail) return { key: order.normalizedEmail, keyType: "email" };
  if (order.normalizedPhone) return { key: order.normalizedPhone, keyType: "phone" };
  if (order.customerId) return { key: String(order.customerId), keyType: "customerId" };
  return {
    key: `${order.normalizedCompany || "company"}:${normalizeText(order.billingName)}:${addressKey(order)}`,
    keyType: "company",
  };
}

function externalKey(keyType: AggregationKeyType, key: string) {
  return `woocommerce:${keyType}:${key}`.replace(/[^a-z0-9:@._-]+/gi, "-").slice(0, 180);
}

function fallbackEmail(keyType: AggregationKeyType, key: string) {
  return `no-email-${externalKey(keyType, key).replace(/[^a-z0-9]+/gi, "-").toLowerCase()}@woocommerce.local`.slice(0, 180);
}

function getTier(paidTotal: number, attemptedTotal: number) {
  if (paidTotal > 0) return paidTotal >= 2500 ? "Platinum" : paidTotal >= 999 ? "Gold" : paidTotal >= 200 ? "Silver" : "Bronze";
  return attemptedTotal > 0 ? "Lead" : "Cold Lead";
}

function getLeadStatus(paidTotal: number, attemptedTotal: number, attemptedOrderCount: number) {
  if (paidTotal > 0) return "customer";
  if (attemptedTotal >= 500 || attemptedOrderCount > 1) return "very_hot_lead";
  return attemptedTotal > 0 ? "hot_lead" : "cold_lead";
}

function getPaymentStatus(paidTotal: number, attemptedTotal: number, lastAttemptStatus: string, lastAttemptPaymentMethod: string) {
  if (paidTotal > 0) return "paid";
  if (attemptedTotal > 0 && lastAttemptStatus === "on-hold" && lastAttemptPaymentMethod.toLowerCase().includes("crypto")) return "crypto_on_hold";
  return attemptedTotal > 0 ? "attempted_unpaid" : "unpaid";
}

function getRiskLevel(input: Pick<CustomerScoreInput, "chargebacks" | "failedPayments" | "refunds">, score: number): "low" | "medium" | "high" {
  return (input.chargebacks > 0 || input.failedPayments > 2 || score < 45) ? "high" : (input.refunds > 1 || input.failedPayments > 0 || score < 70) ? "medium" : "low";
}

function buildRuleSummary(name: string, paidTotal: number, paidOrderCount: number, attemptedTotal: number) {
  const aiSummary = paidTotal > 0
    ? `${name} is a paid customer with ${paidOrderCount} paid orders totaling $${paidTotal.toFixed(2)}.`
    : attemptedTotal > 0
      ? "This is a hot lead who attempted checkout but has not completed payment."
      : `${name} has not completed payment yet.`;
  return {
    aiSummary,
    aiSummaryPreview: aiSummary.slice(0, 110) + (aiSummary.length > 110 ? "..." : ""),
    riskExplanation: attemptedTotal > 0 && paidTotal === 0 ? "Checkout attempt exists without completed payment." : "Payment and refund patterns do not show elevated risk.",
    recommendedAction: paidTotal > 0 ? "Review upsell, renewal, or support opportunity." : attemptedTotal > 0 ? "Call and resend secure payment link." : "Manual review.",
  };
}

function groupOrders(orders: WooCommerceOrderDocument[]) {
  const grouped = new Map<string, OrderGroup>();
  for (const order of orders) {
    const { key, keyType } = groupKeyFor(order);
    const existing = grouped.get(`${keyType}:${key}`);
    if (existing) existing.orders.push(order);
    else grouped.set(`${keyType}:${key}`, { key, keyType, orders: [order] });
  }
  return Array.from(grouped.values());
}

function buildCustomer(group: OrderGroup, rebuildAt: string) {
  const sortedStoredOrders = [...group.orders].sort((a, b) => new Date(b.dateCreated).getTime() - new Date(a.dateCreated).getTime());
  const orders = sortedStoredOrders.map(orderHistoryItemFromStoredOrder);
  const paidOrders = orders.filter((order) => order.isPaid);
  const attemptedOrders = orders.filter((order) => order.isAttempted);
  const paidTotal = paidOrders.reduce((sum, order) => sum + order.total, 0);
  const attemptedTotal = attemptedOrders.reduce((sum, order) => sum + order.total, 0);
  const latest = orders[0];
  const latestPaid = paidOrders[0];
  const latestAttempt = attemptedOrders[0];
  const first = [...orders].sort((a, b) => new Date(a.dateCreated).getTime() - new Date(b.dateCreated).getTime())[0];
  const firstPaid = [...paidOrders].sort((a, b) => new Date(a.dateCreated).getTime() - new Date(b.dateCreated).getTime())[0];
  const paidMonths = new Set(paidOrders.map((order) => (order.paidDate || order.dateCreated).slice(0, 7)).filter(Boolean)).size;
  const email = group.keyType === "email" ? group.key : sortedStoredOrders.find((order) => order.normalizedEmail)?.normalizedEmail ?? fallbackEmail(group.keyType, group.key);
  const externalCustomerKey = externalKey(group.keyType, group.key);
  const failedPayments = orders.filter((order) => ["failed", "payment_pending", "crypto_pending"].includes(order.status)).length;
  const refunds = orders.reduce((sum, order) => sum + order.refundsCount, 0);
  const baseScoreInput = {
    totalPaid: paidTotal,
    subscriptionStatus: "unknown",
    lastOrderDate: latest?.dateCreated ?? rebuildAt,
    refunds,
    chargebacks: 0,
    failedPayments,
  } satisfies CustomerScoreInput;
  const score = calculateCustomerScore(baseScoreInput);
  const productSummary = buildProductJourneySummary(orders);
  const paidProducts = unique(paidOrders.flatMap((order) => order.lineItems.map((item) => item.name)));
  const attemptedProducts = unique(attemptedOrders.flatMap((order) => order.lineItems.map((item) => item.name)));
  const summary = buildRuleSummary(latest?.billingName || email, paidTotal, paidOrders.length, attemptedTotal);
  const normalizedEmail = email.trim().toLowerCase();
  const businessInfo = resolveBusinessName({ orders }, sortedStoredOrders);

  return {
    name: latest?.billingName || email,
    email,
    normalizedEmail,
    externalCustomerKey,
    phone: latest?.billingPhone || "",
    "businessProfile.businessName": businessInfo.businessName,
    "businessProfile.company": businessInfo.businessName,
    "businessProfile.source": businessInfo.businessNameSource,
    paidTotal,
    attemptedTotal,
    totalPaid: paidTotal,
    lifetimeValue: paidTotal,
    rankingPaidTotal: paidTotal,
    wooPaidTotal: paidTotal,
    authorizeNetPaidTotal: 0,
    gatewayOnlyPaidTotal: 0,
    subscriptionPaidTotal: 0,
    orderCount: orders.length,
    paidOrderCount: paidOrders.length,
    gatewayPaidCount: 0,
    attemptedOrderCount: attemptedOrders.length,
    paidMonths: Math.max(paidMonths, paidOrders.length),
    firstPaidDate: firstPaid?.dateCreated ?? "",
    subscriptionStartDate: "",
    stayWithUsMonths: monthsSince(firstPaid?.dateCreated ?? first?.dateCreated ?? ""),
    firstOrderDate: first?.dateCreated ?? rebuildAt,
    latestOrderDate: latest?.dateCreated ?? rebuildAt,
    customerCreatedAt: first?.dateCreated ?? rebuildAt,
    latestCustomerCreatedAt: first?.dateCreated ?? rebuildAt,
    lastOrderDate: latest?.dateCreated ?? rebuildAt,
    lastPaidDate: latestPaid?.dateCreated ?? "",
    lastAttemptDate: latestAttempt?.dateCreated ?? "",
    lastOrderAmount: latest?.total ?? 0,
    averageOrderValue: paidOrders.length > 0 ? paidTotal / paidOrders.length : 0,
    subscriptionStatus: "unknown",
    activeSubscriptions: 0,
    failedPayments,
    refunds,
    chargebacks: 0,
    actualCreditLimit: null,
    estimatedCreditLimit: 0,
    tier: getTier(paidTotal, attemptedTotal),
    leadStatus: getLeadStatus(paidTotal, attemptedTotal, attemptedOrders.length),
    paymentStatus: getPaymentStatus(paidTotal, attemptedTotal, latestAttempt?.status ?? "", latestAttempt?.paymentMethodTitle || latestAttempt?.paymentMethod || ""),
    riskLevel: getRiskLevel(baseScoreInput, score),
    tags: [],
    notes: "",
    lastSyncedAt: rebuildAt,
    score,
    stars: scoreToStars(score),
    orders,
    lastProducts: unique(latest?.lineItems.map((item) => item.name) ?? []),
    attemptedProducts,
    paidProducts,
    ...productSummary,
    lastPaymentMethod: latestPaid?.paymentMethodTitle || latestPaid?.paymentMethod || "",
    lastAttemptPaymentMethod: latestAttempt?.paymentMethodTitle || latestAttempt?.paymentMethod || "",
    lastAttemptStatus: latestAttempt?.status ?? "",
    leadUrgency: paidTotal > 0 ? "customer" : attemptedTotal >= 500 ? "high" : "medium",
    recommendedContactMethod: latest?.billingPhone ? "phone" : "email",
    nextAction: summary.recommendedAction,
    gatewayVerification: {
      provider: "",
      matched: false,
      confidence: "not_found" as const,
      matchedBy: "",
      transactionId: latest?.transactionId ?? "",
      transactionStatus: "",
      amount: latest?.total ?? 0,
      transactionDate: latest?.dateCreated ?? "",
      customerVaultId: "",
      paymentProfileId: "",
      customerProfileId: "",
      paymentIntentId: "",
      chargeId: "",
      stripeCustomerId: "",
      paymentMethodId: "",
      last4: "",
      cardType: "",
      candidatesCount: 0,
      rawSummary: "",
      lastCheckedAt: "",
      configured: false,
      notes: "Customer rebuilt from stored WooCommerceOrder records. Gateway verification was not run.",
    },
    sourceCoverage: {
      deepWooSearch: false,
      ordersStored: orders.length,
      ordersStoredCount: orders.length,
      matchReasonCounts: { [group.keyType === "customerId" ? "customer_id" : group.keyType]: orders.length },
      statusCounts: countBy(orders.map((order) => order.status)),
      paymentMethodCounts: countBy(orders.map((order) => order.paymentMethodTitle || order.paymentMethod || "unknown")),
      syncStatus: "success" as const,
      lastDeepSyncAt: "",
      lastAttemptedDeepSyncAt: "",
      lastDeepSyncStatus: "",
      lastSyncedAt: rebuildAt,
      warningSummary: "",
      warnings: [],
      aggregationKey: group.key,
      aggregationKeyType: group.keyType,
      lastBackfillImportAt: sortedStoredOrders[0]?.importedAt ?? "",
      lastCustomerRebuildAt: rebuildAt,
      businessNameSource: businessInfo.businessNameSource,
    },
    ...summary,
  };
}

async function findExisting(customer: { normalizedEmail: string; externalCustomerKey: string }) {
  return Customer.findOne({ $or: [{ normalizedEmail: customer.normalizedEmail }, { email: customer.normalizedEmail }, { externalCustomerKey: customer.externalCustomerKey }] })
    .lean<CustomerDocument | null>()
    .exec();
}

export async function POST(request: Request) {
  const startedAt = new Date().toISOString();
  const body = await request.json().catch(() => ({})) as {
    from?: string;
    to?: string;
    limit?: number;
    offset?: number;
    dryRun?: boolean;
    allowReplaceWithSmallerHistory?: boolean;
  };
  const limit = safeNumber(body.limit, 50, 100);
  const offset = safeNumber(body.offset, 0, 1000000);
  const dryRun = body.dryRun === true;
  const allowReplaceWithSmallerHistory = body.allowReplaceWithSmallerHistory === true;

  const connection = await connectToDatabase();
  if (!connection) return NextResponse.json({ error: "MongoDB is unavailable.", saved: false }, { status: 503 });

  const job = await SyncJob.create({
    jobType: "rebuild_customers",
    status: "running",
    startedAt,
    progress: 0,
    totalPages: 1,
    pagesFetched: 0,
    recordsProcessed: 0,
    errors: [],
    warnings: dryRun ? ["Dry run: no Customer records were written."] : [],
    lastCursor: { page: offset, status: "orders" },
  });

  const storedOrders = await WooCommerceOrderRecord.find(dateFilter(body.from, body.to))
    .sort({ normalizedEmail: 1, normalizedPhone: 1, customerId: 1, dateCreated: 1 })
    .lean<WooCommerceOrderDocument[]>()
    .exec();
  const groups = groupOrders(storedOrders);
  const selectedGroups = groups.slice(offset, offset + limit);
  const rebuildAt = new Date().toISOString();
  const deadline = Date.now() + maxRebuildRuntimeMs;
  const warnings: string[] = [];
  let customersRebuilt = 0;
  let customersProcessed = 0;
  let customersSkippedSmallerHistory = 0;

  for (const group of selectedGroups) {
    if (Date.now() >= deadline) {
      warnings.push(`Stopped customer rebuild batch at ${customersProcessed} processed customers to stay within runtime budget.`);
      break;
    }
    const customer = buildCustomer(group, rebuildAt);
    const subscriptions = customer.normalizedEmail
      ? await WooCommerceSubscriptionRecord.find({ normalizedEmail: customer.normalizedEmail }).lean<Array<{ status?: string; startDate?: string; relatedOrderIds?: number[] }>>().exec()
      : [];
    if (subscriptions.length) {
      const activeSubscriptions = subscriptions.filter((subscription) => String(subscription.status ?? "").toLowerCase() === "active");
      const subscriptionStartDate = subscriptions.map((subscription) => subscription.startDate).filter(Boolean).sort()[0] ?? "";
      const relatedOrderIds = new Set(subscriptions.flatMap((subscription) => subscription.relatedOrderIds ?? []).map(String));
      customer.activeSubscriptions = activeSubscriptions.length;
      customer.subscriptionStatus = activeSubscriptions.length ? "active" : "inactive";
      customer.subscriptionStartDate = subscriptionStartDate;
      customer.firstPaidDate = [subscriptionStartDate, customer.firstPaidDate].filter(Boolean).sort()[0] ?? customer.firstPaidDate;
      customer.stayWithUsMonths = monthsSince(customer.firstPaidDate || subscriptionStartDate || customer.firstOrderDate);
      customer.subscriptionPaidTotal = group.orders.reduce((sum, order) => {
        if (!order.isPaid) return sum;
        return relatedOrderIds.has(String(order.wooOrderId)) || relatedOrderIds.has(String(order.orderNumber)) ? sum + Number(order.paidAmount ?? order.total ?? 0) : sum;
      }, 0);
    }
    const existing = await findExisting(customer);
    const recurring = detectAuthorizeNetRecurring(customerLedgerRecords({ ...customer, gatewayPayments: existing?.gatewayPayments ?? [] }));
    Object.assign(customer, {
      isGatewayRecurring: recurring.isGatewayRecurring,
      recurringSource: recurring.recurringSource,
      recurringAmount: recurring.recurringAmount,
      recurringFrequencyEstimate: recurring.recurringFrequencyEstimate,
      recurringLastPayment: recurring.recurringLastPayment,
      recurringNextEstimatedPayment: recurring.recurringNextEstimatedPayment,
      recurringPaymentCount: recurring.recurringPaymentCount,
    });
    customersProcessed += 1;
    const existingOrderCount = existing?.orders?.length ?? existing?.orderCount ?? 0;
    if (!allowReplaceWithSmallerHistory && existingOrderCount > customer.orders.length) {
      customersSkippedSmallerHistory += 1;
      warnings.push(`${customer.email}: skipped smaller rebuilt history (${customer.orders.length} < ${existingOrderCount}).`);
      continue;
    }
    customersRebuilt += 1;
    if (!dryRun) {
      await Customer.findOneAndUpdate(
        { $or: [{ normalizedEmail: customer.normalizedEmail }, { email: customer.normalizedEmail }, { externalCustomerKey: customer.externalCustomerKey }] },
        { $set: customer },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      ).exec();
    }
  }

  const nextOffset = offset + customersProcessed;
  const hasMore = nextOffset < groups.length;
  const remainingRuntimeMs = Math.max(500, deadline - Date.now());
  let creditProfilesUpdated = 0;
  if (remainingRuntimeMs > 500) {
    try {
      const creditResult = await importWordPressCreditBatch({ limit: Math.min(limit, 25), offset, dryRun, maxRuntimeMs: remainingRuntimeMs });
      creditProfilesUpdated = dryRun ? 0 : creditResult.updatedProfiles;
      warnings.push(...creditResult.warnings);
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : "WordPress credit sync failed during rebuild batch.");
    }
  }
  const finalStatus = warnings.length > 0 || hasMore ? "partial" : "completed";
  await SyncJob.updateOne(
    { _id: job._id },
    {
      $set: {
        status: finalStatus,
        finishedAt: new Date().toISOString(),
        progress: 100,
        pagesFetched: 1,
        recordsProcessed: customersProcessed,
        warnings,
        lastCursor: { page: nextOffset, status: hasMore ? "orders" : "complete" },
      },
    }
  );
  const rebuiltCount = dryRun ? 0 : customersRebuilt;
  const matchedCount = dryRun ? customersRebuilt : 0;
  const batchMessage = hasMore
    ? `Processed ${customersProcessed} customers. Continue update to process next batch.`
    : `Processed ${customersProcessed} customers. Customer profile rebuild batch is complete.`;

  return NextResponse.json({
    jobId: String(job._id),
    dryRun,
    from: body.from ?? "",
    to: body.to ?? "",
    limit,
    offset,
    totalOrderRecords: storedOrders.length,
    totalCustomerGroups: groups.length,
    customersConsidered: selectedGroups.length,
    customersProcessed,
    customersRebuilt: rebuiltCount,
    dryRunCustomersMatched: matchedCount,
    customersSkippedSmallerHistory,
    creditProfilesUpdated,
    hasMore,
    nextOffset,
    partialSync: finalStatus === "partial",
    warnings,
    message: batchMessage,
  });
}

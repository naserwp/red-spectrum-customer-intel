import { calculateCustomerScore, scoreToStars, type CustomerScoreInput } from "@/lib/customerScore";
import { calculateCustomerValueMetrics } from "@/lib/customerValue";
import { extractBestBusinessContactFields } from "@/lib/customerContactFields";
import { enrichCustomerProfile } from "@/lib/customerEnrichment";
import { computeFundingIntelligence } from "@/lib/fundingIntelligence";
import { buildProductJourneySummary } from "@/lib/productClassification";
import { fetchWooCommerceOrderById, fetchWooCommerceOrders, isWooCommerceConfigured, wooCommerceOrderStatuses, type WooCommerceOrder } from "@/lib/woocommerce";
import { countBy, normalizeText, normalizeWooOrder, orderHistoryItemFromStoredOrder, unique } from "@/lib/wooOrderImport";
import { AuthorizeNetTransaction, type AuthorizeNetTransactionDocument } from "@/models/AuthorizeNetTransaction";
import { Customer, type CustomerDocument } from "@/models/Customer";
import { CustomerRanking, type CustomerRankingDocument } from "@/models/CustomerRanking";
import { NmiQuickPayTransaction, type NmiQuickPayTransactionDocument } from "@/models/NmiQuickPayTransaction";
import { StripeTransaction, type StripeTransactionDocument } from "@/models/StripeTransaction";
import { SyncJob } from "@/models/SyncJob";
import { WooCommerceOrderRecord, type WooCommerceOrderDocument } from "@/models/WooCommerceOrder";
import { WooCommerceSubscriptionRecord, type WooCommerceSubscriptionDocument } from "@/models/WooCommerceSubscription";

type LeanCustomer = Partial<CustomerDocument> & { _id: unknown };

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function normalizeEmail(value: unknown) {
  return clean(value).toLowerCase();
}

function addressKey(order: WooCommerceOrderDocument) {
  return normalizeText(`${order.billingAddress?.address1 ?? ""} ${order.billingAddress?.postcode ?? ""}`);
}

function groupKeyFor(order: WooCommerceOrderDocument) {
  if (order.normalizedEmail) return { key: order.normalizedEmail, type: "email" };
  if (order.normalizedPhone) return { key: order.normalizedPhone, type: "phone" };
  if (order.customerId) return { key: String(order.customerId), type: "customerId" };
  return { key: `${order.normalizedCompany || "company"}:${normalizeText(order.billingName)}:${addressKey(order)}`, type: "company" };
}

function externalKey(type: string, key: string) {
  return `woocommerce:${type}:${key}`.replace(/[^a-z0-9:@._-]+/gi, "-").slice(0, 180);
}

function fallbackEmail(type: string, key: string) {
  return `no-email-${externalKey(type, key).replace(/[^a-z0-9]+/gi, "-").toLowerCase()}@woocommerce.local`.slice(0, 180);
}

function buildCustomerSet(group: { key: string; type: string; orders: WooCommerceOrderDocument[] }, existing: LeanCustomer | null, ranking: CustomerRankingDocument | null, rebuildAt: string) {
  const sorted = [...group.orders].sort((a, b) => new Date(b.dateCreated).getTime() - new Date(a.dateCreated).getTime());
  const history = sorted.map(orderHistoryItemFromStoredOrder);
  const paidOrders = history.filter((order) => order.isPaid);
  const attemptedOrders = history.filter((order) => order.isAttempted);
  const latest = history[0];
  const latestPaid = paidOrders[0];
  const latestAttempt = attemptedOrders[0];
  const first = [...history].sort((a, b) => new Date(a.dateCreated).getTime() - new Date(b.dateCreated).getTime())[0];
  const firstPaid = [...paidOrders].sort((a, b) => new Date(a.dateCreated).getTime() - new Date(b.dateCreated).getTime())[0];
  const email = group.type === "email" ? group.key : sorted.find((order) => order.normalizedEmail)?.normalizedEmail || fallbackEmail(group.type, group.key);
  const productSummary = buildProductJourneySummary(history);
  const failedPayments = history.filter((order) => ["failed", "payment_pending", "crypto_pending"].includes(order.status)).length;
  const refunds = history.reduce((sum, order) => sum + order.refundsCount, 0);
  const scoreInput = {
    totalPaid: paidOrders.reduce((sum, order) => sum + order.total, 0),
    subscriptionStatus: existing?.subscriptionStatus || "unknown",
    lastOrderDate: latest?.dateCreated ?? rebuildAt,
    refunds,
    chargebacks: Number(existing?.chargebacks ?? 0),
    failedPayments,
  } satisfies CustomerScoreInput;
  const score = calculateCustomerScore(scoreInput);
  const baseCustomer = {
    ...(existing ?? {}),
    name: latest?.billingName || existing?.name || email,
    email: existing?.email || email,
    normalizedEmail: normalizeEmail(existing?.normalizedEmail || existing?.email || email),
    phone: latest?.billingPhone || existing?.phone || "",
    orders: history,
    orderCount: history.length,
    paidOrderCount: paidOrders.length,
    attemptedOrderCount: attemptedOrders.length,
    failedPayments,
    refunds,
    firstOrderDate: first?.dateCreated ?? existing?.firstOrderDate ?? rebuildAt,
    latestOrderDate: latest?.dateCreated ?? existing?.latestOrderDate ?? rebuildAt,
    customerCreatedAt: existing?.customerCreatedAt || first?.dateCreated || rebuildAt,
    latestCustomerCreatedAt: existing?.latestCustomerCreatedAt || first?.dateCreated || rebuildAt,
    lastOrderDate: latest?.dateCreated ?? existing?.lastOrderDate ?? rebuildAt,
    lastPaidDate: latestPaid?.dateCreated ?? existing?.lastPaidDate ?? "",
    lastAttemptDate: latestAttempt?.dateCreated ?? existing?.lastAttemptDate ?? "",
    lastOrderAmount: latest?.total ?? existing?.lastOrderAmount ?? 0,
    paidProducts: unique(paidOrders.flatMap((order) => order.lineItems.map((item) => item.name))),
    attemptedProducts: unique(attemptedOrders.flatMap((order) => order.lineItems.map((item) => item.name))),
    lastProducts: unique(latest?.lineItems.map((item) => item.name) ?? []),
    ...productSummary,
  } as Partial<CustomerDocument>;
  const contact = extractBestBusinessContactFields(baseCustomer, ranking, sorted);
  const set: Record<string, unknown> = {
    name: baseCustomer.name,
    email: baseCustomer.email,
    normalizedEmail: baseCustomer.normalizedEmail,
    emailNormalized: baseCustomer.normalizedEmail,
    phone: baseCustomer.phone,
    phoneNormalized: clean(baseCustomer.phone).replace(/\D/g, ""),
    externalCustomerKey: existing?.externalCustomerKey || externalKey(group.type, group.key),
    orders: history,
    orderCount: history.length,
    paidOrderCount: paidOrders.length,
    attemptedOrderCount: attemptedOrders.length,
    paidMonths: Math.max(new Set(paidOrders.map((order) => (order.paidDate || order.dateCreated).slice(0, 7)).filter(Boolean)).size, paidOrders.length),
    firstPaidDate: firstPaid?.dateCreated ?? existing?.firstPaidDate ?? "",
    firstOrderDate: baseCustomer.firstOrderDate,
    latestOrderDate: baseCustomer.latestOrderDate,
    customerCreatedAt: baseCustomer.customerCreatedAt,
    latestCustomerCreatedAt: baseCustomer.latestCustomerCreatedAt,
    lastOrderDate: baseCustomer.lastOrderDate,
    lastPaidDate: baseCustomer.lastPaidDate,
    lastAttemptDate: baseCustomer.lastAttemptDate,
    lastOrderAmount: baseCustomer.lastOrderAmount,
    averageOrderValue: paidOrders.length ? paidOrders.reduce((sum, order) => sum + order.total, 0) / paidOrders.length : 0,
    failedPayments,
    refunds,
    score,
    stars: scoreToStars(score),
    lastProducts: baseCustomer.lastProducts,
    attemptedProducts: baseCustomer.attemptedProducts,
    paidProducts: baseCustomer.paidProducts,
    ...productSummary,
    lastPaymentMethod: latestPaid?.paymentMethodTitle || latestPaid?.paymentMethod || "",
    lastAttemptPaymentMethod: latestAttempt?.paymentMethodTitle || latestAttempt?.paymentMethod || "",
    lastAttemptStatus: latestAttempt?.status ?? "",
    lastSyncedAt: rebuildAt,
    "businessProfile.businessName": contact.businessName || existing?.businessProfile?.businessName || "",
    "businessProfile.company": contact.businessName || existing?.businessProfile?.company || "",
    "businessProfile.businessNameSource": contact.businessNameSource || existing?.businessProfile?.businessNameSource || "",
    "businessProfile.address1": contact.address1 || existing?.businessProfile?.address1 || "",
    "businessProfile.address2": contact.address2 || existing?.businessProfile?.address2 || "",
    "businessProfile.city": contact.city || existing?.businessProfile?.city || "",
    "businessProfile.state": contact.state || existing?.businessProfile?.state || "",
    "businessProfile.stateCode": contact.state || existing?.businessProfile?.stateCode || "",
    "businessProfile.zip": contact.zip || existing?.businessProfile?.zip || "",
    "businessProfile.country": contact.country || existing?.businessProfile?.country || "",
    "businessProfile.phone": contact.phoneNumber || existing?.businessProfile?.phone || "",
    "businessProfile.email": contact.email || existing?.businessProfile?.email || email,
    "businessProfile.ein": contact.ein || existing?.businessProfile?.ein || "",
    "sourceCoverage.lastWooLiveSyncAt": rebuildAt,
    "sourceCoverage.liveWooSyncOrderIds": sorted.slice(0, 20).map((order) => order.wooOrderId),
    "sourceCoverage.businessFieldsSource": contact.fieldSources,
    "sourceCoverage.lastCustomerRebuildAt": rebuildAt,
    "sourceCoverage.lastSyncedAt": rebuildAt,
    "sourceCoverage.wooCommerceOrderRecordsFound": sorted.length,
    "sourceCoverage.ordersStored": history.length,
    "sourceCoverage.ordersStoredCount": history.length,
    "sourceCoverage.syncStatus": "success",
    "sourceCoverage.aggregationKey": group.key,
    "sourceCoverage.aggregationKeyType": group.type,
    "sourceCoverage.statusCounts": countBy(history.map((order) => order.status)),
    "sourceCoverage.paymentMethodCounts": countBy(history.map((order) => order.paymentMethodTitle || order.paymentMethod || "unknown")),
  };
  return { set, contact, baseCustomer: { ...baseCustomer, ...set } as Partial<CustomerDocument> };
}

async function rankingSetFor(customer: LeanCustomer, ranking: CustomerRankingDocument | null, orders: WooCommerceOrderDocument[], contact: ReturnType<typeof extractBestBusinessContactFields>, rebuildAt: string) {
  const email = normalizeEmail(customer.normalizedEmail || customer.email);
  const [subscriptions, authTransactions, nmiTransactions, stripeTransactions] = await Promise.all([
    WooCommerceSubscriptionRecord.find({ normalizedEmail: email }).lean<WooCommerceSubscriptionDocument[]>(),
    AuthorizeNetTransaction.find({ $or: [{ normalizedEmail: email }, { emailNormalized: email }, { customerEmail: email }, { matchedCustomerId: String(customer._id) }] }).lean<AuthorizeNetTransactionDocument[]>(),
    NmiQuickPayTransaction.find({ $or: [{ normalizedEmail: email }, { emailNormalized: email }, { customerEmail: email }, { matchedCustomerId: String(customer._id) }] }).lean<NmiQuickPayTransactionDocument[]>(),
    StripeTransaction.find({ $or: [{ normalizedEmail: email }, { emailNormalized: email }, { email }, { matchedCustomerId: String(customer._id) }] }).lean<StripeTransactionDocument[]>(),
  ]);
  const metrics = calculateCustomerValueMetrics({ customer, wooOrders: orders, authorizeNetTransactions: authTransactions, nmiTransactions, stripeTransactions, subscriptions });
  const enrichment = enrichCustomerProfile({ ...customer, latestWooOrder: orders[0] });
  const funding = computeFundingIntelligence(customer, ranking);
  return {
    name: customer.name || "",
    email: customer.email || email,
    phone: contact.phoneNumber || customer.phone || "",
    businessName: contact.businessName || enrichment.businessName || "",
    businessNameSource: contact.businessNameSource || enrichment.businessNameSource || "",
    businessNameConfidence: enrichment.businessNameConfidence || "",
    businessAddress: contact.businessAddress,
    address1: contact.address1,
    address2: contact.address2,
    city: contact.city,
    stateCode: contact.state || enrichment.stateCode || "",
    stateName: enrichment.stateName || "",
    stateSource: contact.fieldSources.state || enrichment.stateSource || "",
    stateConfidence: enrichment.stateConfidence || "",
    zip: contact.zip,
    country: contact.country,
    ein: contact.ein,
    contactFieldSources: contact.fieldSources,
    enrichmentSource: enrichment.enrichmentSource || "",
    lifetimeSpent: metrics.rankingTotal,
    periodSpent: metrics.rankingTotal,
    monthlySpent: metrics.rankingTotal,
    yearlySpent: metrics.rankingTotal,
    wooPaidTotal: metrics.wooPaidTotal,
    authorizeNetPaidTotal: metrics.authorizeNetPaidTotal,
    nmiQuickPayPaidTotal: metrics.nmiQuickPayPaidTotal,
    stripePaidTotal: metrics.stripePaidTotal,
    gatewayOnlyPaidTotal: metrics.gatewayOnlyPaidTotal,
    paidMonths: metrics.paidMonths,
    firstPaidDate: metrics.firstPaidDate || customer.firstPaidDate || "",
    latestPaidDate: metrics.lastPaidDate || customer.lastPaidDate || "",
    activeSubscriptionCount: Number(customer.activeSubscriptions ?? 0) + (customer.isGatewayRecurring ? 1 : 0),
    estimatedMRR: Number(customer.recurringAmount ?? 0),
    stayWithUsMonths: metrics.stayWithUsMonths,
    attemptedPipeline: metrics.attemptedTotal,
    category: metrics.rankingTotal >= 2000 ? "VIP Paid Customer" : metrics.rankingTotal > 0 ? "Paying Customer" : metrics.attemptedTotal > 0 ? "Hot Lead" : "Cold Lead",
    fundingScore: funding.fundingScore,
    fundingCategory: funding.fundingCategory,
    recommendedFundingProducts: funding.recommendedFundingProducts,
    fundingStrengths: funding.fundingStrengths,
    fundingWeaknesses: funding.fundingWeaknesses,
    nextBestAction: funding.nextBestAction,
    fundingScoreBreakdown: funding.scoreBreakdown,
    generatedAt: rebuildAt,
    lastVerifiedAt: rebuildAt,
  };
}

export async function importRecentWooOrders({ hours = 48, maxPages = 3, orderIds = [] as Array<string | number> } = {}) {
  if (!isWooCommerceConfigured()) return { error: "WooCommerce is not configured.", importedOrderIds: [] as number[], fetched: [] as WooCommerceOrder[], warning: "" };
  const importedAt = new Date().toISOString();
  const after = new Date(Date.now() - Math.max(1, hours) * 60 * 60 * 1000).toISOString();
  const recent = await fetchWooCommerceOrders({ statuses: wooCommerceOrderStatuses, perPage: 100, maxPages, after, before: new Date().toISOString() });
  const direct = (await Promise.all(orderIds.map((id) => fetchWooCommerceOrderById(id)))).filter((order): order is WooCommerceOrder => Boolean(order));
  const fetched = Array.from(new Map([...(recent?.items ?? []), ...direct].map((order) => [Number(order.id), order])).values());
  if (fetched.length) {
    await WooCommerceOrderRecord.bulkWrite(fetched.map((order) => ({
      updateOne: { filter: { wooOrderId: Number(order.id) }, update: { $set: normalizeWooOrder(order, importedAt) }, upsert: true },
    })), { ordered: false });
  }
  return { importedAt, importedOrderIds: fetched.map((order) => Number(order.id)), fetched, warning: recent?.warning ?? "" };
}

export async function rebuildCustomersForWooOrderIds(orderIds: number[]) {
  const rebuildAt = new Date().toISOString();
  const seedOrders = await WooCommerceOrderRecord.find({ wooOrderId: { $in: orderIds } }).lean<WooCommerceOrderDocument[]>();
  const groups = new Map<string, { key: string; type: string; orders: WooCommerceOrderDocument[] }>();
  for (const order of seedOrders) {
    const group = groupKeyFor(order);
    const groupKey = `${group.type}:${group.key}`;
    if (!groups.has(groupKey)) {
      const query = group.type === "email" ? { normalizedEmail: group.key } : group.type === "phone" ? { normalizedPhone: group.key } : group.type === "customerId" ? { customerId: Number(group.key) } : { normalizedCompany: order.normalizedCompany, billingName: order.billingName };
      const orders = await WooCommerceOrderRecord.find(query).sort({ dateCreated: -1 }).lean<WooCommerceOrderDocument[]>();
      groups.set(groupKey, { ...group, orders });
    }
  }
  let customersUpdated = 0;
  let rankingsUpdated = 0;
  const affectedEmails: string[] = [];
  for (const group of groups.values()) {
    const latestEmail = group.type === "email" ? group.key : group.orders.find((order) => order.normalizedEmail)?.normalizedEmail || "";
    const existing = await Customer.findOne({ $or: [{ normalizedEmail: latestEmail }, { email: latestEmail }, { externalCustomerKey: externalKey(group.type, group.key) }] }).lean<LeanCustomer | null>();
    const ranking = existing ? await CustomerRanking.findOne({ customerId: String(existing._id) }).lean<CustomerRankingDocument | null>() : null;
    const { set, contact } = buildCustomerSet(group, existing, ranking, rebuildAt);
    const updated = await Customer.findOneAndUpdate(
      { $or: [{ normalizedEmail: latestEmail }, { email: latestEmail }, { externalCustomerKey: externalKey(group.type, group.key) }] },
      { $set: set },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean<LeanCustomer | null>();
    if (!updated) continue;
    customersUpdated += 1;
    affectedEmails.push(normalizeEmail(updated.normalizedEmail || updated.email));
    const currentRanking = await CustomerRanking.findOne({ customerId: String(updated._id) }).lean<CustomerRankingDocument | null>();
    const rankingSet = await rankingSetFor(updated, currentRanking, group.orders, contact, rebuildAt);
    await Customer.updateOne({ _id: updated._id }, {
      $set: {
        lifetimeValue: rankingSet.lifetimeSpent,
        rankingPaidTotal: rankingSet.lifetimeSpent,
        paidTotal: rankingSet.wooPaidTotal,
        totalPaid: rankingSet.wooPaidTotal,
        wooPaidTotal: rankingSet.wooPaidTotal,
        authorizeNetPaidTotal: rankingSet.authorizeNetPaidTotal,
        nmiQuickPayPaidTotal: rankingSet.nmiQuickPayPaidTotal,
        gatewayOnlyPaidTotal: rankingSet.gatewayOnlyPaidTotal,
        paidMonths: rankingSet.paidMonths,
        firstPaidDate: rankingSet.firstPaidDate,
        lastPaidDate: rankingSet.latestPaidDate,
        sourceCoverage: {
          ...updated.sourceCoverage,
          ...(set.sourceCoverage as Record<string, unknown> | undefined),
          lastCustomerRebuildAt: rebuildAt,
          lastWooLiveSyncAt: rebuildAt,
        },
      },
    });
    await CustomerRanking.updateOne({ customerId: String(updated._id) }, { $set: { customerId: String(updated._id), ...rankingSet } }, { upsert: true });
    rankingsUpdated += 1;
  }
  await SyncJob.create({
    jobType: "automatic_batch_sync",
    status: "completed",
    startedAt: rebuildAt,
    finishedAt: new Date().toISOString(),
    progress: 100,
    totalPages: 1,
    pagesFetched: 1,
    recordsProcessed: orderIds.length + customersUpdated + rankingsUpdated,
    errors: [],
    warnings: [],
    lastCursor: { page: 1, status: "live_woocommerce_recent" },
  });
  return { customersUpdated, rankingsUpdated, affectedEmails: Array.from(new Set(affectedEmails)), rebuiltAt: rebuildAt };
}

export async function syncRecentWooCommerce(options: { hours?: number; maxPages?: number; orderIds?: Array<string | number> } = {}) {
  const imported = await importRecentWooOrders(options);
  if (imported.error) return { ...imported, customersUpdated: 0, rankingsUpdated: 0, affectedEmails: [] as string[] };
  const rebuilt = await rebuildCustomersForWooOrderIds(imported.importedOrderIds);
  return { ...imported, ...rebuilt };
}

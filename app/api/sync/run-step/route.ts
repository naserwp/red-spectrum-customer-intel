import { NextResponse } from "next/server";
import { isAuthorizeNetConfigured, fetchSettledBatchIds, fetchTransactionDetails, fetchTransactionIdsForBatch, fetchUnsettledTransactionIds, normalizeAuthorizeNetTransaction } from "@/lib/authorizeNet";
import { reconcileAuthorizeNetTransaction } from "@/lib/authorizeNetReconciliation";
import { rebuildAnalyticsCacheBatch } from "@/lib/analyticsCache";
import { calculateCustomerScore, scoreToStars, type CustomerScoreInput } from "@/lib/customerScore";
import { monthsSince } from "@/lib/customerValue";
import { customerLedgerRecords, detectAuthorizeNetRecurring } from "@/lib/revenueAnalytics";
import { buildProductJourneySummary } from "@/lib/productClassification";
import { connectToDatabase } from "@/lib/mongodb";
import { fetchWooCommerceOrders, fetchWooCommerceSubscriptions, isWooCommerceConfigured, wooCommerceOrderStatuses, wooCommerceSubscriptionStatuses } from "@/lib/woocommerce";
import { deriveCustomerCreditLimits, fetchProfileUsersWithFallback, isWooCommerceCustomerFallbackConfigured, isWordPressProfileImportConfigured, mergeBusinessProfile } from "@/lib/wordpressProfiles";
import { importWordPressCreditBatch } from "@/lib/wordpressCreditSync";
import { fetchNmiTransactions, isNmiConfigured, normalizeNmiPaymentEvent } from "@/lib/nmiQuickPay";
import { reconcileNmiTransaction } from "@/lib/nmiReconciliation";
import { countBy, normalizeWooOrder, orderHistoryItemFromStoredOrder, unique } from "@/lib/wooOrderImport";
import { normalizeWooSubscription } from "@/lib/wooSubscriptionImport";
import { AuthorizeNetTransaction, type AuthorizeNetTransactionDocument } from "@/models/AuthorizeNetTransaction";
import { Customer } from "@/models/Customer";
import { NmiQuickPayTransaction, type NmiQuickPayTransactionDocument } from "@/models/NmiQuickPayTransaction";
import { PaymentEvent, type PaymentEventDocument } from "@/models/PaymentEvent";
import { SyncJob } from "@/models/SyncJob";
import { WooCommerceOrderRecord, type WooCommerceOrderDocument } from "@/models/WooCommerceOrder";
import { WooCommerceSubscriptionRecord } from "@/models/WooCommerceSubscription";

export const dynamic = "force-dynamic";

const orderPerPage = 25;
const subscriptionPerPage = 25;
const rebuildLimit = 50;
const authNetLimit = 10;
const reconcileLimit = 50;
const wordpressProfileLimit = 25;
const wordpressCreditLimit = 25;

type SyncCursor = {
  phase?: "orders" | "customers" | "subscriptions" | "wordpress_profiles" | "wordpress_credit_records" | "authorize_net_import" | "authorize_net_reconcile" | "nmi_import" | "nmi_reconcile" | "analytics" | "done";
  orderStatusIndex?: number;
  orderPage?: number;
  rebuildOffset?: number;
  subscriptionStatusIndex?: number;
  subscriptionPage?: number;
  authorizeNetOffset?: number;
  authorizeNetBatchOffset?: number;
  reconcileOffset?: number;
  nmiOffset?: number;
  nmiReconcileOffset?: number;
  wordpressProfileOffset?: number;
  wordpressCreditOffset?: number;
  analyticsOffset?: number;
  completedSteps?: string[];
};

function nextCursor(cursor: SyncCursor, patch: SyncCursor): SyncCursor {
  return { ...cursor, ...patch, completedSteps: Array.from(new Set([...(cursor.completedSteps ?? []), ...(patch.completedSteps ?? [])])) };
}

function dateInput(value: unknown, fallback: string) {
  const date = new Date(String(value ?? fallback));
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString().slice(0, 10);
}

function fallbackEmail(key: string) {
  return `no-email-${key.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}@woocommerce.local`.slice(0, 180);
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildCustomerFromOrders(key: string, orders: WooCommerceOrderDocument[], rebuildAt: string) {
  const sorted = [...orders].sort((a, b) => new Date(b.dateCreated).getTime() - new Date(a.dateCreated).getTime());
  const history = sorted.map(orderHistoryItemFromStoredOrder);
  const paidOrders = history.filter((order) => order.isPaid);
  const attemptedOrders = history.filter((order) => order.isAttempted);
  const paidTotal = paidOrders.reduce((sum, order) => sum + order.total, 0);
  const attemptedTotal = attemptedOrders.reduce((sum, order) => sum + order.total, 0);
  const latest = history[0];
  const latestPaid = paidOrders[0];
  const latestAttempt = attemptedOrders[0];
  const first = [...history].sort((a, b) => new Date(a.dateCreated).getTime() - new Date(b.dateCreated).getTime())[0];
  const firstPaid = [...paidOrders].sort((a, b) => new Date(a.dateCreated).getTime() - new Date(b.dateCreated).getTime())[0];
  const paidMonths = new Set(paidOrders.map((order) => (order.paidDate || order.dateCreated).slice(0, 7)).filter(Boolean)).size;
  const email = sorted.find((order) => order.normalizedEmail)?.normalizedEmail || fallbackEmail(key);
  const failedPayments = history.filter((order) => ["failed", "payment_pending", "crypto_pending"].includes(order.status)).length;
  const refunds = history.reduce((sum, order) => sum + order.refundsCount, 0);
  const scoreInput = {
    totalPaid: paidTotal,
    subscriptionStatus: "unknown",
    lastOrderDate: latest?.dateCreated ?? rebuildAt,
    refunds,
    chargebacks: 0,
    failedPayments,
  } satisfies CustomerScoreInput;
  const score = calculateCustomerScore(scoreInput);
  const productSummary = buildProductJourneySummary(history);
  const paidProducts = unique(paidOrders.flatMap((order) => order.lineItems.map((item) => item.name)));
  const attemptedProducts = unique(attemptedOrders.flatMap((order) => order.lineItems.map((item) => item.name)));
  const name = latest?.billingName || email;
  return {
    name,
    email,
    normalizedEmail: email.toLowerCase(),
    externalCustomerKey: `woocommerce:auto:${key}`.slice(0, 180),
    phone: latest?.billingPhone || "",
    paidTotal,
    totalPaid: paidTotal,
    lifetimeValue: paidTotal,
    rankingPaidTotal: paidTotal,
    wooPaidTotal: paidTotal,
    authorizeNetPaidTotal: 0,
    gatewayOnlyPaidTotal: 0,
    subscriptionPaidTotal: 0,
    attemptedTotal,
    orderCount: history.length,
    paidOrderCount: paidOrders.length,
    gatewayPaidCount: 0,
    attemptedOrderCount: attemptedOrders.length,
    paidMonths: Math.max(paidMonths, paidOrders.length),
    firstPaidDate: firstPaid?.dateCreated ?? "",
    subscriptionStartDate: "",
    stayWithUsMonths: monthsSince(firstPaid?.dateCreated ?? first?.dateCreated ?? ""),
    firstOrderDate: first?.dateCreated ?? rebuildAt,
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
    estimatedCreditLimit: 0,
    actualCreditLimit: null,
    tier: paidTotal >= 2500 ? "Platinum" : paidTotal >= 999 ? "Gold" : paidTotal > 0 ? "Bronze" : "Lead",
    leadStatus: paidTotal > 0 ? "customer" : attemptedTotal > 0 ? "hot_lead" : "cold_lead",
    paymentStatus: paidTotal > 0 ? "paid" : attemptedTotal > 0 ? "attempted_unpaid" : "unpaid",
    riskLevel: failedPayments > 2 || score < 45 ? "high" : failedPayments > 0 || score < 70 ? "medium" : "low",
    tags: [],
    notes: "",
    lastSyncedAt: rebuildAt,
    score,
    stars: scoreToStars(score),
    orders: history,
    lastProducts: unique(latest?.lineItems.map((item) => item.name) ?? []),
    attemptedProducts,
    paidProducts,
    ...productSummary,
    lastPaymentMethod: latestPaid?.paymentMethodTitle || latestPaid?.paymentMethod || "",
    lastAttemptPaymentMethod: latestAttempt?.paymentMethodTitle || latestAttempt?.paymentMethod || "",
    lastAttemptStatus: latestAttempt?.status ?? "",
    aiSummary: paidTotal > 0 ? `${name} is a paid customer with ${paidOrders.length} paid orders totaling $${paidTotal.toFixed(2)}.` : "This is a lead with checkout activity.",
    aiSummaryPreview: paidTotal > 0 ? `${name} is a paid customer with ${paidOrders.length} paid orders.` : "Lead with checkout activity.",
    riskExplanation: "Customer rebuilt from stored WooCommerce orders.",
    recommendedAction: paidTotal > 0 ? "Review upsell, renewal, or support opportunity." : "Call and resend secure payment link.",
    sourceCoverage: {
      ordersStored: history.length,
      ordersStoredCount: history.length,
      matchReasonCounts: { auto_batch: history.length },
      statusCounts: countBy(history.map((order) => order.status)),
      paymentMethodCounts: countBy(history.map((order) => order.paymentMethodTitle || order.paymentMethod || "unknown")),
      syncStatus: "success",
      lastSyncedAt: rebuildAt,
      lastCustomerRebuildAt: rebuildAt,
      warningSummary: "",
      warnings: [],
    },
  };
}

async function importOrderStep(cursor: SyncCursor) {
  if (!isWooCommerceConfigured()) return { cursor: nextCursor(cursor, { phase: "customers", completedSteps: ["orders"] }), warning: "WooCommerce is not configured." };
  const statusIndex = cursor.orderStatusIndex ?? 0;
  const status = wooCommerceOrderStatuses[statusIndex];
  if (!status) return { cursor: nextCursor(cursor, { phase: "customers", completedSteps: ["orders"] }), warning: "" };
  const page = cursor.orderPage ?? 1;
  const result = await fetchWooCommerceOrders({ statuses: [status], perPage: orderPerPage, maxPages: 1, page });
  const importedAt = new Date().toISOString();
  let ordersImported = 0;
  if (result?.items.length) {
    const write = await WooCommerceOrderRecord.bulkWrite(result.items.map((order) => ({
      updateOne: { filter: { wooOrderId: Number(order.id) }, update: { $set: normalizeWooOrder(order, importedAt) }, upsert: true },
    })), { ordered: false });
    ordersImported = write.upsertedCount + write.modifiedCount;
  }
  const doneStatus = !result || result.items.length < orderPerPage;
  const next = doneStatus
    ? nextCursor(cursor, { phase: "orders", orderStatusIndex: statusIndex + 1, orderPage: 1, completedSteps: statusIndex + 1 >= wooCommerceOrderStatuses.length ? ["orders"] : [] })
    : nextCursor(cursor, { phase: "orders", orderStatusIndex: statusIndex, orderPage: page + 1 });
  if ((next.orderStatusIndex ?? 0) >= wooCommerceOrderStatuses.length) next.phase = "customers";
  return { cursor: next, ordersImported, label: `Importing WooCommerce orders ${status} page ${page}...`, warning: result?.warning ?? "" };
}

async function rebuildCustomerStep(cursor: SyncCursor) {
  const offset = cursor.rebuildOffset ?? 0;
  const groups = await WooCommerceOrderRecord.aggregate<{ _id: string; ids: unknown[] }>([
    { $addFields: { syncGroupKey: { $ifNull: ["$normalizedEmail", { $concat: ["phone:", "$normalizedPhone"] }] } } },
    { $group: { _id: "$syncGroupKey", ids: { $push: "$_id" } } },
    { $sort: { _id: 1 } },
    { $skip: offset },
    { $limit: rebuildLimit },
  ]);
  const rebuildAt = new Date().toISOString();
  let customersUpdated = 0;
  for (const group of groups) {
    const orders = await WooCommerceOrderRecord.find({ _id: { $in: group.ids } }).sort({ dateCreated: -1 }).lean<WooCommerceOrderDocument[]>();
    if (!orders.length) continue;
    const customer = buildCustomerFromOrders(group._id, orders, rebuildAt);
    const existingFull = await Customer.findOne({ $or: [{ normalizedEmail: customer.normalizedEmail }, { email: customer.normalizedEmail }, { externalCustomerKey: customer.externalCustomerKey }] }, { gatewayPayments: 1, orders: 1, orderCount: 1 }).lean<{ gatewayPayments?: []; orders?: []; orderCount?: number } | null>();
    const subscriptions = customer.normalizedEmail
      ? await WooCommerceSubscriptionRecord.find({ normalizedEmail: customer.normalizedEmail }).lean<Array<{ status?: string; startDate?: string; lastPaymentDate?: string; relatedOrderIds?: number[]; amount?: number }>>()
      : [];
    const activeSubscriptions = subscriptions.filter((subscription) => String(subscription.status ?? "").toLowerCase() === "active");
    const subscriptionStartDate = subscriptions.map((subscription) => subscription.startDate).filter(Boolean).sort()[0] ?? "";
    const relatedOrderIds = new Set(subscriptions.flatMap((subscription) => subscription.relatedOrderIds ?? []).map(String));
    const subscriptionPaidTotal = orders.reduce((sum, order) => {
      if (!order.isPaid) return sum;
      return relatedOrderIds.has(String(order.wooOrderId)) || relatedOrderIds.has(String(order.orderNumber)) ? sum + Number(order.paidAmount ?? order.total ?? 0) : sum;
    }, 0);
    if (subscriptions.length) {
      customer.activeSubscriptions = activeSubscriptions.length;
      customer.subscriptionStatus = activeSubscriptions.length ? "active" : "inactive";
      customer.subscriptionStartDate = subscriptionStartDate;
      customer.firstPaidDate = [subscriptionStartDate, customer.firstPaidDate].filter(Boolean).sort()[0] ?? customer.firstPaidDate;
      customer.stayWithUsMonths = monthsSince(customer.firstPaidDate || subscriptionStartDate || customer.firstOrderDate);
      customer.subscriptionPaidTotal = subscriptionPaidTotal;
    }
    const recurring = detectAuthorizeNetRecurring(customerLedgerRecords({ ...customer, gatewayPayments: existingFull?.gatewayPayments ?? [] }));
    Object.assign(customer, {
      isGatewayRecurring: recurring.isGatewayRecurring,
      recurringSource: recurring.recurringSource,
      recurringAmount: recurring.recurringAmount,
      recurringFrequencyEstimate: recurring.recurringFrequencyEstimate,
      recurringLastPayment: recurring.recurringLastPayment,
      recurringNextEstimatedPayment: recurring.recurringNextEstimatedPayment,
      recurringPaymentCount: recurring.recurringPaymentCount,
    });
    if ((existingFull?.orderCount ?? 0) > customer.orderCount) continue;
    await Customer.findOneAndUpdate(
      { $or: [{ normalizedEmail: customer.normalizedEmail }, { email: customer.normalizedEmail }, { externalCustomerKey: customer.externalCustomerKey }] },
      { $set: customer },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    customersUpdated += 1;
  }
  const hasMoreCustomers = groups.length === rebuildLimit;
  return {
    cursor: hasMoreCustomers ? nextCursor(cursor, { phase: "customers", rebuildOffset: offset + groups.length }) : nextCursor(cursor, { phase: "subscriptions", subscriptionStatusIndex: 0, subscriptionPage: 1, completedSteps: ["customers"] }),
    customersUpdated,
    label: `Updating customer profiles ${offset}-${offset + groups.length}...`,
  };
}

async function importSubscriptionStep(cursor: SyncCursor) {
  if (!isWooCommerceConfigured()) return { cursor: nextCursor(cursor, { phase: "wordpress_profiles", completedSteps: ["subscriptions"] }), warning: "WooCommerce is not configured." };
  const statusIndex = cursor.subscriptionStatusIndex ?? 0;
  const status = wooCommerceSubscriptionStatuses[statusIndex];
  if (!status) return { cursor: nextCursor(cursor, { phase: "wordpress_profiles", completedSteps: ["subscriptions"] }), warning: "" };
  const page = cursor.subscriptionPage ?? 1;
  const result = await fetchWooCommerceSubscriptions({ statuses: [status], perPage: subscriptionPerPage, maxPages: 1, page });
  const importedAt = new Date().toISOString();
  let subscriptionsImported = 0;
  if (result?.items.length) {
    const write = await WooCommerceSubscriptionRecord.bulkWrite(result.items.map((subscription) => ({
      updateOne: { filter: { wooSubscriptionId: Number(subscription.id) }, update: { $set: normalizeWooSubscription(subscription, importedAt) }, upsert: true },
    })), { ordered: false });
    subscriptionsImported = write.upsertedCount + write.modifiedCount;
  }
  const doneStatus = !result || result.items.length < subscriptionPerPage;
  const next = doneStatus
    ? nextCursor(cursor, { phase: "subscriptions", subscriptionStatusIndex: statusIndex + 1, subscriptionPage: 1, completedSteps: statusIndex + 1 >= wooCommerceSubscriptionStatuses.length ? ["subscriptions"] : [] })
    : nextCursor(cursor, { phase: "subscriptions", subscriptionStatusIndex: statusIndex, subscriptionPage: page + 1 });
  if ((next.subscriptionStatusIndex ?? 0) >= wooCommerceSubscriptionStatuses.length) next.phase = "wordpress_profiles";
  return { cursor: next, subscriptionsImported, label: `Importing WooCommerce subscriptions ${status} page ${page}...`, warning: result?.warning ?? "" };
}

async function importWordPressProfilesStep(cursor: SyncCursor) {
  if (!isWordPressProfileImportConfigured() && !isWooCommerceCustomerFallbackConfigured()) return { cursor: nextCursor(cursor, { phase: "wordpress_credit_records", completedSteps: ["wordpress_profiles"] }), warning: "WordPress and WooCommerce customer profile import are not configured." };
  const offset = cursor.wordpressProfileOffset ?? 0;
  let fetched;
  try {
    fetched = await fetchProfileUsersWithFallback({ limit: wordpressProfileLimit, offset });
  } catch (error) {
    const warning = error instanceof Error && (error.name === "AbortError" || error.message.includes("timed out"))
      ? "Request timed out during batch fetch"
      : error instanceof Error ? error.message : "WordPress profile import failed.";
    console.log(`[wordpress-profile-import] source=unknown page=${Math.floor(offset / wordpressProfileLimit) + 1} fetched=0 matched=0 updated=0 skipped=0 warning="${warning}"`);
    return { cursor: nextCursor(cursor, { phase: "wordpress_credit_records", completedSteps: ["wordpress_profiles"] }), wordpressProfilesImported: 0, label: "WordPress customer profile import skipped.", warning };
  }
  const { users, total, warnings, sourceUsed } = fetched;
  const importedAt = new Date().toISOString();
  let wordpressProfilesImported = 0;
  for (const user of users) {
    const customer = user.normalizedEmail
      ? await Customer.findOne({ $or: [{ normalizedEmail: user.normalizedEmail }, { email: user.normalizedEmail }] }).lean<{ _id: unknown; phone?: string; estimatedCreditLimit?: number; actualCreditLimit?: number | null; businessProfile?: Record<string, unknown>; sourceCoverage?: Record<string, unknown> } | null>()
      : null;
    const phoneFallback = !customer && user.profile.phone.length >= 7
      ? await Customer.findOne({ phone: { $regex: escapeRegex(user.profile.phone.slice(-7)), $options: "i" } }).lean<{ _id: unknown; phone?: string; estimatedCreditLimit?: number; actualCreditLimit?: number | null; businessProfile?: Record<string, unknown>; sourceCoverage?: Record<string, unknown> } | null>()
      : null;
    const matched = customer ?? phoneFallback;
    if (!matched) continue;
    const mergedProfile = mergeBusinessProfile(matched.businessProfile, user.profile, importedAt);
    const creditLimits = deriveCustomerCreditLimits(mergedProfile, matched.actualCreditLimit, matched.estimatedCreditLimit);
    await Customer.updateOne(
      { _id: matched._id },
      {
        $set: {
          businessProfile: mergedProfile,
          actualCreditLimit: creditLimits.actualCreditLimit,
          estimatedCreditLimit: creditLimits.estimatedCreditLimit,
          phone: matched.phone || user.profile.phone,
          "sourceCoverage.lastSyncedAt": importedAt,
          "sourceCoverage.creditMetaSource": mergedProfile.source || user.profile.source || "",
          "sourceCoverage.approvedCreditsFound": Number(mergedProfile.approvedCredits ?? 0),
          "sourceCoverage.availableCreditsFound": Number(mergedProfile.availableCredit ?? 0),
          "sourceCoverage.einSource": mergedProfile.ein ? (mergedProfile.source || user.profile.source || "") : String(matched.sourceCoverage?.einSource ?? ""),
        },
      }
    ).exec();
    wordpressProfilesImported += 1;
  }
  const nextOffset = offset + users.length;
  const hasMore = users.length === wordpressProfileLimit && (total === 0 || nextOffset < total);
  console.log(`[wordpress-profile-import] source=${sourceUsed} page=${Math.floor(offset / wordpressProfileLimit) + 1} fetched=${users.length} matched=${wordpressProfilesImported} updated=${wordpressProfilesImported} skipped=${users.length - wordpressProfilesImported}`);
  return {
    cursor: hasMore ? nextCursor(cursor, { phase: "wordpress_profiles", wordpressProfileOffset: nextOffset }) : nextCursor(cursor, { phase: "wordpress_credit_records", completedSteps: ["wordpress_profiles"] }),
    wordpressProfilesImported,
    label: `Importing WordPress customer profiles ${offset}-${nextOffset}...`,
    warning: warnings.join(" "),
  };
}

async function importWordPressCreditStep(cursor: SyncCursor) {
  if (!isWordPressProfileImportConfigured()) {
    return { cursor: nextCursor(cursor, { phase: "authorize_net_import", completedSteps: ["wordpress_credit_records"] }), warning: "WordPress credit import is not configured." };
  }
  const offset = cursor.wordpressCreditOffset ?? 0;
  const result = await importWordPressCreditBatch({ limit: wordpressCreditLimit, offset, dryRun: false, maxRuntimeMs: 8000 });
  return {
    cursor: result.hasMore ? nextCursor(cursor, { phase: "wordpress_credit_records", wordpressCreditOffset: result.nextOffset }) : nextCursor(cursor, { phase: "authorize_net_import", completedSteps: ["wordpress_credit_records"] }),
    wordpressCreditProfilesImported: result.updatedProfiles,
    label: result.hasMore ? `Importing WordPress credit records ${offset}-${result.nextOffset}...` : `Imported ${result.updatedProfiles} verified WordPress credit records.`,
    warning: result.warnings.join(" "),
  };
}

async function importAuthorizeNetStep(cursor: SyncCursor) {
  if (!isAuthorizeNetConfigured()) return { cursor: nextCursor(cursor, { phase: "authorize_net_reconcile", completedSteps: ["authorize_net_import"] }), warning: "Authorize.net is not configured." };
  const from = "2019-01-01";
  const to = dateInput(new Date(), new Date().toISOString().slice(0, 10));
  const ids: string[] = [];
  const batchOffset = cursor.authorizeNetBatchOffset ?? 0;
  let batchCount = 0;
  try {
    const batches = await fetchSettledBatchIds(from, to);
    batchCount = batches.length;
    const batch = batches[batchOffset];
    if (batch) ids.push(...await fetchTransactionIdsForBatch(batch.batchId));
    if (batchOffset === 0) ids.push(...await fetchUnsettledTransactionIds());
  } catch (error) {
    return { cursor: nextCursor(cursor, { phase: "authorize_net_reconcile", completedSteps: ["authorize_net_import"] }), warning: error instanceof Error ? error.message : "Authorize.net import failed." };
  }
  const uniqueIds = Array.from(new Set(ids));
  const offset = cursor.authorizeNetOffset ?? 0;
  const selected = uniqueIds.slice(offset, offset + authNetLimit);
  const importedAt = new Date().toISOString();
  const normalized = [];
  const warnings: string[] = [];
  for (const id of selected) {
    try {
      normalized.push(normalizeAuthorizeNetTransaction(await fetchTransactionDetails(id), importedAt));
    } catch (error) {
      warnings.push(`${id}: ${error instanceof Error ? error.message : "detail fetch failed"}`);
    }
  }
  let authorizeNetTransactionsImported = 0;
  if (normalized.length) {
    const write = await AuthorizeNetTransaction.bulkWrite(normalized.map((transaction) => ({
      updateOne: { filter: { transactionId: transaction.transactionId }, update: { $set: transaction }, upsert: true },
    })), { ordered: false });
    authorizeNetTransactionsImported = write.upsertedCount + write.modifiedCount;
  }
  const hasMoreInBatch = offset + selected.length < uniqueIds.length;
  const hasMoreBatches = batchOffset + 1 < batchCount;
  return {
    cursor: hasMoreInBatch
      ? nextCursor(cursor, { phase: "authorize_net_import", authorizeNetBatchOffset: batchOffset, authorizeNetOffset: offset + selected.length })
      : hasMoreBatches
        ? nextCursor(cursor, { phase: "authorize_net_import", authorizeNetBatchOffset: batchOffset + 1, authorizeNetOffset: 0 })
        : nextCursor(cursor, { phase: "authorize_net_reconcile", reconcileOffset: 0, completedSteps: ["authorize_net_import"] }),
    authorizeNetTransactionsImported,
    label: `Importing Authorize.net transactions batch ${batchOffset + 1}/${Math.max(batchCount, 1)}...`,
    warning: warnings.join(" "),
  };
}

async function reconcileAuthorizeNetStep(cursor: SyncCursor) {
  const offset = cursor.reconcileOffset ?? 0;
  const transactions = await AuthorizeNetTransaction.find({}).sort({ submittedAt: -1 }).skip(offset).limit(reconcileLimit).lean<AuthorizeNetTransactionDocument[]>();
  let authorizeNetPaymentsReconciled = 0;
  for (const transaction of transactions) {
    const result = await reconcileAuthorizeNetTransaction(transaction, false);
    if (result.matched) authorizeNetPaymentsReconciled += 1;
  }
  const hasMore = transactions.length === reconcileLimit;
  return {
    cursor: hasMore ? nextCursor(cursor, { phase: "authorize_net_reconcile", reconcileOffset: offset + transactions.length }) : nextCursor(cursor, { phase: "nmi_import", nmiOffset: 0, completedSteps: ["authorize_net_reconcile"] }),
    authorizeNetPaymentsReconciled,
    label: `Reconciling Authorize.net payments ${offset}-${offset + transactions.length}...`,
  };
}

async function importNmiStep(cursor: SyncCursor) {
  const offset = cursor.nmiOffset ?? 0;
  const importedAt = new Date().toISOString();
  const warnings: string[] = [];
  const normalized = [];
  if (isNmiConfigured() && offset === 0) {
    const result = await fetchNmiTransactions({ from: "2019-01-01", to: new Date().toISOString().slice(0, 10) });
    if (result.warning) warnings.push(result.warning);
    normalized.push(...result.transactions);
  }
  const webhookEvents = await PaymentEvent.find({ provider: "nmi" }).sort({ receivedAt: -1 }).skip(offset).limit(authNetLimit).lean<PaymentEventDocument[]>();
  normalized.push(...webhookEvents.map((event) => normalizeNmiPaymentEvent(event, importedAt)));
  const unique = Array.from(new Map(normalized.filter((transaction) => transaction.transactionId).map((transaction) => [transaction.transactionId, transaction])).values()).slice(0, authNetLimit);
  let nmiTransactionsImported = 0;
  if (unique.length) {
    const write = await NmiQuickPayTransaction.bulkWrite(unique.map((transaction) => ({
      updateOne: { filter: { transactionId: transaction.transactionId }, update: { $set: transaction }, upsert: true },
    })), { ordered: false });
    nmiTransactionsImported = write.upsertedCount + write.modifiedCount;
  }
  const hasMore = webhookEvents.length === authNetLimit;
  return {
    cursor: hasMore ? nextCursor(cursor, { phase: "nmi_import", nmiOffset: offset + webhookEvents.length }) : nextCursor(cursor, { phase: "nmi_reconcile", nmiReconcileOffset: 0, completedSteps: ["nmi_import"] }),
    nmiTransactionsImported,
    label: `Importing NMI Quick Pay transactions ${offset}-${offset + webhookEvents.length}...`,
    warning: warnings.join(" "),
  };
}

async function reconcileNmiStep(cursor: SyncCursor) {
  const offset = cursor.nmiReconcileOffset ?? 0;
  const transactions = await NmiQuickPayTransaction.find({}).sort({ submittedAt: -1 }).skip(offset).limit(reconcileLimit).lean<NmiQuickPayTransactionDocument[]>();
  let nmiPaymentsReconciled = 0;
  for (const transaction of transactions) {
    const result = await reconcileNmiTransaction(transaction, false);
    if (result.matched) nmiPaymentsReconciled += 1;
  }
  const hasMore = transactions.length === reconcileLimit;
  return {
    cursor: hasMore ? nextCursor(cursor, { phase: "nmi_reconcile", nmiReconcileOffset: offset + transactions.length }) : nextCursor(cursor, { phase: "analytics", completedSteps: ["nmi_reconcile"] }),
    nmiPaymentsReconciled,
    label: `Reconciling NMI Quick Pay payments ${offset}-${offset + transactions.length}...`,
  };
}

async function rebuildAnalyticsStep(cursor: SyncCursor) {
  const offset = cursor.analyticsOffset ?? 0;
  const result = await rebuildAnalyticsCacheBatch({ limit: 100, offset, maxRuntimeMs: 8000 });
  return {
    cursor: result.hasMore ? nextCursor(cursor, { phase: "analytics", analyticsOffset: result.nextOffset }) : nextCursor(cursor, { phase: "done", completedSteps: ["analytics"] }),
    analyticsRecordsUpdated: result.rankingUpdated,
    label: result.hasMore ? `Rebuilding dashboard analytics ${offset}-${result.nextOffset}...` : `Rebuilt dashboard analytics cache for ${result.rankingUpdated} ranked customers.`,
  };
}

export async function POST(request: Request) {
  await connectToDatabase();
  const body = await request.json().catch(() => ({})) as { cursor?: SyncCursor };
  const cursor: SyncCursor = body.cursor?.phase ? body.cursor : { phase: "orders", orderStatusIndex: 0, orderPage: 1, completedSteps: [] };
  const warnings: string[] = [];
  let result: {
    cursor: SyncCursor;
    label?: string;
    warning?: string;
    ordersImported?: number;
    customersUpdated?: number;
    subscriptionsImported?: number;
    wordpressProfilesImported?: number;
    wordpressCreditProfilesImported?: number;
    authorizeNetTransactionsImported?: number;
    authorizeNetPaymentsReconciled?: number;
    nmiTransactionsImported?: number;
    nmiPaymentsReconciled?: number;
    analyticsRecordsUpdated?: number;
  };

  if (cursor.phase === "orders") result = await importOrderStep(cursor);
  else if (cursor.phase === "customers") result = await rebuildCustomerStep(cursor);
  else if (cursor.phase === "subscriptions") result = await importSubscriptionStep(cursor);
  else if (cursor.phase === "wordpress_profiles") result = await importWordPressProfilesStep(cursor);
  else if (cursor.phase === "wordpress_credit_records") result = await importWordPressCreditStep(cursor);
  else if (cursor.phase === "authorize_net_import") result = await importAuthorizeNetStep(cursor);
  else if (cursor.phase === "authorize_net_reconcile") result = await reconcileAuthorizeNetStep(cursor);
  else if (cursor.phase === "nmi_import") result = await importNmiStep(cursor);
  else if (cursor.phase === "nmi_reconcile") result = await reconcileNmiStep(cursor);
  else if (cursor.phase === "analytics") result = await rebuildAnalyticsStep(cursor);
  else result = { cursor: nextCursor(cursor, { phase: "done" }), label: "Sync complete." };
  if (result.warning) warnings.push(result.warning);

  const hasMore = result.cursor.phase !== "done";
  const job = await SyncJob.create({
    jobType: "automatic_batch_sync",
    status: hasMore || warnings.length ? "partial" : "completed",
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    progress: hasMore ? 50 : 100,
    totalPages: 1,
    pagesFetched: 1,
    recordsProcessed: (result.ordersImported ?? 0) + (result.customersUpdated ?? 0) + (result.subscriptionsImported ?? 0) + (result.wordpressProfilesImported ?? 0) + (result.wordpressCreditProfilesImported ?? 0) + (result.authorizeNetTransactionsImported ?? 0) + (result.authorizeNetPaymentsReconciled ?? 0) + (result.nmiTransactionsImported ?? 0) + (result.nmiPaymentsReconciled ?? 0) + (result.analyticsRecordsUpdated ?? 0),
    errors: [],
    warnings,
    lastCursor: { page: result.cursor.orderPage ?? result.cursor.rebuildOffset ?? result.cursor.subscriptionPage ?? result.cursor.wordpressProfileOffset ?? result.cursor.wordpressCreditOffset ?? result.cursor.authorizeNetOffset ?? result.cursor.reconcileOffset ?? result.cursor.nmiOffset ?? result.cursor.nmiReconcileOffset ?? 0, status: result.cursor.phase ?? "" },
  });

  return NextResponse.json({
    jobId: String(job._id),
    currentStep: cursor.phase,
    completedSteps: result.cursor.completedSteps ?? [],
    hasMore,
    nextCursor: result.cursor,
    progressLabel: result.label ?? "Sync step complete.",
    ordersImported: result.ordersImported ?? 0,
    customersUpdated: result.customersUpdated ?? 0,
    subscriptionsImported: result.subscriptionsImported ?? 0,
    wordpressProfilesImported: result.wordpressProfilesImported ?? 0,
    wordpressCreditProfilesImported: result.wordpressCreditProfilesImported ?? 0,
    authorizeNetTransactionsImported: result.authorizeNetTransactionsImported ?? 0,
    authorizeNetPaymentsReconciled: result.authorizeNetPaymentsReconciled ?? 0,
    nmiTransactionsImported: result.nmiTransactionsImported ?? 0,
    nmiPaymentsReconciled: result.nmiPaymentsReconciled ?? 0,
    analyticsRecordsUpdated: result.analyticsRecordsUpdated ?? 0,
    warnings,
  });
}

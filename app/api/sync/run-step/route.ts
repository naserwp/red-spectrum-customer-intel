import { NextResponse } from "next/server";
import { isAuthorizeNetConfigured, fetchSettledBatchIds, fetchTransactionDetails, fetchTransactionIdsForBatch, fetchUnsettledTransactionIds, normalizeAuthorizeNetTransaction } from "@/lib/authorizeNet";
import { reconcileAuthorizeNetTransaction } from "@/lib/authorizeNetReconciliation";
import { calculateCustomerScore, scoreToStars, type CustomerScoreInput } from "@/lib/customerScore";
import { buildProductJourneySummary } from "@/lib/productClassification";
import { connectToDatabase } from "@/lib/mongodb";
import { fetchWooCommerceOrders, fetchWooCommerceSubscriptions, isWooCommerceConfigured, wooCommerceOrderStatuses, wooCommerceSubscriptionStatuses } from "@/lib/woocommerce";
import { countBy, normalizeWooOrder, orderHistoryItemFromStoredOrder, unique } from "@/lib/wooOrderImport";
import { normalizeWooSubscription } from "@/lib/wooSubscriptionImport";
import { AuthorizeNetTransaction, type AuthorizeNetTransactionDocument } from "@/models/AuthorizeNetTransaction";
import { Customer } from "@/models/Customer";
import { SyncJob } from "@/models/SyncJob";
import { WooCommerceOrderRecord, type WooCommerceOrderDocument } from "@/models/WooCommerceOrder";
import { WooCommerceSubscriptionRecord } from "@/models/WooCommerceSubscription";

export const dynamic = "force-dynamic";

const orderPerPage = 25;
const subscriptionPerPage = 25;
const rebuildLimit = 50;
const authNetLimit = 10;
const reconcileLimit = 50;

type SyncCursor = {
  phase?: "orders" | "customers" | "subscriptions" | "authorize_net_import" | "authorize_net_reconcile" | "done";
  orderStatusIndex?: number;
  orderPage?: number;
  rebuildOffset?: number;
  subscriptionStatusIndex?: number;
  subscriptionPage?: number;
  authorizeNetOffset?: number;
  reconcileOffset?: number;
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
    attemptedTotal,
    orderCount: history.length,
    paidOrderCount: paidOrders.length,
    attemptedOrderCount: attemptedOrders.length,
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
    estimatedCreditLimit: paidTotal > 0 ? Math.max(300, Math.round(paidTotal * 0.8)) : 0,
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
    const existing = await Customer.findOne({ $or: [{ normalizedEmail: customer.normalizedEmail }, { email: customer.normalizedEmail }, { externalCustomerKey: customer.externalCustomerKey }] }, { orderCount: 1 }).lean<{ orderCount?: number } | null>();
    if ((existing?.orderCount ?? 0) > customer.orderCount) continue;
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
  if (!isWooCommerceConfigured()) return { cursor: nextCursor(cursor, { phase: "authorize_net_import", completedSteps: ["subscriptions"] }), warning: "WooCommerce is not configured." };
  const statusIndex = cursor.subscriptionStatusIndex ?? 0;
  const status = wooCommerceSubscriptionStatuses[statusIndex];
  if (!status) return { cursor: nextCursor(cursor, { phase: "authorize_net_import", completedSteps: ["subscriptions"] }), warning: "" };
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
  if ((next.subscriptionStatusIndex ?? 0) >= wooCommerceSubscriptionStatuses.length) next.phase = "authorize_net_import";
  return { cursor: next, subscriptionsImported, label: `Importing WooCommerce subscriptions ${status} page ${page}...`, warning: result?.warning ?? "" };
}

async function importAuthorizeNetStep(cursor: SyncCursor) {
  if (!isAuthorizeNetConfigured()) return { cursor: nextCursor(cursor, { phase: "authorize_net_reconcile", completedSteps: ["authorize_net_import"] }), warning: "Authorize.net is not configured." };
  const from = "2024-01-01";
  const to = dateInput(new Date(), new Date().toISOString().slice(0, 10));
  const ids: string[] = [];
  try {
    const batches = await fetchSettledBatchIds(from, to);
    for (const batch of batches.slice(0, 2)) ids.push(...await fetchTransactionIdsForBatch(batch.batchId));
    ids.push(...await fetchUnsettledTransactionIds());
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
  const hasMore = offset + selected.length < uniqueIds.length;
  return {
    cursor: hasMore ? nextCursor(cursor, { phase: "authorize_net_import", authorizeNetOffset: offset + selected.length }) : nextCursor(cursor, { phase: "authorize_net_reconcile", reconcileOffset: 0, completedSteps: ["authorize_net_import"] }),
    authorizeNetTransactionsImported,
    label: "Importing Authorize.net transactions...",
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
    cursor: hasMore ? nextCursor(cursor, { phase: "authorize_net_reconcile", reconcileOffset: offset + transactions.length }) : nextCursor(cursor, { phase: "done", completedSteps: ["authorize_net_reconcile"] }),
    authorizeNetPaymentsReconciled,
    label: `Reconciling Authorize.net payments ${offset}-${offset + transactions.length}...`,
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
    authorizeNetTransactionsImported?: number;
    authorizeNetPaymentsReconciled?: number;
  };

  if (cursor.phase === "orders") result = await importOrderStep(cursor);
  else if (cursor.phase === "customers") result = await rebuildCustomerStep(cursor);
  else if (cursor.phase === "subscriptions") result = await importSubscriptionStep(cursor);
  else if (cursor.phase === "authorize_net_import") result = await importAuthorizeNetStep(cursor);
  else if (cursor.phase === "authorize_net_reconcile") result = await reconcileAuthorizeNetStep(cursor);
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
    recordsProcessed: (result.ordersImported ?? 0) + (result.customersUpdated ?? 0) + (result.subscriptionsImported ?? 0) + (result.authorizeNetTransactionsImported ?? 0) + (result.authorizeNetPaymentsReconciled ?? 0),
    errors: [],
    warnings,
    lastCursor: { page: result.cursor.orderPage ?? result.cursor.rebuildOffset ?? result.cursor.subscriptionPage ?? result.cursor.authorizeNetOffset ?? result.cursor.reconcileOffset ?? 0, status: result.cursor.phase ?? "" },
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
    authorizeNetTransactionsImported: result.authorizeNetTransactionsImported ?? 0,
    authorizeNetPaymentsReconciled: result.authorizeNetPaymentsReconciled ?? 0,
    warnings,
  });
}

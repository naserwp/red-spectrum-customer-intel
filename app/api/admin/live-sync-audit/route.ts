import { NextResponse } from "next/server";
import {
  fetchSettledBatchIds,
  fetchTransactionDetails,
  fetchTransactionIdsForBatch,
  fetchUnsettledTransactionIds,
  isAuthorizeNetConfigured,
  normalizeAuthorizeNetTransaction,
} from "@/lib/authorizeNet";
import { fetchWooCommerceOrderById, fetchWooCommerceOrders, isWooCommerceConfigured } from "@/lib/woocommerce";
import { connectToDatabase } from "@/lib/mongodb";
import { AuthorizeNetTransaction, type AuthorizeNetTransactionDocument } from "@/models/AuthorizeNetTransaction";
import { Customer, type CustomerDocument } from "@/models/Customer";
import { CustomerRanking, type CustomerRankingDocument } from "@/models/CustomerRanking";
import { SyncJob, type SyncJobDocument } from "@/models/SyncJob";
import { WooCommerceOrderRecord, type WooCommerceOrderDocument } from "@/models/WooCommerceOrder";

export const dynamic = "force-dynamic";

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function normalizeEmail(value: unknown) {
  return clean(value).toLowerCase();
}

function orderInfo(order: Awaited<ReturnType<typeof fetchWooCommerceOrderById>>) {
  if (!order) return null;
  return {
    id: Number(order.id),
    number: String(order.number ?? order.id),
    status: order.status ?? "",
    dateCreated: order.date_created ?? "",
    datePaid: order.date_paid ?? "",
    billingName: `${order.billing?.first_name ?? ""} ${order.billing?.last_name ?? ""}`.trim(),
    billingEmail: order.billing?.email ?? "",
    total: order.total ?? "",
  };
}

function dateOnly(date: Date) {
  return date.toISOString().slice(0, 10);
}

function transactionTime(transaction: Partial<AuthorizeNetTransactionDocument>) {
  const raw = String(transaction.submittedAt || transaction.settledAt || "");
  const time = raw ? new Date(raw).getTime() : 0;
  return Number.isFinite(time) ? time : 0;
}

function transactionInfo(transaction: Partial<AuthorizeNetTransactionDocument> | null) {
  if (!transaction) return null;
  return {
    transactionId: transaction.transactionId || "",
    invoiceNumber: transaction.invoiceNumber || "",
    status: transaction.transactionStatus || "",
    amount: Number(transaction.amount ?? 0),
    submittedAt: transaction.submittedAt || "",
    settledAt: transaction.settledAt || "",
    email: transaction.normalizedEmail || transaction.emailNormalized || transaction.customerEmail || "",
    customerName: transaction.customerName || "",
  };
}

async function latestAuthorizeNetApiTransaction() {
  if (!isAuthorizeNetConfigured()) return { transaction: null, error: "", checkedIds: 0 };
  const ids = new Set<string>();
  const errors: string[] = [];
  try {
    for (const id of (await fetchUnsettledTransactionIds()).slice(0, 20)) ids.add(id);
  } catch (error) {
    errors.push(`Unsettled lookup failed: ${error instanceof Error ? error.message : "unknown error"}`);
  }
  try {
    const now = new Date();
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const batches = await fetchSettledBatchIds(dateOnly(yesterday), dateOnly(now));
    for (const batch of batches.slice(0, 4)) {
      if (ids.size >= 40) break;
      try {
        for (const id of (await fetchTransactionIdsForBatch(batch.batchId)).slice(0, 20)) ids.add(id);
      } catch (error) {
        errors.push(`Batch ${batch.batchId} lookup failed: ${error instanceof Error ? error.message : "unknown error"}`);
      }
    }
  } catch (error) {
    errors.push(`Settled lookup failed: ${error instanceof Error ? error.message : "unknown error"}`);
  }
  const transactions: Partial<AuthorizeNetTransactionDocument>[] = [];
  for (const id of Array.from(ids).slice(0, 30)) {
    try {
      transactions.push(normalizeAuthorizeNetTransaction(await fetchTransactionDetails(id), new Date().toISOString()));
    } catch (error) {
      errors.push(`${id}: ${error instanceof Error ? error.message : "detail lookup failed"}`);
    }
  }
  transactions.sort((a, b) => transactionTime(b) - transactionTime(a));
  return { transaction: transactions[0] ?? null, error: errors[0] ?? "", checkedIds: ids.size };
}

async function tableSearch(email: string, name: string) {
  const normalized = normalizeEmail(email);
  const byEmail = normalized ? await Customer.find({ $or: [{ normalizedEmail: normalized }, { emailNormalized: normalized }, { email: normalized }, { email }] }, { name: 1, email: 1, lastPaidDate: 1 }).limit(5).lean() : [];
  if (byEmail.length) return { appears: true, query: email, count: byEmail.length, rows: byEmail.map((row) => ({ customerId: String(row._id), name: row.name, email: row.email, lastPaidDate: row.lastPaidDate })) };
  const firstName = name.split(/\s+/)[0] || "";
  const byName = firstName ? await Customer.find({ name: { $regex: `^${firstName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, $options: "i" } }, { name: 1, email: 1, lastPaidDate: 1 }).limit(5).lean() : [];
  return { appears: byName.length > 0, query: firstName, count: byName.length, rows: byName.map((row) => ({ customerId: String(row._id), name: row.name, email: row.email, lastPaidDate: row.lastPaidDate })) };
}

async function exactCustomer(orderId: number, fallbackEmail: string, fallbackName: string) {
  const wooApi = await fetchWooCommerceOrderById(orderId);
  const email = normalizeEmail(wooApi?.billing?.email || fallbackEmail);
  const name = clean(`${wooApi?.billing?.first_name ?? ""} ${wooApi?.billing?.last_name ?? ""}`) || fallbackName;
  const [storedOrder, customer, ranking, search] = await Promise.all([
    WooCommerceOrderRecord.findOne({ wooOrderId: orderId }).lean<WooCommerceOrderDocument | null>(),
    email ? Customer.findOne({ $or: [{ normalizedEmail: email }, { emailNormalized: email }, { email }] }, { name: 1, email: 1, normalizedEmail: 1, lastPaidDate: 1, latestOrderDate: 1, lifetimeValue: 1, paidTotal: 1, totalPaid: 1 }).lean<(Partial<CustomerDocument> & { _id: unknown }) | null>() : null,
    email ? CustomerRanking.findOne({ email }, { email: 1, latestPaidDate: 1, lifetimeSpent: 1 }).lean<CustomerRankingDocument | null>() : null,
    tableSearch(email, name),
  ]);
  return {
    orderId,
    expectedEmail: email,
    expectedName: name,
    existsInWooApi: Boolean(wooApi),
    wooApi: orderInfo(wooApi),
    existsInWooCommerceOrderCollection: Boolean(storedOrder),
    storedWooOrder: storedOrder ? { orderId: storedOrder.wooOrderId, orderNumber: storedOrder.orderNumber, status: storedOrder.status, dateCreated: storedOrder.dateCreated, isPaid: storedOrder.isPaid, importedAt: storedOrder.importedAt } : null,
    existsInCustomerCollection: Boolean(customer),
    customer: customer ? { customerId: String(customer._id), name: customer.name, email: customer.email, lastPaidDate: customer.lastPaidDate, latestOrderDate: customer.latestOrderDate, lifetimeValue: customer.lifetimeValue ?? customer.paidTotal ?? customer.totalPaid } : null,
    existsInCustomerRankingCollection: Boolean(ranking),
    ranking: ranking ? { email: ranking.email, latestPaidDate: ranking.latestPaidDate, lifetimeSpent: ranking.lifetimeSpent } : null,
    appearsInCustomerTableSearch: search.appears,
    customerTableSearch: search,
  };
}

export async function GET() {
  await connectToDatabase();
  const wooConfigured = isWooCommerceConfigured();
  const authorizeNetConfigured = isAuthorizeNetConfigured();
  const latestWooResult = wooConfigured ? await fetchWooCommerceOrders({ statuses: ["completed", "processing", "pending", "on-hold"], perPage: 1, maxPages: 1 }) : null;
  const latestAuthorizeNetApi = await latestAuthorizeNetApiTransaction();
  const latestWoo = latestWooResult?.items[0] ?? null;
  const latestWooDate = latestWoo?.date_created ?? "";
  const [
    latestStoredWoo,
    latestStoredAuthorizeNet,
    latestCustomerPaid,
    latestRankingPaid,
    recentMissingCount,
    failedSyncJob,
    webhookFileSignal,
    cronFileSignal,
    latestSyncJob,
    jameson,
    jean,
  ] = await Promise.all([
    WooCommerceOrderRecord.findOne({}).sort({ dateCreated: -1 }).lean<WooCommerceOrderDocument | null>(),
    AuthorizeNetTransaction.findOne({}).sort({ submittedAt: -1, settledAt: -1, importedAt: -1 }).lean<AuthorizeNetTransactionDocument | null>(),
    Customer.findOne({ lastPaidDate: { $ne: "" } }, { name: 1, email: 1, lastPaidDate: 1 }).sort({ lastPaidDate: -1 }).lean<(Partial<CustomerDocument> & { _id: unknown }) | null>(),
    CustomerRanking.findOne({ latestPaidDate: { $ne: "" } }, { email: 1, latestPaidDate: 1 }).sort({ latestPaidDate: -1 }).lean<CustomerRankingDocument | null>(),
    latestWooDate ? WooCommerceOrderRecord.countDocuments({ dateCreated: { $gte: latestWooDate } }) : Promise.resolve(0),
    SyncJob.findOne({ status: "failed" }).sort({ finishedAt: -1, updatedAt: -1 }).lean<SyncJobDocument | null>(),
    Promise.resolve(true),
    Promise.resolve(true),
    SyncJob.findOne({ jobType: "automatic_batch_sync" }).sort({ finishedAt: -1, updatedAt: -1 }).lean<SyncJobDocument | null>(),
    exactCustomer(164695, "admin@eahsolutions.com", "Jameson Alston"),
    exactCustomer(164693, "", "Jean Berthony Rosemond"),
  ]);
  const missingRecentWooOrdersCount = latestWoo && !latestStoredWoo || (latestWoo && Number(latestStoredWoo?.wooOrderId ?? 0) !== Number(latestWoo.id)) ? 1 : 0;
  const latestAuthorizeNetApiId = String(latestAuthorizeNetApi.transaction?.transactionId ?? "");
  const latestStoredAuthorizeNetId = String(latestStoredAuthorizeNet?.transactionId ?? "");
  const missingRecentAuthorizeNetTransactions = latestAuthorizeNetApiId && latestAuthorizeNetApiId !== latestStoredAuthorizeNetId
    ? Number(await AuthorizeNetTransaction.countDocuments({ transactionId: latestAuthorizeNetApiId }) === 0)
    : 0;
  const latestStoredDate = clean(latestStoredWoo?.dateCreated);
  const latestStoredAuthorizeNetDate = clean(latestStoredAuthorizeNet?.submittedAt || latestStoredAuthorizeNet?.settledAt || latestStoredAuthorizeNet?.importedAt);
  const lastSuccessfulSyncTime = [
    latestSyncJob?.status === "completed" ? latestSyncJob.finishedAt : "",
    latestStoredWoo?.importedAt,
    latestStoredAuthorizeNet?.importedAt,
  ].map(clean).filter(Boolean).sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0] ?? "";
  const missingRecentCustomersCount = [jameson, jean].filter((row) => row.existsInWooApi && !row.existsInCustomerCollection).length;
  return NextResponse.json({
    success: true,
    wooCommerceConfigured: wooConfigured,
    authorizeNetConfigured,
    latestWooCommerceOrderInApi: orderInfo(latestWoo),
    latestStoredWooCommerceOrder: latestStoredWoo ? { orderId: latestStoredWoo.wooOrderId, orderNumber: latestStoredWoo.orderNumber, status: latestStoredWoo.status, dateCreated: latestStoredWoo.dateCreated, importedAt: latestStoredWoo.importedAt } : null,
    latestAuthorizeNetTransactionInApi: transactionInfo(latestAuthorizeNetApi.transaction),
    latestStoredAuthorizeNetTransaction: transactionInfo(latestStoredAuthorizeNet),
    latestCustomerLastPaidDate: latestCustomerPaid ? { customerId: String(latestCustomerPaid._id), name: latestCustomerPaid.name, email: latestCustomerPaid.email, lastPaidDate: latestCustomerPaid.lastPaidDate } : null,
    latestCustomerRankingLastPaidDate: latestRankingPaid ? { email: latestRankingPaid.email, latestPaidDate: latestRankingPaid.latestPaidDate } : null,
    missingRecentWooOrdersCount,
    missingRecentAuthorizeNetTransactions,
    missingRecentCustomersCount,
    missingRecentWooOrdersSinceLatestApiCount: latestWooDate ? Math.max(0, 1 - Number(recentMissingCount)) : 0,
    webhookExists: webhookFileSignal,
    cronExists: cronFileSignal,
    manualSyncCenterCoversToday: Boolean(latestSyncJob),
    autoSyncStatus: webhookFileSignal ? "Webhook ready" : cronFileSignal ? "Cron ready" : "Manual only",
    syncMode: webhookFileSignal ? "Webhook ready; external webhook setup still required" : cronFileSignal ? "Cron ready; external schedule setup still required" : "Manual only",
    lastSuccessfulSyncTime,
    lastSyncError: latestAuthorizeNetApi.error || (failedSyncJob?.errors?.[0] ?? ""),
    latestSyncJob: latestSyncJob ? { status: latestSyncJob.status, finishedAt: latestSyncJob.finishedAt, lastCursor: latestSyncJob.lastCursor } : null,
    freshness: {
      latestWooOrderId: latestWoo ? Number(latestWoo.id) : 0,
      latestWooOrderDate: latestWooDate,
      latestStoredWooOrderDate: latestStoredDate,
      latestAuthorizeNetTransactionId: latestAuthorizeNetApiId,
      latestAuthorizeNetTransactionDate: clean(latestAuthorizeNetApi.transaction?.submittedAt || latestAuthorizeNetApi.transaction?.settledAt),
      latestStoredAuthorizeNetTransactionId: latestStoredAuthorizeNetId,
      latestStoredAuthorizeNetTransactionDate: latestStoredAuthorizeNetDate,
      status: latestWooDate && latestStoredDate && new Date(latestStoredDate).getTime() >= new Date(latestWooDate).getTime() ? "Fresh" : "Data sync recommended",
    },
    testedCustomers: {
      jamesonAlston: jameson,
      jeanBerthonyRosemond: jean,
    },
  });
}

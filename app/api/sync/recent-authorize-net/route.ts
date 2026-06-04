import { NextResponse } from "next/server";
import {
  fetchSettledBatchIds,
  fetchTransactionDetails,
  fetchTransactionIdsForBatch,
  fetchUnsettledTransactionIds,
  isAuthorizeNetConfigured,
  isAuthorizeNetPaidStatus,
  isDeclinedOrFailed,
  normalizeAuthorizeNetTransaction,
} from "@/lib/authorizeNet";
import { reconcileAuthorizeNetTransaction } from "@/lib/authorizeNetReconciliation";
import { connectToDatabase } from "@/lib/mongodb";
import { AuthorizeNetTransaction, type AuthorizeNetTransactionDocument } from "@/models/AuthorizeNetTransaction";

export const dynamic = "force-dynamic";

const maxHours = 24 * 14;
const maxDetails = 100;

function safeHours(value: unknown) {
  const parsed = Number(value ?? 24);
  return Number.isFinite(parsed) ? Math.min(maxHours, Math.max(1, Math.floor(parsed))) : 24;
}

function safeTransactionIds(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item ?? "").trim()).filter(Boolean).slice(0, 25);
}

function dateOnly(date: Date) {
  return date.toISOString().slice(0, 10);
}

function submittedTime(transaction: Partial<AuthorizeNetTransactionDocument>) {
  const raw = String(transaction.submittedAt || transaction.settledAt || "");
  const time = raw ? new Date(raw).getTime() : 0;
  return Number.isFinite(time) ? time : 0;
}

function sample(transaction: Partial<AuthorizeNetTransactionDocument>) {
  return {
    transactionId: transaction.transactionId,
    invoiceNumber: transaction.invoiceNumber,
    status: transaction.transactionStatus,
    amount: transaction.amount,
    submittedAt: transaction.submittedAt,
    settledAt: transaction.settledAt,
    email: transaction.normalizedEmail || transaction.emailNormalized || transaction.customerEmail,
    customerName: transaction.customerName,
    billingCompany: transaction.billingCompany,
    billingPhone: transaction.billingPhone,
    cardLast4: transaction.cardLast4,
    paidLike: isAuthorizeNetPaidStatus(String(transaction.transactionStatus ?? "")),
  };
}

export async function POST(request: Request) {
  const started = Date.now();
  if (!isAuthorizeNetConfigured()) {
    return NextResponse.json({ success: false, error: "Authorize.net is not configured." }, { status: 400 });
  }
  const body = await request.json().catch(() => ({})) as { hours?: number; dryRun?: boolean; transactionIds?: Array<string | number> };
  const hours = safeHours(body.hours);
  const dryRun = body.dryRun === true;
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);
  const now = new Date();
  const warnings: string[] = dryRun ? ["Dry run: no AuthorizeNetTransaction, Customer, or CustomerRanking records were written."] : [];
  await connectToDatabase();

  const ids = new Set<string>();
  let windowsProcessed = 0;
  let failed = 0;

  try {
    for (const id of await fetchUnsettledTransactionIds()) ids.add(id);
  } catch (error) {
    failed += 1;
    warnings.push(`Unsettled transaction fetch failed: ${error instanceof Error ? error.message : "unknown error"}`);
  }

  for (const id of safeTransactionIds(body.transactionIds)) ids.add(id);

  try {
    const batches = await fetchSettledBatchIds(dateOnly(since), dateOnly(now));
    windowsProcessed = 1;
    for (const batch of batches) {
      if (ids.size >= maxDetails) break;
      try {
        const batchIds = await fetchTransactionIdsForBatch(batch.batchId);
        batchIds.forEach((id) => ids.add(id));
      } catch (error) {
        failed += 1;
        warnings.push(`Batch ${batch.batchId} transaction list failed: ${error instanceof Error ? error.message : "unknown error"}`);
      }
    }
  } catch (error) {
    failed += 1;
    warnings.push(`Recent settled batch fetch failed: ${error instanceof Error ? error.message : "unknown error"}`);
  }

  const importedAt = new Date().toISOString();
  const normalized: Partial<AuthorizeNetTransactionDocument>[] = [];
  for (const id of Array.from(ids).slice(0, maxDetails)) {
    try {
      const detail = await fetchTransactionDetails(id);
      const transaction = normalizeAuthorizeNetTransaction(detail, importedAt);
      const directlyRequested = safeTransactionIds(body.transactionIds).includes(String(transaction.transactionId));
      if (transaction.transactionId && (directlyRequested || submittedTime(transaction) >= since.getTime())) normalized.push(transaction);
    } catch (error) {
      failed += 1;
      warnings.push(`${id}: ${error instanceof Error ? error.message : "transaction detail fetch failed"}`);
    }
  }

  const transactionIds = normalized.map((transaction) => String(transaction.transactionId)).filter(Boolean);
  const existingIds = transactionIds.length
    ? new Set((await AuthorizeNetTransaction.find({ transactionId: { $in: transactionIds } }, { transactionId: 1 }).lean<Array<{ transactionId?: string }>>()).map((row) => String(row.transactionId)))
    : new Set<string>();

  let inserted = 0;
  let updated = 0;
  let duplicatesSkipped = existingIds.size;
  let matchedCustomers = 0;
  let gatewayOnlyCreatedCustomers = 0;
  let attemptedOrFailedOnly = 0;
  const reconciledCustomerIds = new Set<string>();

  if (!dryRun && normalized.length) {
    const write = await AuthorizeNetTransaction.bulkWrite(normalized.map((transaction) => ({
      updateOne: {
        filter: { transactionId: transaction.transactionId },
        update: { $set: transaction },
        upsert: true,
      },
    })), { ordered: false });
    inserted = write.upsertedCount;
    updated = write.modifiedCount;
    duplicatesSkipped = Math.max(0, write.matchedCount - write.modifiedCount);

    const saved = await AuthorizeNetTransaction.find({ transactionId: { $in: transactionIds } }).sort({ submittedAt: -1 }).lean<AuthorizeNetTransactionDocument[]>();
    for (const transaction of saved) {
      const status = String(transaction.transactionStatus ?? "");
      if (!isAuthorizeNetPaidStatus(status) && isDeclinedOrFailed(status)) attemptedOrFailedOnly += 1;
      const result = await reconcileAuthorizeNetTransaction(transaction, false);
      if (result.matched) matchedCustomers += 1;
      if (result.customerId) reconciledCustomerIds.add(result.customerId);
      if (result.gatewayOnlyCreated) gatewayOnlyCreatedCustomers += 1;
    }
  }

  return NextResponse.json({
    success: true,
    gateway: "authorize_net",
    dryRun,
    hours,
    since: since.toISOString(),
    fetched: normalized.length,
    inserted: dryRun ? 0 : inserted,
    updated: dryRun ? 0 : updated,
    duplicatesSkipped: dryRun ? existingIds.size : duplicatesSkipped,
    matchedCustomers: dryRun ? 0 : matchedCustomers,
    gatewayOnlyCreatedCustomers: dryRun ? 0 : gatewayOnlyCreatedCustomers,
    failed,
    windowsProcessed,
    attemptedOrFailedOnly,
    affectedCustomerIds: Array.from(reconciledCustomerIds),
    sampleTransactions: normalized.slice(0, 10).map(sample),
    statusCounts: normalized.reduce<Record<string, number>>((counts, transaction) => {
      const status = String(transaction.transactionStatus || "unknown");
      counts[status] = (counts[status] ?? 0) + 1;
      return counts;
    }, {}),
    totalMs: Date.now() - started,
    warnings,
  });
}

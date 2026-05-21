import { NextResponse } from "next/server";
import { fetchSettledBatchIds, fetchTransactionDetails, fetchTransactionIdsForBatch, fetchUnsettledTransactionIds, isAuthorizeNetConfigured, normalizeAuthorizeNetTransaction } from "@/lib/authorizeNet";
import { countBy } from "@/lib/wooOrderImport";
import { connectToDatabase } from "@/lib/mongodb";
import { AuthorizeNetTransaction } from "@/models/AuthorizeNetTransaction";

export const dynamic = "force-dynamic";

const runtimeBudgetMs = 8000;
const settledWindowDays = 30;

function safeNumber(value: unknown, fallback: number, max: number) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.min(max, Math.floor(parsed));
}

function dateInput(value: unknown, fallback: string) {
  const date = new Date(String(value ?? fallback));
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString().slice(0, 10);
}

function addDays(value: string, days: number) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function minDate(a: string, b: string) {
  return new Date(`${a}T00:00:00Z`) <= new Date(`${b}T00:00:00Z`) ? a : b;
}

function isOnOrBefore(a: string, b: string) {
  return new Date(`${a}T00:00:00Z`).getTime() <= new Date(`${b}T00:00:00Z`).getTime();
}

export async function POST(request: Request) {
  const started = Date.now();
  if (!isAuthorizeNetConfigured()) {
    return NextResponse.json({ error: "Authorize.net is not configured.", saved: false }, { status: 400 });
  }
  const body = await request.json().catch(() => ({})) as { from?: string; to?: string; limit?: number; offset?: number; dryRun?: boolean; cursor?: { windowStart?: string; transactionOffset?: number } };
  const from = dateInput(body.from, "2019-01-01");
  const to = dateInput(body.to, new Date().toISOString().slice(0, 10));
  const limit = safeNumber(body.limit, 50, 100);
  const offset = safeNumber(body.offset, 0, 1000000);
  const cursorWindowStart = dateInput(body.cursor?.windowStart, addDays(from, offset * settledWindowDays));
  const cursorTransactionOffset = safeNumber(body.cursor?.transactionOffset, 0, 1000000);
  const dryRun = body.dryRun === true;
  const warnings: string[] = dryRun ? ["Dry run: no AuthorizeNetTransaction records were written."] : [];

  await connectToDatabase();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), runtimeBudgetMs);
  try {
    const selectedIds: string[] = [];
    const rejectedRecords: string[] = [];
    let windowsScanned = 0;
    let batchesFetched = 0;
    let transactionIdsDiscovered = 0;
    let gatewayFetchFailures = 0;
    let nextWindowStart = cursorWindowStart;
    let nextTransactionOffset = cursorTransactionOffset;
    let reachedEnd = !isOnOrBefore(cursorWindowStart, to);
    let unsettledFetched = 0;

    for (let windowStart = cursorWindowStart; isOnOrBefore(windowStart, to); windowStart = addDays(windowStart, settledWindowDays + 1)) {
      if (Date.now() - started > runtimeBudgetMs - 2500 || selectedIds.length >= limit) {
        nextWindowStart = windowStart;
        break;
      }
      const windowEnd = minDate(addDays(windowStart, settledWindowDays), to);
      windowsScanned += 1;
      try {
        const batches = await fetchSettledBatchIds(windowStart, windowEnd, controller.signal);
        batchesFetched += batches.length;
        const idsForWindow: string[] = [];
        for (const batch of batches) {
          if (Date.now() - started > runtimeBudgetMs - 2000 || selectedIds.length >= limit) break;
          const batchIds = await fetchTransactionIdsForBatch(batch.batchId, controller.signal);
          idsForWindow.push(...batchIds);
        }
        const uniqueWindowIds = Array.from(new Set(idsForWindow));
        transactionIdsDiscovered += uniqueWindowIds.length;
        const startAt = windowStart === cursorWindowStart ? cursorTransactionOffset : 0;
        const remainingSlots = limit - selectedIds.length;
        selectedIds.push(...uniqueWindowIds.slice(startAt, startAt + remainingSlots));
        if (startAt + remainingSlots < uniqueWindowIds.length) {
          nextWindowStart = windowStart;
          nextTransactionOffset = startAt + remainingSlots;
          break;
        }
        nextWindowStart = addDays(windowStart, settledWindowDays + 1);
        nextTransactionOffset = 0;
      } catch (error) {
        gatewayFetchFailures += 1;
        warnings.push(`Settled transaction fetch warning for ${windowStart} to ${windowEnd}: ${error instanceof Error ? error.message : "Unknown error"}`);
        nextWindowStart = addDays(windowStart, settledWindowDays + 1);
        nextTransactionOffset = 0;
      }
      reachedEnd = !isOnOrBefore(nextWindowStart, to);
    }

    if (reachedEnd && selectedIds.length < limit && Date.now() - started <= runtimeBudgetMs - 2000) {
      try {
        const unsettledIds = await fetchUnsettledTransactionIds(controller.signal);
        unsettledFetched = unsettledIds.length;
        selectedIds.push(...unsettledIds.slice(0, limit - selectedIds.length));
      } catch (error) {
        gatewayFetchFailures += 1;
        warnings.push(`Unsettled transaction fetch warning: ${error instanceof Error ? error.message : "Unknown error"}`);
      }
    }

    const uniqueIds = Array.from(new Set(selectedIds));
    const importedAt = new Date().toISOString();
    const normalizedTransactions = [];
    const failedDetails: string[] = [];
    let processed = 0;

    for (const transactionId of uniqueIds) {
      if (Date.now() - started > runtimeBudgetMs - 1000) {
        warnings.push(`Stopped Authorize.net import batch at ${processed} transactions to stay within runtime budget.`);
        break;
      }
      try {
        const detail = await fetchTransactionDetails(transactionId, controller.signal);
        const normalized = normalizeAuthorizeNetTransaction(detail, importedAt);
        if (normalized.transactionId) {
          normalizedTransactions.push(normalized);
        } else {
          rejectedRecords.push(transactionId);
          warnings.push(`${transactionId}: transaction detail did not include a transactionId.`);
        }
        processed += 1;
      } catch (error) {
        failedDetails.push(transactionId);
        warnings.push(`${transactionId}: ${error instanceof Error ? error.message : "transaction detail fetch failed"}`);
      }
    }

    let transactionsUpserted = 0;
    let transactionsInserted = 0;
    let transactionsModified = 0;
    let skippedDuplicates = 0;
    if (!dryRun && normalizedTransactions.length > 0) {
      const writeResult = await AuthorizeNetTransaction.bulkWrite(normalizedTransactions.map((transaction) => ({
        updateOne: {
          filter: { transactionId: transaction.transactionId },
          update: { $set: transaction },
          upsert: true,
        },
      })), { ordered: false });
      transactionsInserted = writeResult.upsertedCount;
      transactionsModified = writeResult.modifiedCount;
      skippedDuplicates = Math.max(0, writeResult.matchedCount - writeResult.modifiedCount);
      transactionsUpserted = transactionsInserted + transactionsModified;
    }

    const stoppedForBudget = warnings.some((warning) => warning.includes("runtime budget")) || Date.now() - started > runtimeBudgetMs - 1200;
    const hasMore = isOnOrBefore(nextWindowStart, to) || stoppedForBudget;
    const nextOffset = Math.max(0, Math.floor((new Date(`${nextWindowStart}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / (1000 * 60 * 60 * 24 * (settledWindowDays + 1))));
    const latestImportedTransactionId = normalizedTransactions[0]?.transactionId ?? "";
    return NextResponse.json({
      dryRun,
      from,
      to,
      limit,
      offset,
      cursor: { windowStart: cursorWindowStart, transactionOffset: cursorTransactionOffset },
      nextCursor: { windowStart: nextWindowStart, transactionOffset: nextTransactionOffset },
      windowsScanned,
      batchesFetched,
      transactionsDiscovered: transactionIdsDiscovered + unsettledFetched,
      transactionsFetched: normalizedTransactions.length,
      transactionsUpserted: dryRun ? 0 : transactionsUpserted,
      transactionsInserted: dryRun ? 0 : transactionsInserted,
      transactionsModified: dryRun ? 0 : transactionsModified,
      skippedDuplicates: dryRun ? 0 : skippedDuplicates,
      rejectedRecords: rejectedRecords.length + failedDetails.length,
      gatewayFetchFailures,
      latestImportedTransactionId,
      hasMore,
      nextOffset,
      statusCounts: countBy(normalizedTransactions.map((transaction) => String(transaction.transactionStatus ?? "unknown"))),
      totalAmount: normalizedTransactions.reduce((sum, transaction) => sum + Number(transaction.amount ?? 0), 0),
      debug: {
        fetchedFromGateway: normalizedTransactions.length,
        insertedIntoMongo: dryRun ? 0 : transactionsInserted,
        upsertedIntoMongo: dryRun ? 0 : transactionsUpserted,
        skippedDuplicates: dryRun ? 0 : skippedDuplicates,
        rejectedRecords: rejectedRecords.length + failedDetails.length,
        latestImportedTransactionId,
        windowsScanned,
        batchesFetched,
        gatewayFetchFailures,
      },
      warnings,
    });
  } finally {
    clearTimeout(timeout);
  }
}

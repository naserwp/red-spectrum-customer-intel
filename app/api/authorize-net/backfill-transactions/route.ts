import { NextResponse } from "next/server";
import { fetchSettledBatchIds, fetchTransactionDetails, fetchTransactionIdsForBatch, fetchUnsettledTransactionIds, isAuthorizeNetConfigured, normalizeAuthorizeNetTransaction } from "@/lib/authorizeNet";
import { countBy } from "@/lib/wooOrderImport";
import { connectToDatabase } from "@/lib/mongodb";
import { AuthorizeNetTransaction } from "@/models/AuthorizeNetTransaction";

export const dynamic = "force-dynamic";

const runtimeBudgetMs = 8000;

function safeNumber(value: unknown, fallback: number, max: number) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.min(max, Math.floor(parsed));
}

function dateInput(value: unknown, fallback: string) {
  const date = new Date(String(value ?? fallback));
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString().slice(0, 10);
}

export async function POST(request: Request) {
  const started = Date.now();
  if (!isAuthorizeNetConfigured()) {
    return NextResponse.json({ error: "Authorize.net is not configured.", saved: false }, { status: 400 });
  }
  const body = await request.json().catch(() => ({})) as { from?: string; to?: string; limit?: number; offset?: number; dryRun?: boolean };
  const from = dateInput(body.from, "2024-01-01");
  const to = dateInput(body.to, new Date().toISOString().slice(0, 10));
  const limit = safeNumber(body.limit, 50, 100);
  const offset = safeNumber(body.offset, 0, 1000000);
  const dryRun = body.dryRun === true;
  const warnings: string[] = dryRun ? ["Dry run: no AuthorizeNetTransaction records were written."] : [];

  await connectToDatabase();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), runtimeBudgetMs);
  try {
    const ids: string[] = [];
    try {
      const batches = await fetchSettledBatchIds(from, to, controller.signal);
      for (const batch of batches) {
        if (Date.now() - started > runtimeBudgetMs - 1500) break;
        ids.push(...await fetchTransactionIdsForBatch(batch.batchId, controller.signal));
      }
    } catch (error) {
      warnings.push(`Settled transaction fetch warning: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
    try {
      ids.push(...await fetchUnsettledTransactionIds(controller.signal));
    } catch (error) {
      warnings.push(`Unsettled transaction fetch warning: ${error instanceof Error ? error.message : "Unknown error"}`);
    }

    const uniqueIds = Array.from(new Set(ids));
    const selectedIds = uniqueIds.slice(offset, offset + limit);
    const importedAt = new Date().toISOString();
    const normalizedTransactions = [];
    const failedDetails: string[] = [];
    let processed = 0;

    for (const transactionId of selectedIds) {
      if (Date.now() - started > runtimeBudgetMs - 1000) {
        warnings.push(`Stopped Authorize.net import batch at ${processed} transactions to stay within runtime budget.`);
        break;
      }
      try {
        const detail = await fetchTransactionDetails(transactionId, controller.signal);
        const normalized = normalizeAuthorizeNetTransaction(detail, importedAt);
        if (normalized.transactionId) normalizedTransactions.push(normalized);
        processed += 1;
      } catch (error) {
        failedDetails.push(transactionId);
        warnings.push(`${transactionId}: ${error instanceof Error ? error.message : "transaction detail fetch failed"}`);
      }
    }

    let transactionsUpserted = 0;
    if (!dryRun && normalizedTransactions.length > 0) {
      const writeResult = await AuthorizeNetTransaction.bulkWrite(normalizedTransactions.map((transaction) => ({
        updateOne: {
          filter: { transactionId: transaction.transactionId },
          update: { $set: transaction },
          upsert: true,
        },
      })), { ordered: false });
      transactionsUpserted = writeResult.upsertedCount + writeResult.modifiedCount;
    }

    const nextOffset = offset + processed + failedDetails.length;
    const hasMore = nextOffset < uniqueIds.length || warnings.some((warning) => warning.includes("runtime budget"));
    return NextResponse.json({
      dryRun,
      from,
      to,
      limit,
      offset,
      transactionsDiscovered: uniqueIds.length,
      transactionsFetched: normalizedTransactions.length,
      transactionsUpserted: dryRun ? 0 : transactionsUpserted,
      hasMore,
      nextOffset,
      statusCounts: countBy(normalizedTransactions.map((transaction) => String(transaction.transactionStatus ?? "unknown"))),
      totalAmount: normalizedTransactions.reduce((sum, transaction) => sum + Number(transaction.amount ?? 0), 0),
      warnings,
    });
  } finally {
    clearTimeout(timeout);
  }
}

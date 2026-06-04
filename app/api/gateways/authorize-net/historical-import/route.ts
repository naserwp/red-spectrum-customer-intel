import { NextResponse } from "next/server";
import {
  fetchBatchTransactionSummaries,
  fetchSettledBatchIds,
  fetchTransactionDetails,
  isAuthorizeNetConfigured,
  isSettledSuccessful,
  normalizeAuthorizeNetTransaction,
} from "@/lib/authorizeNet";
import { connectToDatabase } from "@/lib/mongodb";
import { AuthorizeNetTransaction } from "@/models/AuthorizeNetTransaction";

export const dynamic = "force-dynamic";

type ImportWindow = {
  start: string;
  end: string;
  batches: number;
  recordsFound: number;
  alreadyStored: number;
  missing: number;
  warnings: string[];
};

function parseDateInput(value: unknown, fallback: string) {
  const parsed = new Date(String(value ?? fallback));
  return Number.isNaN(parsed.getTime()) ? fallback : parsed.toISOString().slice(0, 10);
}

function safeWindowDays(value: unknown) {
  const parsed = Number(value ?? 31);
  if (!Number.isFinite(parsed) || parsed < 1) return 31;
  return Math.min(31, Math.floor(parsed));
}

function addDays(value: string, days: number) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function isOnOrBefore(a: string, b: string) {
  return new Date(`${a}T00:00:00Z`).getTime() <= new Date(`${b}T00:00:00Z`).getTime();
}

function minDate(a: string, b: string) {
  return isOnOrBefore(a, b) ? a : b;
}

function minIso(values: string[]) {
  return values.filter(Boolean).sort((a, b) => new Date(a).getTime() - new Date(b).getTime())[0] ?? "";
}

function maxIso(values: string[]) {
  return values.filter(Boolean).sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0] ?? "";
}

export async function POST(request: Request) {
  const started = Date.now();
  if (!isAuthorizeNetConfigured()) {
    return NextResponse.json({ error: "Authorize.net is not configured." }, { status: 400 });
  }
  const body = await request.json().catch(() => ({})) as {
    startDate?: string;
    endDate?: string;
    dryRun?: boolean;
    windowDays?: number;
  };
  const startDate = parseDateInput(body.startDate, "2020-01-01");
  const endDate = parseDateInput(body.endDate, "2022-12-31");
  const dryRun = body.dryRun !== false;
  const windowDays = safeWindowDays(body.windowDays);
  const warnings: string[] = dryRun ? ["Dry run: no Authorize.net transaction records were written."] : [];
  const windows: ImportWindow[] = [];
  const allSummaries = new Map<string, { transactionId: string; transactionStatus: string; amount: number }>();
  const failedWindows: string[] = [];

  await connectToDatabase();

  for (let windowStart = startDate; isOnOrBefore(windowStart, endDate); windowStart = addDays(windowStart, windowDays)) {
    const windowEnd = minDate(addDays(windowStart, windowDays - 1), endDate);
    const row: ImportWindow = { start: windowStart, end: windowEnd, batches: 0, recordsFound: 0, alreadyStored: 0, missing: 0, warnings: [] };
    try {
      const batches = await fetchSettledBatchIds(windowStart, windowEnd);
      row.batches = batches.length;
      const windowIds: string[] = [];
      for (const batch of batches) {
        const summaries = await fetchBatchTransactionSummaries(batch.batchId);
        for (const summary of summaries) {
          if (!summary.transactionId) continue;
          allSummaries.set(summary.transactionId, summary);
          windowIds.push(summary.transactionId);
        }
        row.recordsFound += summaries.length;
      }
      const uniqueWindowIds = Array.from(new Set(windowIds));
      const existingForWindow = uniqueWindowIds.length
        ? await AuthorizeNetTransaction.find({ transactionId: { $in: uniqueWindowIds } }, { transactionId: 1 }).lean<Array<{ transactionId: string }>>()
        : [];
      const existingSet = new Set(existingForWindow.map((transaction) => transaction.transactionId));
      row.alreadyStored = uniqueWindowIds.filter((id) => existingSet.has(id)).length;
      row.missing = Math.max(0, row.recordsFound - row.alreadyStored);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown Authorize.net window error";
      row.warnings.push(message);
      failedWindows.push(`${windowStart}:${message}`);
      warnings.push(`Authorize.net ${windowStart} to ${windowEnd}: ${message}`);
    }
    windows.push(row);
  }

  const ids = Array.from(allSummaries.keys());
  const existing = ids.length
    ? await AuthorizeNetTransaction.find({ transactionId: { $in: ids } }, { transactionId: 1 }).lean<Array<{ transactionId: string }>>()
    : [];
  const existingIds = new Set(existing.map((transaction) => transaction.transactionId));
  const missingIds = ids.filter((id) => !existingIds.has(id));
  const importedAt = new Date().toISOString();
  const normalized = [];
  const failed: string[] = [...failedWindows];
  let skipped = 0;

  if (!dryRun) {
    for (const transactionId of missingIds) {
      try {
        const detail = await fetchTransactionDetails(transactionId);
        const transaction = normalizeAuthorizeNetTransaction(detail, importedAt);
        if (!transaction.transactionId) {
          skipped += 1;
          failed.push(`${transactionId}: missing transactionId in detail response`);
          continue;
        }
        if (!isSettledSuccessful(String(transaction.transactionStatus ?? ""))) {
          skipped += 1;
          continue;
        }
        normalized.push(transaction);
      } catch (error) {
        failed.push(`${transactionId}: ${error instanceof Error ? error.message : "detail fetch failed"}`);
      }
    }
    if (normalized.length) {
      await AuthorizeNetTransaction.bulkWrite(normalized.map((transaction) => ({
        updateOne: {
          filter: { transactionId: transaction.transactionId },
          update: { $setOnInsert: transaction },
          upsert: true,
        },
      })), { ordered: false });
    }
  }

  const dates = normalized.map((transaction) => String(transaction.settledAt || transaction.submittedAt || "")).filter(Boolean);
  return NextResponse.json({
    gateway: "authorize_net",
    dateRange: { startDate, endDate },
    dryRun,
    windowDays,
    windowsProcessed: windows.length,
    recordsFound: ids.length,
    recordsAlreadyStored: existingIds.size,
    recordsMissing: missingIds.length,
    estimatedImportCount: missingIds.length,
    imported: dryRun ? 0 : normalized.length,
    skipped,
    duplicate: existingIds.size,
    failed: failed.length,
    failedDetails: failed.slice(0, 25),
    earliestDate: dryRun ? "" : minIso(dates),
    latestDate: dryRun ? "" : maxIso(dates),
    windows,
    warnings,
    totalMs: Date.now() - started,
  });
}

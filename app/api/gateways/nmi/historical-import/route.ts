import { NextResponse } from "next/server";
import { fetchNmiTransactions, isNmiConfigured, isNmiSuccessful } from "@/lib/nmiQuickPay";
import { connectToDatabase } from "@/lib/mongodb";
import { NmiQuickPayTransaction } from "@/models/NmiQuickPayTransaction";

export const dynamic = "force-dynamic";

type ImportWindow = {
  start: string;
  end: string;
  recordsFound: number;
  alreadyStored: number;
  missing: number;
  successful: number;
  failedOrDeclined: number;
  warning: string;
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
  if (!isNmiConfigured()) {
    return NextResponse.json({ error: "NMI security key is not configured." }, { status: 400 });
  }
  const body = await request.json().catch(() => ({})) as {
    startDate?: string;
    endDate?: string;
    dryRun?: boolean;
    windowDays?: number;
  };
  const startDate = parseDateInput(body.startDate, "2020-01-01");
  const endDate = parseDateInput(body.endDate, "2026-12-31");
  const dryRun = body.dryRun !== false;
  const windowDays = safeWindowDays(body.windowDays);
  const warnings: string[] = dryRun ? ["Dry run: no NMI Quick Pay transaction records were written."] : [];
  const windows: ImportWindow[] = [];
  const allTransactions = new Map<string, Awaited<ReturnType<typeof fetchNmiTransactions>>["transactions"][number]>();

  await connectToDatabase();

  for (let windowStart = startDate; isOnOrBefore(windowStart, endDate); windowStart = addDays(windowStart, windowDays)) {
    const windowEnd = minDate(addDays(windowStart, windowDays - 1), endDate);
    const result = await fetchNmiTransactions({ from: windowStart, to: windowEnd });
    if (result.warning) warnings.push(`NMI ${windowStart} to ${windowEnd}: ${result.warning}`);
    const uniqueWindowTransactions = Array.from(new Map(result.transactions.filter((transaction) => transaction.transactionId).map((transaction) => [transaction.transactionId, transaction])).values());
    for (const transaction of uniqueWindowTransactions) allTransactions.set(String(transaction.transactionId), transaction);
    const ids = uniqueWindowTransactions.map((transaction) => String(transaction.transactionId));
    const existing = ids.length
      ? await NmiQuickPayTransaction.find({ transactionId: { $in: ids } }, { transactionId: 1 }).lean<Array<{ transactionId: string }>>()
      : [];
    const existingSet = new Set(existing.map((transaction) => transaction.transactionId));
    const successful = uniqueWindowTransactions.filter((transaction) => isNmiSuccessful(String(transaction.transactionStatus ?? ""))).length;
    windows.push({
      start: windowStart,
      end: windowEnd,
      recordsFound: uniqueWindowTransactions.length,
      alreadyStored: ids.filter((id) => existingSet.has(id)).length,
      missing: ids.filter((id) => !existingSet.has(id)).length,
      successful,
      failedOrDeclined: Math.max(0, uniqueWindowTransactions.length - successful),
      warning: result.warning,
    });
  }

  const transactions = Array.from(allTransactions.values());
  const ids = transactions.map((transaction) => String(transaction.transactionId)).filter(Boolean);
  const existing = ids.length
    ? await NmiQuickPayTransaction.find({ transactionId: { $in: ids } }, { transactionId: 1 }).lean<Array<{ transactionId: string }>>()
    : [];
  const existingIds = new Set(existing.map((transaction) => transaction.transactionId));
  const missingTransactions = transactions.filter((transaction) => transaction.transactionId && !existingIds.has(String(transaction.transactionId)));
  let imported = 0;
  let skipped = 0;
  let failed = 0;
  const failedDetails: string[] = [];

  if (!dryRun && missingTransactions.length) {
    try {
      const write = await NmiQuickPayTransaction.bulkWrite(missingTransactions.map((transaction) => ({
        updateOne: {
          filter: { transactionId: transaction.transactionId },
          update: { $setOnInsert: transaction },
          upsert: true,
        },
      })), { ordered: false });
      imported = write.upsertedCount;
      skipped = Math.max(0, missingTransactions.length - imported);
    } catch (error) {
      failed = missingTransactions.length;
      failedDetails.push(error instanceof Error ? error.message : "NMI bulk import failed");
    }
  }

  const dates = missingTransactions.map((transaction) => String(transaction.settledAt || transaction.submittedAt || "")).filter(Boolean);
  return NextResponse.json({
    gateway: "nmi",
    dateRange: { startDate, endDate },
    dryRun,
    windowDays,
    windowsProcessed: windows.length,
    recordsFound: ids.length,
    recordsAlreadyStored: existingIds.size,
    recordsMissing: missingTransactions.length,
    estimatedImportCount: missingTransactions.length,
    imported: dryRun ? 0 : imported,
    skipped,
    duplicate: existingIds.size,
    failed,
    failedDetails,
    earliestDate: minIso(dates),
    latestDate: maxIso(dates),
    windows,
    warnings,
    totalMs: Date.now() - started,
  });
}

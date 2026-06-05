import { NextResponse } from "next/server";
import { runNmiBackfill } from "@/lib/nmiBackfill";
import { connectToDatabase } from "@/lib/mongodb";
import { NmiQuickPayTransaction, type NmiQuickPayTransactionDocument } from "@/models/NmiQuickPayTransaction";

export const dynamic = "force-dynamic";

function dateOnly(date: Date) {
  return date.toISOString().slice(0, 10);
}

function safeNumber(value: unknown, fallback: number, max: number) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(max, Math.floor(parsed));
}

function latestNmiInfo(transaction: Partial<NmiQuickPayTransactionDocument> | null) {
  if (!transaction) return null;
  return {
    transactionId: transaction.transactionId || "",
    status: transaction.transactionStatus || "",
    amount: Number(transaction.amount ?? 0),
    submittedAt: transaction.submittedAt || "",
    settledAt: transaction.settledAt || "",
    importedAt: transaction.importedAt || "",
    updatedAt: transaction.updatedAt ? new Date(transaction.updatedAt).toISOString() : "",
    email: transaction.normalizedEmail || transaction.emailNormalized || transaction.customerEmail || "",
    invoiceNumber: transaction.invoiceNumber || "",
  };
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const hours = safeNumber(url.searchParams.get("hours"), 72, 24 * 60);
  const limit = safeNumber(url.searchParams.get("limit"), 100, 100);
  const toDate = new Date();
  const fromDate = new Date(Date.now() - hours * 60 * 60 * 1000);
  const from = dateOnly(fromDate);
  const to = dateOnly(toDate);

  await connectToDatabase();
  const data = await runNmiBackfill({ from, to, source: "query_api", limit, dryRun: false });
  const latestNmiTransaction = await NmiQuickPayTransaction.findOne({})
    .sort({ submittedAt: -1, settledAt: -1, importedAt: -1, updatedAt: -1 })
    .lean<NmiQuickPayTransactionDocument | null>();
  const lastNmiSync = String(latestNmiTransaction?.importedAt || latestNmiTransaction?.updatedAt || "");
  const fetched = Number(data.transactionsFetched ?? 0);
  const imported = Number(data.transactionsInserted ?? 0);
  const updated = Number(data.transactionsUpdated ?? 0);
  const matched = await NmiQuickPayTransaction.countDocuments({
    submittedAt: { $gte: `${from}T00:00:00.000Z`, $lte: `${to}T23:59:59.999Z` },
    matchedCustomerId: { $nin: ["", null] },
  });
  const success = data.warnings.length === 0;
  const status = success ? "Fresh" : "Needs Sync";

  return NextResponse.json({
    success,
    mode: "manual-cron-endpoint",
    from,
    to,
    hours,
    source: "query_api",
    limit,
    fetched,
    imported,
    updated,
    matched,
    transactionsUpserted: Number(data.transactionsUpserted ?? 0),
    latestNmiTransaction: latestNmiInfo(latestNmiTransaction),
    lastNmiSync,
    status,
    backfill: data,
  }, { status: success ? 200 : 502 });
}

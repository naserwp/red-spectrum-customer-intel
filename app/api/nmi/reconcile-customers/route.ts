import { NextResponse } from "next/server";
import { reconcileNmiTransaction } from "@/lib/nmiReconciliation";
import { connectToDatabase } from "@/lib/mongodb";
import { NmiQuickPayTransaction, type NmiQuickPayTransactionDocument } from "@/models/NmiQuickPayTransaction";

export const dynamic = "force-dynamic";

const runtimeBudgetMs = 8000;

function safeNumber(value: unknown, fallback: number, max: number) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.min(max, Math.floor(parsed));
}

export async function GET() {
  return NextResponse.json({ error: "Method not allowed. Use POST to reconcile NMI Quick Pay transactions." }, { status: 405 });
}

export async function POST(request: Request) {
  const started = Date.now();
  const body = await request.json().catch(() => ({})) as { limit?: number; offset?: number; dryRun?: boolean };
  const limit = safeNumber(body.limit, 50, 50);
  const offset = safeNumber(body.offset, 0, 1000000);
  const dryRun = body.dryRun === true;
  await connectToDatabase();
  const [transactions, total] = await Promise.all([
    NmiQuickPayTransaction.find({}).sort({ submittedAt: -1 }).skip(offset).limit(limit).lean<NmiQuickPayTransactionDocument[]>(),
    NmiQuickPayTransaction.countDocuments({}),
  ]);
  const warnings: string[] = dryRun ? ["Dry run: no Customer records were written."] : [];
  let processed = 0;
  let matched = 0;
  let attachedGatewayOnly = 0;
  let verifiedWooOrders = 0;
  let skippedDuplicates = 0;
  let unmatched = 0;
  let updated = 0;

  for (const transaction of transactions) {
    if (Date.now() - started > runtimeBudgetMs - 1000) {
      warnings.push(`Stopped NMI reconciliation batch at ${processed} processed transactions to stay within runtime budget.`);
      break;
    }
    processed += 1;
    const result = await reconcileNmiTransaction(transaction, dryRun);
    if (!result.matched) {
      unmatched += 1;
      continue;
    }
    matched += 1;
    if (result.attachedGatewayOnly) attachedGatewayOnly += 1;
    if (result.verifiedWooOrder) verifiedWooOrders += 1;
    if (result.skippedDuplicate) skippedDuplicates += 1;
    if (result.updated) updated += 1;
  }

  const nextOffset = offset + processed;
  const hasMore = nextOffset < total || warnings.some((warning) => warning.includes("runtime budget"));
  return NextResponse.json({
    dryRun,
    processed,
    matched,
    attachedGatewayOnly,
    verifiedWooOrders,
    skippedDuplicates,
    unmatched,
    customersUpdated: dryRun ? 0 : updated,
    hasMore,
    nextOffset,
    warnings,
    message: hasMore
      ? `Processed ${processed} NMI Quick Pay transactions. Continue reconciliation to process next batch.`
      : `Processed ${processed} NMI Quick Pay transactions. Reconciliation batch is complete.`,
  });
}

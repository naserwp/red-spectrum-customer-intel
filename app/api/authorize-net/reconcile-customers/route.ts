import { NextResponse } from "next/server";
import { reconcileAuthorizeNetTransaction } from "@/lib/authorizeNetReconciliation";
import { connectToDatabase } from "@/lib/mongodb";
import { AuthorizeNetTransaction, type AuthorizeNetTransactionDocument } from "@/models/AuthorizeNetTransaction";

export const dynamic = "force-dynamic";

const runtimeBudgetMs = 8000;

function safeNumber(value: unknown, fallback: number, max: number) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.min(max, Math.floor(parsed));
}

export async function POST(request: Request) {
  const started = Date.now();
  const body = await request.json().catch(() => ({})) as { limit?: number; offset?: number; dryRun?: boolean };
  const limit = safeNumber(body.limit, 50, 50);
  const offset = safeNumber(body.offset, 0, 1000000);
  const dryRun = body.dryRun === true;
  await connectToDatabase();

  const [transactions, total] = await Promise.all([
    AuthorizeNetTransaction.find({}).sort({ submittedAt: -1 }).skip(offset).limit(limit).lean<AuthorizeNetTransactionDocument[]>().exec(),
    AuthorizeNetTransaction.countDocuments({}),
  ]);
  const warnings: string[] = dryRun ? ["Dry run: no Customer records were written."] : [];
  let processed = 0;
  let matched = 0;
  let attachedAuthorizeNetOnly = 0;
  let verifiedWooOrders = 0;
  let skippedDuplicates = 0;
  let unmatched = 0;
  let updated = 0;

  for (const transaction of transactions) {
    if (Date.now() - started > runtimeBudgetMs - 1000) {
      warnings.push(`Stopped Authorize.net reconciliation batch at ${processed} processed transactions to stay within runtime budget.`);
      break;
    }
    processed += 1;
    const result = await reconcileAuthorizeNetTransaction(transaction, dryRun);
    if (!result.matched) {
      unmatched += 1;
      continue;
    }
    matched += 1;
    if (result.attachedAuthorizeNetOnly) attachedAuthorizeNetOnly += 1;
    if (result.verifiedWooOrder) verifiedWooOrders += 1;
    if (result.skippedDuplicate) skippedDuplicates += 1;
    if (result.updated) updated += 1;
  }

  const nextOffset = offset + processed;
  const stoppedForBudget = warnings.some((warning) => warning.includes("runtime budget"));
  const hasMore = nextOffset < total || stoppedForBudget;
  return NextResponse.json({
    dryRun,
    processed,
    matched,
    attachedAuthorizeNetOnly,
    verifiedWooOrders,
    skippedDuplicates,
    unmatched,
    customersUpdated: dryRun ? 0 : updated,
    hasMore,
    nextOffset,
    warnings,
    transactionsProcessed: processed,
    transactionsMatched: matched,
    message: hasMore
      ? `Processed ${processed} Authorize.net transactions. Continue reconciliation to process next batch.`
      : `Processed ${processed} Authorize.net transactions. Reconciliation batch is complete.`,
  });
}

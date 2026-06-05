import { fetchNmiTransactions, normalizeNmiPaymentEvent } from "@/lib/nmiQuickPay";
import { connectToDatabase } from "@/lib/mongodb";
import { NmiQuickPayTransaction, type NmiQuickPayTransactionDocument } from "@/models/NmiQuickPayTransaction";
import { PaymentEvent, type PaymentEventDocument } from "@/models/PaymentEvent";

const runtimeBudgetMs = 8000;

export type NmiBackfillSource = "query_api" | "webhooks" | "both";

export type NmiBackfillOptions = {
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
  dryRun?: boolean;
  source?: NmiBackfillSource;
};

function safeNumber(value: unknown, fallback: number, max: number) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.min(max, Math.floor(parsed));
}

function dateInput(value: unknown, fallback: string) {
  const date = new Date(String(value ?? fallback));
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString().slice(0, 10);
}

export async function runNmiBackfill(options: NmiBackfillOptions = {}) {
  const started = Date.now();
  const from = dateInput(options.from, "2019-01-01");
  const to = dateInput(options.to, new Date().toISOString().slice(0, 10));
  const limit = safeNumber(options.limit, 25, 100);
  const offset = safeNumber(options.offset, 0, 1000000);
  const dryRun = options.dryRun === true;
  const source = options.source ?? "both";
  const warnings: string[] = dryRun ? ["Dry run: no NMI Quick Pay transaction records were written."] : [];

  await connectToDatabase();
  const importedAt = new Date().toISOString();
  const normalizedTransactions: Partial<NmiQuickPayTransactionDocument>[] = [];

  if (source === "query_api" || source === "both") {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), runtimeBudgetMs - 1000);
    const result = await fetchNmiTransactions({ from, to, signal: controller.signal });
    clearTimeout(timeout);
    if (result.warning) warnings.push(result.warning);
    normalizedTransactions.push(...result.transactions);
  }

  if (Date.now() - started < runtimeBudgetMs - 1500 && (source === "webhooks" || source === "both")) {
    const webhookEvents = await PaymentEvent.find({ provider: "nmi" })
      .sort({ receivedAt: -1 })
      .skip(offset)
      .limit(limit)
      .lean<PaymentEventDocument[]>();
    normalizedTransactions.push(...webhookEvents.map((event) => normalizeNmiPaymentEvent(event, importedAt)));
  }

  const unique = Array.from(
    new Map(normalizedTransactions.filter((transaction) => transaction.transactionId).map((transaction) => [transaction.transactionId, transaction])).values()
  ).slice(offset, offset + limit);
  let transactionsInserted = 0;
  let transactionsUpdated = 0;

  if (!dryRun && unique.length > 0) {
    const write = await NmiQuickPayTransaction.bulkWrite(unique.map((transaction) => ({
      updateOne: {
        filter: { transactionId: transaction.transactionId },
        update: { $set: transaction },
        upsert: true,
      },
    })), { ordered: false });
    transactionsInserted = write.upsertedCount;
    transactionsUpdated = write.modifiedCount;
  }

  const nextOffset = offset + unique.length;
  const hasMore = unique.length === limit || Date.now() - started > runtimeBudgetMs - 1500;

  return {
    dryRun,
    from,
    to,
    sourceUsed: source,
    transactionsFetched: unique.length,
    transactionsInserted: dryRun ? 0 : transactionsInserted,
    transactionsUpdated: dryRun ? 0 : transactionsUpdated,
    transactionsUpserted: dryRun ? 0 : transactionsInserted + transactionsUpdated,
    hasMore,
    nextOffset,
    statusCounts: Object.fromEntries(unique.reduce((map, transaction) => {
      const key = String(transaction.transactionStatus || "unknown");
      map.set(key, (map.get(key) ?? 0) + 1);
      return map;
    }, new Map<string, number>())),
    totalAmount: unique.reduce((sum, transaction) => sum + Number(transaction.amount ?? 0), 0),
    warnings,
  };
}

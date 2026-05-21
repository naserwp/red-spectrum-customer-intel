import { NextResponse } from "next/server";
import { fetchNmiTransactions, normalizeNmiPaymentEvent } from "@/lib/nmiQuickPay";
import { connectToDatabase } from "@/lib/mongodb";
import { NmiQuickPayTransaction } from "@/models/NmiQuickPayTransaction";
import { PaymentEvent, type PaymentEventDocument } from "@/models/PaymentEvent";

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

export async function GET() {
  return NextResponse.json({ error: "Method not allowed. Use POST to import NMI Quick Pay transactions." }, { status: 405 });
}

export async function POST(request: Request) {
  const started = Date.now();
  const body = await request.json().catch(() => ({})) as { from?: string; to?: string; limit?: number; offset?: number; dryRun?: boolean; source?: "query_api" | "webhooks" | "both" };
  const from = dateInput(body.from, "2019-01-01");
  const to = dateInput(body.to, new Date().toISOString().slice(0, 10));
  const limit = safeNumber(body.limit, 25, 50);
  const offset = safeNumber(body.offset, 0, 1000000);
  const dryRun = body.dryRun === true;
  const source = body.source ?? "both";
  const warnings: string[] = dryRun ? ["Dry run: no NMI Quick Pay transaction records were written."] : [];

  await connectToDatabase();
  const importedAt = new Date().toISOString();
  const normalizedTransactions = [];

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

  const unique = Array.from(new Map(normalizedTransactions.filter((transaction) => transaction.transactionId).map((transaction) => [transaction.transactionId, transaction])).values()).slice(offset, offset + limit);
  let transactionsUpserted = 0;
  if (!dryRun && unique.length > 0) {
    const write = await NmiQuickPayTransaction.bulkWrite(unique.map((transaction) => ({
      updateOne: {
        filter: { transactionId: transaction.transactionId },
        update: { $set: transaction },
        upsert: true,
      },
    })), { ordered: false });
    transactionsUpserted = write.upsertedCount + write.modifiedCount;
  }

  const nextOffset = offset + unique.length;
  const hasMore = unique.length === limit || Date.now() - started > runtimeBudgetMs - 1500;
  return NextResponse.json({
    dryRun,
    from,
    to,
    sourceUsed: source,
    transactionsFetched: unique.length,
    transactionsUpserted: dryRun ? 0 : transactionsUpserted,
    hasMore,
    nextOffset,
    statusCounts: Object.fromEntries(unique.reduce((map, transaction) => {
      const key = String(transaction.transactionStatus || "unknown");
      map.set(key, (map.get(key) ?? 0) + 1);
      return map;
    }, new Map<string, number>())),
    totalAmount: unique.reduce((sum, transaction) => sum + Number(transaction.amount ?? 0), 0),
    warnings,
  });
}

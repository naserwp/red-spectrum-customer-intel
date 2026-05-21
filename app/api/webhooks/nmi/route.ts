import { NextResponse } from "next/server";
import { normalizeNmiPaymentEvent } from "@/lib/nmiQuickPay";
import { reconcileNmiTransaction } from "@/lib/nmiReconciliation";
import { connectToDatabase } from "@/lib/mongodb";
import { PaymentEvent } from "@/models/PaymentEvent";
import { NmiQuickPayTransaction, type NmiQuickPayTransactionDocument } from "@/models/NmiQuickPayTransaction";

const handledEvents = new Set([
  "transaction.sale.success",
  "transaction.sale.failure",
  "transaction.refund.success",
  "transaction.refund.failure",
  "transaction.void.success",
  "transaction.credit.success",
  "chargeback.batch.complete",
  "recurring.subscription.add",
  "recurring.subscription.update",
  "recurring.subscription.delete",
  "recurring.plan.add",
  "recurring.plan.update",
  "recurring.plan.delete",
  "settlement.batch.complete",
  "settlement.batch.failure",
]);

async function parsePayload(request: Request) {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) return (await request.json()) as Record<string, unknown>;
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const form = await request.formData();
    return Object.fromEntries(form.entries());
  }
  try { return (await request.json()) as Record<string, unknown>; } catch { return {}; }
}

export async function GET() {
  return NextResponse.json({ ok: true, provider: "nmi", message: "NMI webhook endpoint is active" });
}

export async function POST(request: Request) {
  const url = new URL(request.url);
  const querySecret = url.searchParams.get("secret") ?? "";
  const headerSecret = request.headers.get("x-webhook-secret") ?? "";
  const envNmi = process.env.NMI_WEBHOOK_SECRET ?? "";
  const envCliq = process.env.CLIQ_WEBHOOK_SECRET ?? "";
  const provided = querySecret || headerSecret;
  const authorized = Boolean(provided && (provided === envNmi || provided === envCliq));

  if (!authorized) return NextResponse.json({ ok: false, error: "Unauthorized webhook secret." }, { status: 401 });

  await connectToDatabase();
  const raw = await parsePayload(request);
  const eventType = String(raw.eventType ?? raw.event_type ?? raw.type ?? "unknown");
  const transactionId = String(raw.transactionId ?? raw.transaction_id ?? raw.id ?? "");
  const customerEmail = String(raw.email ?? raw.customer_email ?? "").toLowerCase();
  const customerPhone = String(raw.phone ?? raw.customer_phone ?? "");
  const amount = Number(raw.amount ?? raw.transaction_amount ?? 0) || 0;
  const status = String(raw.status ?? raw.transaction_status ?? "unknown");

  const paymentEvent = await PaymentEvent.create({
    provider: "nmi",
    eventType,
    transactionId,
    customerEmail,
    customerPhone,
    amount,
    status,
    rawPayload: raw,
    receivedAt: new Date().toISOString(),
    processed: false,
    processingError: "",
  });

  if (!handledEvents.has(eventType)) {
    await PaymentEvent.findByIdAndUpdate(paymentEvent._id, { $set: { processed: true } });
    return NextResponse.json({ ok: true, processed: true, ignored: true, eventType });
  }

  try {
    const normalized = normalizeNmiPaymentEvent(paymentEvent, new Date().toISOString());
    if (normalized.transactionId) {
      await NmiQuickPayTransaction.updateOne(
        { transactionId: normalized.transactionId },
        { $set: normalized },
        { upsert: true }
      ).exec();
      const stored = await NmiQuickPayTransaction.findOne({ transactionId: normalized.transactionId }).lean<NmiQuickPayTransactionDocument | null>();
      if (stored) await reconcileNmiTransaction(stored, false);
    }

    await PaymentEvent.findByIdAndUpdate(paymentEvent._id, { $set: { processed: true } });
    return NextResponse.json({ ok: true, processed: true, eventType, transactionId });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Webhook processing failed.";
    await PaymentEvent.findByIdAndUpdate(paymentEvent._id, { $set: { processed: false, processingError: message } });
    return NextResponse.json({ ok: false, processed: false, error: "Webhook processing error." }, { status: 500 });
  }
}

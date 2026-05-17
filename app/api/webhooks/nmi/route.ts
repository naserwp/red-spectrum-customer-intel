import { NextResponse } from "next/server";
import { connectToDatabase } from "@/lib/mongodb";
import { PaymentEvent } from "@/models/PaymentEvent";
import { Customer } from "@/models/Customer";
import { calculateCustomerScore, scoreToStars } from "@/lib/customerScore";
import { generateCustomerAiSummary } from "@/lib/openai";

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

function estimateCreditLimit(totalPaid: number, orderCount: number, failedPayments: number, refunds: number, score: number) {
  const velocityFactor = Math.max(1, Math.min(3, orderCount / 4));
  const riskPenalty = failedPayments * 180 + refunds * 120 + (100 - score) * 5;
  return Math.max(300, Math.round(totalPaid * 0.8 * velocityFactor - riskPenalty));
}

function getTier(totalPaid: number) {
  if (totalPaid >= 2500) return "Platinum";
  if (totalPaid >= 999) return "Gold";
  if (totalPaid >= 200) return "Silver";
  return "Bronze";
}

function getRiskLevel(failedPayments: number, chargebacks: number, refunds: number, score: number): "low" | "medium" | "high" {
  if (chargebacks > 0 || failedPayments > 2 || score < 45) return "high";
  if (refunds > 1 || failedPayments > 0 || score < 70) return "medium";
  return "low";
}

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
    const customer = await Customer.findOne(customerEmail ? { email: customerEmail } : { phone: customerPhone });
    if (customer) {
      if (eventType.includes("failure")) customer.failedPayments = (customer.failedPayments ?? 0) + 1;
      if (eventType.includes("refund")) customer.refunds = (customer.refunds ?? 0) + 1;
      if (eventType.includes("chargeback")) customer.chargebacks = (customer.chargebacks ?? 0) + 1;
      if (eventType.includes("sale.success") || eventType.includes("credit.success")) {
        customer.totalPaid = (customer.totalPaid ?? 0) + Math.max(0, amount);
      }

      const score = calculateCustomerScore(customer);
      const stars = scoreToStars(score);
      customer.tier = getTier(customer.totalPaid ?? 0);
      customer.riskLevel = getRiskLevel(customer.failedPayments ?? 0, customer.chargebacks ?? 0, customer.refunds ?? 0, score);
      customer.estimatedCreditLimit = estimateCreditLimit(customer.totalPaid ?? 0, customer.orderCount ?? 0, customer.failedPayments ?? 0, customer.refunds ?? 0, score);
      customer.lastSyncedAt = new Date().toISOString();
      const ai = await generateCustomerAiSummary({ ...customer.toObject(), score, stars });
      customer.aiSummary = ai.aiSummary;
      customer.aiSummaryPreview = ai.aiSummaryPreview;
      customer.riskExplanation = ai.riskExplanation;
      customer.recommendedAction = ai.recommendedAction;
      await customer.save();
    }

    await PaymentEvent.findByIdAndUpdate(paymentEvent._id, { $set: { processed: true } });
    return NextResponse.json({ ok: true, processed: true, eventType, transactionId });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Webhook processing failed.";
    await PaymentEvent.findByIdAndUpdate(paymentEvent._id, { $set: { processed: false, processingError: message } });
    return NextResponse.json({ ok: false, processed: false, error: "Webhook processing error." }, { status: 500 });
  }
}

import { NextResponse } from "next/server";
import { connectToDatabase } from "@/lib/mongodb";
import { PaymentEvent } from "@/models/PaymentEvent";

export async function GET() {
  return NextResponse.json({ ok: true, provider: "authorize", message: "Authorize.net webhook endpoint is active" });
}

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as Record<string, unknown>;
    await connectToDatabase();
    await PaymentEvent.create({
      provider: "authorize",
      eventType: String(payload.eventType ?? payload.event_type ?? "unknown"),
      transactionId: String(payload.id ?? payload.transactionId ?? ""),
      customerEmail: String(payload.email ?? "").toLowerCase(),
      customerPhone: String(payload.phone ?? ""),
      amount: Number(payload.amount ?? 0) || 0,
      status: String(payload.status ?? "unknown"),
      rawPayload: payload,
      receivedAt: new Date().toISOString(),
      processed: false,
      processingError: "",
    });

    return NextResponse.json({
      ok: true,
      todo: "Add signature verification using AUTHORIZE_NET_SIGNATURE_KEY before trusting events.",
    });
  } catch {
    return NextResponse.json({ ok: false, error: "Unable to process Authorize.net webhook payload." }, { status: 400 });
  }
}

import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({ ok: true, provider: "stripe", message: "Stripe webhook endpoint is active" });
}

export async function POST() {
  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    return NextResponse.json({ ok: false, error: "STRIPE_WEBHOOK_SECRET is not configured." }, { status: 501 });
  }

  return NextResponse.json({
    ok: false,
    error: "Not implemented.",
    todo: "Implement Stripe signature verification before processing events.",
  }, { status: 501 });
}

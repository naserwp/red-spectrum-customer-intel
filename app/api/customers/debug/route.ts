import { NextResponse } from "next/server";
import { connectToDatabase } from "@/lib/mongodb";
import { Customer, type CustomerDocument } from "@/models/Customer";

export async function GET(request: Request) {
  await connectToDatabase();
  const { searchParams } = new URL(request.url);
  const email = (searchParams.get("email") ?? "").trim().toLowerCase();
  if (!email) return NextResponse.json({ error: "email query parameter is required" }, { status: 400 });

  const customer = await Customer.findOne({ email }).lean<CustomerDocument | null>();
  if (!customer) {
    return NextResponse.json({ email, customerFound: false });
  }

  return NextResponse.json({
    email,
    customerFound: true,
    orderCount: customer.orderCount ?? 0,
    attemptedTotal: customer.attemptedTotal ?? 0,
    paidTotal: customer.paidTotal ?? customer.totalPaid ?? 0,
    ordersStoredCount: customer.orders?.length ?? 0,
    productsFound: {
      attemptedProducts: customer.attemptedProducts ?? [],
      paidProducts: customer.paidProducts ?? [],
      lastProducts: customer.lastProducts ?? [],
    },
    lastAttemptPaymentMethod: customer.lastAttemptPaymentMethod ?? "",
    lastAttemptStatus: customer.lastAttemptStatus ?? "",
    leadStatus: customer.leadStatus ?? "",
    paymentStatus: customer.paymentStatus ?? "",
    gatewayVerification: customer.gatewayVerification
      ? {
          provider: customer.gatewayVerification.provider,
          matched: customer.gatewayVerification.matched,
          confidence: customer.gatewayVerification.confidence,
          matchedBy: customer.gatewayVerification.matchedBy,
          transactionStatus: customer.gatewayVerification.transactionStatus,
          lastCheckedAt: customer.gatewayVerification.lastCheckedAt,
          configured: customer.gatewayVerification.configured,
          notes: customer.gatewayVerification.notes,
        }
      : null,
  });
}

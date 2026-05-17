import { NextResponse } from "next/server";
import { connectToDatabase } from "@/lib/mongodb";
import { Customer } from "@/models/Customer";

export async function GET() {
  await connectToDatabase();
  const rows = await Customer.find({ $or: [{ failedPayments: { $gt: 1 } }, { chargebacks: { $gt: 0 } }, { riskLevel: "high" }] }).sort({ failedPayments: -1, chargebacks: -1 }).limit(50).lean();
  return NextResponse.json({ rows });
}

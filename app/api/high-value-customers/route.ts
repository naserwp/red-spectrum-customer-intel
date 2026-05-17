import { NextResponse } from "next/server";
import { connectToDatabase } from "@/lib/mongodb";
import { Customer } from "@/models/Customer";

export async function GET() {
  await connectToDatabase();
  const rows = await Customer.find({ $or: [{ totalPaid: { $gte: 2000 } }, { activeSubscriptions: { $gte: 2 } }, { estimatedCreditLimit: { $gte: 10000 } }] }).sort({ totalPaid: -1 }).limit(50).lean();
  return NextResponse.json({ rows });
}

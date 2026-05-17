import { NextResponse } from "next/server";
import { connectToDatabase } from "@/lib/mongodb";
import { Customer } from "@/models/Customer";

export async function GET() {
  await connectToDatabase();
  const rows = await Customer.find({ paidTotal: { $gte: 2000 } }).sort({ paidTotal: -1 }).limit(50).lean();
  return NextResponse.json({ rows });
}

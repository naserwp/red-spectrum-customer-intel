import { NextResponse } from "next/server";
import { connectToDatabase } from "@/lib/mongodb";
import { Customer } from "@/models/Customer";

export async function GET(request: Request) {
  await connectToDatabase();
  const { searchParams } = new URL(request.url);
  const page = Math.max(1, Number(searchParams.get("page") ?? 1));
  const limit = Math.min(100, Math.max(1, Number(searchParams.get("limit") ?? 20)));
  const q = (searchParams.get("q") ?? "").trim();
  const risk = searchParams.get("risk") ?? "";
  const query: Record<string, unknown> = {};
  if (risk) query.riskLevel = risk;
  if (q) query.$or = [{ name: { $regex: q, $options: "i" } }, { email: { $regex: q, $options: "i" } }, { phone: { $regex: q, $options: "i" } }];
  const [total, rows] = await Promise.all([
    Customer.countDocuments(query),
    Customer.find(query).sort({ paidTotal: -1, attemptedTotal: -1 }).skip((page - 1) * limit).limit(limit).lean(),
  ]);
  return NextResponse.json({ page, limit, total, rows });
}

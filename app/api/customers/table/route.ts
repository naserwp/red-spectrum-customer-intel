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
  const kind = searchParams.get("kind") ?? "";
  const and: Record<string, unknown>[] = [
    { $or: [{ name: { $type: "string", $ne: "" } }, { email: { $type: "string", $ne: "" } }] },
  ];
  if (risk) and.push({ riskLevel: risk });
  if (q) and.push({ $or: [{ name: { $regex: q, $options: "i" } }, { email: { $regex: q, $options: "i" } }, { phone: { $regex: q, $options: "i" } }] });
  if (kind === "hot-leads") {
    const unpaidCustomer = { $or: [{ paidTotal: { $lte: 0 } }, { paidTotal: { $exists: false } }, { paidTotal: null }] };
    and.push({
      $or: [
        { ...unpaidCustomer, attemptedTotal: { $gt: 0 } },
        {
          ...unpaidCustomer,
          attemptedOrderCount: { $gt: 0 },
          paymentStatus: { $regex: "attempted|failed|pending|on-hold|crypto_on_hold", $options: "i" },
        },
        {
          paidTotal: { $gt: 0 },
          attemptedOrderCount: { $gt: 0 },
          $expr: { $gt: [{ $ifNull: ["$lastAttemptDate", ""] }, { $ifNull: ["$lastPaidDate", ""] }] },
        },
      ],
    });
  }
  const query: Record<string, unknown> = { $and: and };
  const sort: Record<string, 1 | -1> = kind === "hot-leads" ? { attemptedTotal: -1, lastAttemptDate: -1 } : { paidTotal: -1, attemptedTotal: -1 };
  const [total, rows] = await Promise.all([
    Customer.countDocuments(query),
    Customer.find(query).sort(sort).skip((page - 1) * limit).limit(limit).lean(),
  ]);
  return NextResponse.json({ page, limit, total, rows });
}

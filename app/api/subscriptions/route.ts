import { NextResponse } from "next/server";
import { connectToDatabase } from "@/lib/mongodb";
import { Subscription } from "@/models/Subscription";

export async function GET(request: Request) {
  await connectToDatabase();
  const { searchParams } = new URL(request.url);
  const page = Math.max(1, Number(searchParams.get("page") ?? 1));
  const limit = Math.min(100, Math.max(1, Number(searchParams.get("limit") ?? 20)));
  const source = searchParams.get("source") ?? "";
  const status = searchParams.get("status") ?? "";
  const q: Record<string, unknown> = {};
  if (source) q.source = source;
  if (status) q.status = status;
  const [total, rows] = await Promise.all([
    Subscription.countDocuments(q),
    Subscription.find(q).sort({ nextBillingDate: 1 }).skip((page - 1) * limit).limit(limit).lean(),
  ]);
  return NextResponse.json({ page, limit, total, rows });
}

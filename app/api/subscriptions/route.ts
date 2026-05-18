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
  const kind = searchParams.get("kind") ?? "real";
  const search = (searchParams.get("q") ?? "").trim();
  const q: Record<string, unknown> = {};
  if (source) q.source = source;
  if (status) q.status = status;
  if (kind === "real") {
    q.isPlaceholder = { $ne: true };
    q.sourceStatus = "real";
    q.recordType = "subscription";
  } else if (kind === "candidates") {
    q.isPlaceholder = { $ne: true };
    q.recordType = "subscription_candidate";
  } else if (kind === "all-real-data") {
    q.isPlaceholder = { $ne: true };
  }
  if (search) q.$or = [{ customerName: { $regex: search, $options: "i" } }, { customerEmail: { $regex: search, $options: "i" } }, { subscriptionId: { $regex: search, $options: "i" } }];
  const [total, rows] = await Promise.all([
    Subscription.countDocuments(q),
    Subscription.find(q).sort({ nextBillingDate: 1 }).skip((page - 1) * limit).limit(limit).lean(),
  ]);
  return NextResponse.json({ page, limit, total, rows });
}

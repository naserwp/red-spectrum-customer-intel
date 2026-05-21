import { NextResponse } from "next/server";
import { connectToDatabase } from "@/lib/mongodb";
import { AuthorizeNetTransaction } from "@/models/AuthorizeNetTransaction";
import { Customer } from "@/models/Customer";
import { NmiQuickPayTransaction } from "@/models/NmiQuickPayTransaction";
import { SyncJob } from "@/models/SyncJob";
import { WooCommerceOrderRecord } from "@/models/WooCommerceOrder";
import { WooCommerceSubscriptionRecord } from "@/models/WooCommerceSubscription";

export const dynamic = "force-dynamic";

type LeanSyncJob = { finishedAt?: string; updatedAt?: Date | string; status?: string; jobType?: string };

function freshness(lastSyncAt: string, counts: { customers: number; wooOrders: number }) {
  if (!lastSyncAt || counts.customers === 0 || counts.wooOrders === 0) return "Data sync needed";
  const ageMs = Date.now() - new Date(lastSyncAt).getTime();
  if (!Number.isFinite(ageMs) || ageMs > 24 * 60 * 60 * 1000) return "Data sync needed";
  return "Fresh";
}

export async function GET() {
  await connectToDatabase();
  const [lastJob, customers, wooOrders, wooSubscriptions, authorizeNetTransactions, nmiQuickPayTransactions] = await Promise.all([
    SyncJob.findOne({}).sort({ finishedAt: -1, updatedAt: -1 }).lean<LeanSyncJob | null>(),
    Customer.countDocuments({}),
    WooCommerceOrderRecord.countDocuments({}),
    WooCommerceSubscriptionRecord.countDocuments({}),
    AuthorizeNetTransaction.countDocuments({}),
    NmiQuickPayTransaction.countDocuments({}),
  ]);
  const lastSyncAt = String(lastJob?.finishedAt || lastJob?.updatedAt || "");
  const counts = { customers, wooOrders, wooSubscriptions, authorizeNetTransactions, nmiQuickPayTransactions };
  return NextResponse.json({
    lastSyncAt,
    lastSuccessfulStep: lastJob?.status === "completed" ? lastJob.jobType : "",
    currentJobStatus: lastJob?.status ?? "idle",
    dataFreshness: freshness(lastSyncAt, counts),
    counts,
  });
}

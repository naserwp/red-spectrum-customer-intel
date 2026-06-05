import { NextResponse } from "next/server";
import { fetchAllAuthorizeNetSubscriptions, readSubscriptionDashboardMetrics } from "@/lib/subscriptionSync";
import { connectToDatabase } from "@/lib/mongodb";
import { countBy } from "@/lib/wooOrderImport";
import { fetchWooCommerceSubscriptionStatusTotals } from "@/lib/woocommerce";
import { Subscription } from "@/models/Subscription";
import { WooCommerceSubscriptionRecord } from "@/models/WooCommerceSubscription";

export const dynamic = "force-dynamic";

function clean(value: unknown) {
  return String(value ?? "").trim();
}

export async function GET() {
  const started = Date.now();
  await connectToDatabase();
  const [wooApiTotals, authApi, storedWooRows, storedAuthRows, dashboard] = await Promise.all([
    fetchWooCommerceSubscriptionStatusTotals(),
    fetchAllAuthorizeNetSubscriptions(),
    WooCommerceSubscriptionRecord.find({}, { wooSubscriptionId: 1, status: 1 }).lean<Array<{ wooSubscriptionId?: number; status?: string }>>(),
    Subscription.find({ source: "authorize_net", recordType: "subscription", sourceStatus: "real" }, { subscriptionId: 1, status: 1 }).lean<Array<{ subscriptionId?: string; status?: string }>>(),
    readSubscriptionDashboardMetrics(),
  ]);
  const apiAuthIds = new Set(authApi.subscriptions.map((subscription) => subscription.subscriptionId));
  const storedAuthIds = new Set(storedAuthRows.map((row) => clean(row.subscriptionId)).filter(Boolean));
  const apiByStatus = wooApiTotals.counts;
  const storedByStatus = countBy(storedWooRows.map((row) => clean(row.status || "unknown").toLowerCase()));
  const authApiByStatus = countBy(authApi.subscriptions.map((subscription) => clean(subscription.status || "unknown").toLowerCase()));
  const authStoredByStatus = countBy(storedAuthRows.map((row) => clean(row.status || "unknown").toLowerCase()));

  return NextResponse.json({
    success: true,
    wooCommerce: {
      apiTotal: wooApiTotals.total,
      storedTotal: storedWooRows.filter((row) => row.status !== "deleted").length,
      apiByStatus,
      storedByStatus,
      activeApi: Number(apiByStatus.active ?? 0),
      activeStored: Number(storedByStatus.active ?? 0),
      missingSubscriptionIds: [],
      extraStoredSubscriptionIds: [],
      statusMappingIssues: Object.entries(storedByStatus).filter(([status]) => status !== "active" && /active|pending|hold|cancel|expire/i.test(status)).map(([status, count]) => ({ status, count, countedActive: false })),
      warning: wooApiTotals.failedRequests.length ? `WooCommerce total lookup failed for ${wooApiTotals.failedRequests.length} status(es). Run full refresh for ID-level missing/extra lists.` : "ID-level missing/extra lists are skipped in fast audit; run full refresh for repair.",
    },
    authorizeNet: {
      apiActive: authApi.subscriptions.filter((subscription) => clean(subscription.status).toLowerCase() === "active").length,
      storedActive: Number(authStoredByStatus.active ?? 0),
      apiTotal: authApi.subscriptions.length,
      storedTotal: storedAuthRows.length,
      apiByStatus: authApiByStatus,
      storedByStatus: authStoredByStatus,
      missingSubscriptionIds: Array.from(apiAuthIds).filter((id) => !storedAuthIds.has(id)).slice(0, 250),
      extraStoredSubscriptionIds: Array.from(storedAuthIds).filter((id) => !apiAuthIds.has(id)).slice(0, 250),
      statusMappingIssues: Object.entries(authStoredByStatus).filter(([status]) => status !== "active").map(([status, count]) => ({ status, count, countedActive: false })),
      warning: authApi.warning,
    },
    dashboard: {
      totalSubscriptions: dashboard.totalSubscriptions,
      activeSubscriptions: dashboard.activeSubscriptions,
      wooActiveCount: dashboard.activeWooSubscriptions,
      authorizeNetActiveCount: dashboard.activeAuthorizeNetSubscriptions,
      mrr: dashboard.monthlyRecurringRevenue,
      sourceNotes: dashboard.sourceNotes,
    },
    totalMs: Date.now() - started,
  });
}

import { NextResponse } from "next/server";
import { connectToDatabase } from "@/lib/mongodb";
import { AuthorizeNetTransaction } from "@/models/AuthorizeNetTransaction";
import { Customer } from "@/models/Customer";
import { NmiQuickPayTransaction } from "@/models/NmiQuickPayTransaction";
import { SyncJob } from "@/models/SyncJob";
import { WooCommerceOrderRecord } from "@/models/WooCommerceOrder";
import { WooCommerceSubscriptionRecord } from "@/models/WooCommerceSubscription";
import { AnalyticsSnapshot } from "@/models/AnalyticsSnapshot";
import { fetchWooCommerceOrders, isWooCommerceConfigured } from "@/lib/woocommerce";
import { isNmiConfigured } from "@/lib/nmiQuickPay";
import { PaymentEvent } from "@/models/PaymentEvent";

export const dynamic = "force-dynamic";

type LeanSyncJob = { finishedAt?: string; updatedAt?: Date | string; status?: string; jobType?: string };

function freshness(lastSyncAt: string, counts: { customers: number; wooOrders: number }) {
  if (!lastSyncAt || counts.customers === 0 || counts.wooOrders === 0) return "Data sync needed";
  const ageMs = Date.now() - new Date(lastSyncAt).getTime();
  if (!Number.isFinite(ageMs) || ageMs > 24 * 60 * 60 * 1000) return "Data sync needed";
  return "Fresh";
}

function providerFreshness(configured: boolean, lastSyncAt: string, missing = 0) {
  if (!configured) return "Not configured";
  if (missing > 0 || !lastSyncAt) return "Needs Sync";
  const ageMs = Date.now() - new Date(lastSyncAt).getTime();
  if (!Number.isFinite(ageMs) || ageMs > 24 * 60 * 60 * 1000) return "Needs Sync";
  return "Fresh";
}

function latestDate(value?: string | Date) {
  return String(value || "");
}

export async function GET() {
  await connectToDatabase();
  const [lastJob, failedJob, customers, wooOrders, wooSubscriptions, authorizeNetTransactions, nmiQuickPayTransactions, latestWooOrder, latestWooByDate, latestSubscription, latestAuthorizeNet, latestNmi, latestStripeEvent, latestEnrichedCustomer, analyticsSnapshot] = await Promise.all([
    SyncJob.findOne({}).sort({ finishedAt: -1, updatedAt: -1 }).lean<LeanSyncJob | null>(),
    SyncJob.findOne({ status: "failed" }).sort({ finishedAt: -1, updatedAt: -1 }).lean<{ errors?: string[]; finishedAt?: string; updatedAt?: Date | string } | null>(),
    Customer.countDocuments({}),
    WooCommerceOrderRecord.countDocuments({}),
    WooCommerceSubscriptionRecord.countDocuments({}),
    AuthorizeNetTransaction.countDocuments({}),
    NmiQuickPayTransaction.countDocuments({}),
    WooCommerceOrderRecord.findOne({}).sort({ importedAt: -1, updatedAt: -1 }).lean<{ importedAt?: string; updatedAt?: Date | string; wooOrderId?: number; dateCreated?: string } | null>(),
    WooCommerceOrderRecord.findOne({}).sort({ dateCreated: -1 }).lean<{ importedAt?: string; updatedAt?: Date | string; wooOrderId?: number; dateCreated?: string } | null>(),
    WooCommerceSubscriptionRecord.findOne({}).sort({ importedAt: -1, updatedAt: -1 }).lean<{ importedAt?: string; updatedAt?: Date | string } | null>(),
    AuthorizeNetTransaction.findOne({}).sort({ importedAt: -1, updatedAt: -1 }).lean<{ importedAt?: string; updatedAt?: Date | string; transactionId?: string; submittedAt?: string; settledAt?: string } | null>(),
    NmiQuickPayTransaction.findOne({}).sort({ importedAt: -1, updatedAt: -1 }).lean<{ importedAt?: string; updatedAt?: Date | string } | null>(),
    PaymentEvent.findOne({ provider: "stripe" }).sort({ receivedAt: -1, updatedAt: -1 }).lean<{ receivedAt?: string; updatedAt?: Date | string } | null>(),
    Customer.findOne({ "sourceCoverage.lastEnrichmentRun": { $ne: "" } }).sort({ "sourceCoverage.lastEnrichmentRun": -1 }).lean<{ sourceCoverage?: { lastEnrichmentRun?: string } } | null>(),
    AnalyticsSnapshot.findOne({ key: "dashboard_analytics" }).lean<{ generatedAt?: string } | null>(),
  ]);
  const latestWooApi = isWooCommerceConfigured() ? await fetchWooCommerceOrders({ statuses: ["completed", "processing", "pending", "on-hold"], perPage: 1, maxPages: 1 }) : null;
  const latestWooApiOrder = latestWooApi?.items[0];
  const missingRecentOrdersCount = latestWooApiOrder && Number(latestWooByDate?.wooOrderId ?? 0) !== Number(latestWooApiOrder.id) ? 1 : 0;
  const authorizeNetLastSync = latestDate(latestAuthorizeNet?.importedAt || latestAuthorizeNet?.updatedAt);
  const nmiLastSync = latestDate(latestNmi?.importedAt || latestNmi?.updatedAt);
  const stripeLastSync = latestDate(latestStripeEvent?.receivedAt || latestStripeEvent?.updatedAt);
  const wooLastSync = latestDate(latestWooOrder?.importedAt || latestWooOrder?.updatedAt);
  const autoSyncStatus = "Webhook ready";
  const lastSyncAt = [
    latestDate(lastJob?.finishedAt || lastJob?.updatedAt),
    wooLastSync,
    authorizeNetLastSync,
    nmiLastSync,
    stripeLastSync,
  ].filter(Boolean).sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0] ?? "";
  const counts = { customers, wooOrders, wooSubscriptions, authorizeNetTransactions, nmiQuickPayTransactions };
  const wooStatus = providerFreshness(isWooCommerceConfigured(), wooLastSync, missingRecentOrdersCount);
  const authorizeNetStatus = providerFreshness(Boolean(process.env.AUTHORIZE_NET_API_LOGIN_ID && process.env.AUTHORIZE_NET_TRANSACTION_KEY), authorizeNetLastSync, 0);
  const nmiStatus = providerFreshness(isNmiConfigured(), nmiLastSync, 0);
  const stripeConfigured = Boolean(process.env.STRIPE_SECRET_KEY || process.env.STRIPE_WEBHOOK_SECRET);
  const stripeStatus = providerFreshness(stripeConfigured, stripeLastSync, 0);
  const recommendedAction = [wooStatus, authorizeNetStatus, nmiStatus, stripeStatus].some((status) => status === "Needs Sync")
    ? "Run Sync Now or verify cron/webhook delivery."
    : [wooStatus, authorizeNetStatus, nmiStatus, stripeStatus].every((status) => status === "Not configured")
      ? "Configure payment gateway credentials."
      : "No action needed.";
  return NextResponse.json({
    lastSyncAt,
    lastSuccessfulStep: lastJob?.status === "completed" ? lastJob.jobType : "",
    currentJobStatus: lastJob?.status ?? "idle",
    dataFreshness: freshness(lastSyncAt, counts),
    freshnessWarning: freshness(lastSyncAt, counts) === "Fresh" ? "" : "Data sync recommended.",
    lastWooCommerceOrderSync: wooLastSync,
    latestWooCommerceOrderImportedDate: String(latestWooByDate?.dateCreated || ""),
    latestWooCommerceOrderId: Number(latestWooByDate?.wooOrderId ?? 0),
    latestWooCommerceApiOrderId: Number(latestWooApiOrder?.id ?? 0),
    missingRecentWooOrdersCount: missingRecentOrdersCount,
    autoSyncStatus,
    lastSyncError: failedJob?.errors?.[0] ?? "",
    liveSyncStatus: {
      wooCommerce: wooStatus,
      authorizeNet: authorizeNetStatus,
      nmi: nmiStatus,
      stripe: stripeStatus,
      lastSuccessfulSync: lastSyncAt,
      recommendedAction,
    },
    latestAuthorizeNetTransactionId: String(latestAuthorizeNet?.transactionId || ""),
    latestAuthorizeNetTransactionDate: String(latestAuthorizeNet?.submittedAt || latestAuthorizeNet?.settledAt || ""),
    lastSubscriptionSync: String(latestSubscription?.importedAt || latestSubscription?.updatedAt || ""),
    lastAuthorizeNetSync: authorizeNetLastSync,
    lastNmiSync: nmiLastSync,
    lastStripeSync: stripeLastSync,
    lastEnrichmentRun: String(latestEnrichedCustomer?.sourceCoverage?.lastEnrichmentRun || ""),
    lastAnalyticsCacheRebuild: String(analyticsSnapshot?.generatedAt || ""),
    counts,
  });
}

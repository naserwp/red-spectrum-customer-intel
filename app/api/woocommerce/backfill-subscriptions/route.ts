import { NextResponse } from "next/server";
import { countBy } from "@/lib/wooOrderImport";
import { normalizeWooSubscription } from "@/lib/wooSubscriptionImport";
import { connectToDatabase } from "@/lib/mongodb";
import { fetchWooCommerceSubscriptions, isWooCommerceConfigured, wooCommerceSubscriptionStatuses } from "@/lib/woocommerce";
import { SyncJob } from "@/models/SyncJob";
import { WooCommerceSubscriptionRecord } from "@/models/WooCommerceSubscription";

export const dynamic = "force-dynamic";

const validStatuses = new Set(wooCommerceSubscriptionStatuses);

function safeNumber(value: unknown, fallback: number, max: number) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(max, Math.floor(parsed));
}

export async function POST(request: Request) {
  const startedAt = new Date().toISOString();
  if (!isWooCommerceConfigured()) {
    return NextResponse.json({ error: "WooCommerce is not configured.", saved: false }, { status: 400 });
  }

  const body = await request.json().catch(() => ({})) as {
    statuses?: string[];
    perPage?: number;
    maxPages?: number;
    dryRun?: boolean;
  };
  const statuses = (body.statuses?.length ? body.statuses : wooCommerceSubscriptionStatuses)
    .map((status) => status.trim().toLowerCase())
    .filter((status) => validStatuses.has(status));
  const perPage = safeNumber(body.perPage, 100, 100);
  const maxPages = safeNumber(body.maxPages, 100, 250);
  const dryRun = body.dryRun === true;

  const connection = await connectToDatabase();
  if (!connection) return NextResponse.json({ error: "MongoDB is unavailable.", saved: false }, { status: 503 });

  const job = await SyncJob.create({
    jobType: "woocommerce_backfill_subscriptions",
    status: "running",
    startedAt,
    progress: 0,
    totalPages: statuses.length * maxPages,
    pagesFetched: 0,
    recordsProcessed: 0,
    errors: [],
    warnings: dryRun ? ["Dry run: no WooCommerceSubscription records were written."] : [],
    lastCursor: { page: 0, status: "" },
  });

  const importedAt = new Date().toISOString();
  const failedRequests: Array<{ status: string; page: number; message: string }> = [];
  const warnings: string[] = [];
  const allSubscriptions = [];
  let pagesFetched = 0;
  let subscriptionsUpserted = 0;
  let partialSync = false;

  for (const status of statuses) {
    const result = await fetchWooCommerceSubscriptions({ statuses: [status], perPage, maxPages });
    if (!result) {
      partialSync = true;
      warnings.push(`${status}: WooCommerce subscriptions request was not available.`);
      continue;
    }

    pagesFetched += result.pagesFetched;
    partialSync = partialSync || result.partialSync;
    if (result.warning) warnings.push(`${status}: ${result.warning}`);
    failedRequests.push(...result.failedRequests);
    allSubscriptions.push(...result.items);

    if (!dryRun && result.items.length > 0) {
      const operations = result.items.map((subscription) => ({
        updateOne: {
          filter: { wooSubscriptionId: Number(subscription.id) },
          update: { $set: normalizeWooSubscription(subscription, importedAt) },
          upsert: true,
        },
      }));
      const writeResult = await WooCommerceSubscriptionRecord.bulkWrite(operations, { ordered: false });
      subscriptionsUpserted += writeResult.upsertedCount + writeResult.modifiedCount;
    }

    await SyncJob.updateOne(
      { _id: job._id },
      {
        $set: {
          pagesFetched,
          recordsProcessed: allSubscriptions.length,
          progress: Math.min(100, Math.round((pagesFetched / Math.max(1, statuses.length * maxPages)) * 100)),
          warnings,
          errors: failedRequests.map((item) => `${item.status} page ${item.page}: ${item.message}`),
          lastCursor: { page: result.pagesFetchedByStatus[status] ?? 0, status },
        },
      }
    );
  }

  if (allSubscriptions.length === 0 && failedRequests.length > 0) {
    partialSync = true;
    warnings.push("No subscriptions were imported because the WooCommerce Subscriptions endpoint failed or is unavailable.");
  }

  const statusCounts = countBy(allSubscriptions.map((subscription) => subscription.status ?? "unknown"));
  const finalStatus = partialSync || failedRequests.length > 0 ? "partial" : "completed";

  await SyncJob.updateOne(
    { _id: job._id },
    {
      $set: {
        status: finalStatus,
        finishedAt: new Date().toISOString(),
        progress: 100,
        pagesFetched,
        recordsProcessed: allSubscriptions.length,
        warnings,
        errors: failedRequests.map((item) => `${item.status} page ${item.page}: ${item.message}`),
      },
    }
  );

  return NextResponse.json({
    jobId: String(job._id),
    dryRun,
    pagesFetched,
    subscriptionsFetched: allSubscriptions.length,
    subscriptionsUpserted: dryRun ? 0 : subscriptionsUpserted,
    statusCounts,
    activeSubscriptions: allSubscriptions.filter((subscription) => subscription.status === "active").length,
    failedRequests,
    partialSync: finalStatus === "partial",
    warnings,
  });
}

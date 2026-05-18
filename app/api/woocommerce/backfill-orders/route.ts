import { NextResponse } from "next/server";
import { getOrderStatus } from "@/lib/businessMetrics";
import { countBy, normalizeWooOrder } from "@/lib/wooOrderImport";
import { connectToDatabase } from "@/lib/mongodb";
import { fetchWooCommerceOrders, isWooCommerceConfigured, wooCommerceOrderStatuses } from "@/lib/woocommerce";
import { SyncJob } from "@/models/SyncJob";
import { WooCommerceOrderRecord } from "@/models/WooCommerceOrder";

export const dynamic = "force-dynamic";

const validStatuses = new Set(wooCommerceOrderStatuses);

function isoDateBoundary(value: string | undefined, endOfDay = false) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return `${value}T${endOfDay ? "23:59:59" : "00:00:00"}`;
  }
  return date.toISOString();
}

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
    from?: string;
    to?: string;
    statuses?: string[];
    perPage?: number;
    maxPages?: number;
    dryRun?: boolean;
  };
  const statuses = (body.statuses?.length ? body.statuses : wooCommerceOrderStatuses)
    .map((status) => status.trim().toLowerCase())
    .filter((status) => validStatuses.has(status));
  const perPage = safeNumber(body.perPage, 100, 100);
  const maxPages = safeNumber(body.maxPages, 500, 1000);
  const dryRun = body.dryRun === true;

  const connection = await connectToDatabase();
  if (!connection) return NextResponse.json({ error: "MongoDB is unavailable.", saved: false }, { status: 503 });

  const job = await SyncJob.create({
    jobType: "woocommerce_backfill_orders",
    status: "running",
    startedAt,
    progress: 0,
    totalPages: statuses.length * maxPages,
    pagesFetched: 0,
    recordsProcessed: 0,
    errors: [],
    warnings: dryRun ? ["Dry run: no WooCommerceOrder records were written."] : [],
    lastCursor: { page: 0, status: "" },
  });

  const importedAt = new Date().toISOString();
  const failedRequests: Array<{ status: string; page: number; message: string }> = [];
  const warnings: string[] = [];
  const allOrders = [];
  let pagesFetched = 0;
  let ordersUpserted = 0;
  let partialSync = false;

  for (const status of statuses) {
    const result = await fetchWooCommerceOrders({
      statuses: [status],
      perPage,
      maxPages,
      after: isoDateBoundary(body.from),
      before: isoDateBoundary(body.to, true),
    });
    if (!result) {
      partialSync = true;
      warnings.push(`${status}: WooCommerce request was not available.`);
      continue;
    }

    pagesFetched += result.pagesFetched;
    partialSync = partialSync || result.partialSync;
    if (result.warning) warnings.push(`${status}: ${result.warning}`);
    failedRequests.push(...result.failedRequests);
    allOrders.push(...result.items);

    if (!dryRun && result.items.length > 0) {
      const operations = result.items.map((order) => ({
        updateOne: {
          filter: { wooOrderId: Number(order.id) },
          update: { $set: normalizeWooOrder(order, importedAt) },
          upsert: true,
        },
      }));
      const writeResult = await WooCommerceOrderRecord.bulkWrite(operations, { ordered: false });
      ordersUpserted += writeResult.upsertedCount + writeResult.modifiedCount;
    }

    await SyncJob.updateOne(
      { _id: job._id },
      {
        $set: {
          pagesFetched,
          recordsProcessed: allOrders.length,
          progress: Math.min(100, Math.round((pagesFetched / Math.max(1, statuses.length * maxPages)) * 100)),
          warnings,
          errors: failedRequests.map((item) => `${item.status} page ${item.page}: ${item.message}`),
          lastCursor: { page: result.pagesFetchedByStatus[status] ?? 0, status },
        },
      }
    );
  }

  const statusCounts = countBy(allOrders.map((order) => getOrderStatus(order)));
  const paymentMethodCounts = countBy(allOrders.map((order) => order.payment_method_title || order.payment_method || "unknown"));
  const paidOrders = allOrders.filter((order) => normalizeWooOrder(order).isPaid).length;
  const attemptedOrders = allOrders.length - paidOrders;
  const finalStatus = partialSync || failedRequests.length > 0 ? "partial" : "completed";

  await SyncJob.updateOne(
    { _id: job._id },
    {
      $set: {
        status: finalStatus,
        finishedAt: new Date().toISOString(),
        progress: 100,
        pagesFetched,
        recordsProcessed: allOrders.length,
        warnings,
        errors: failedRequests.map((item) => `${item.status} page ${item.page}: ${item.message}`),
      },
    }
  );

  return NextResponse.json({
    jobId: String(job._id),
    dryRun,
    pagesFetched,
    ordersFetched: allOrders.length,
    ordersUpserted: dryRun ? 0 : ordersUpserted,
    statusCounts,
    paymentMethodCounts,
    paidOrders,
    attemptedOrders,
    failedRequests,
    partialSync: finalStatus === "partial",
    warnings,
  });
}

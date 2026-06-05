import { countBy } from "@/lib/wooOrderImport";
import { normalizeWooSubscription } from "@/lib/wooSubscriptionImport";
import { fetchAuthorizeNetSubscriptionList, isAuthorizeNetConfigured, type AuthorizeNetSubscriptionSummary } from "@/lib/authorizeNet";
import { fetchWooCommerceSubscriptions, isWooCommerceConfigured, wooCommerceSubscriptionStatuses, type WooCommerceSubscription } from "@/lib/woocommerce";
import { connectToDatabase } from "@/lib/mongodb";
import { refreshUpcomingBillsSnapshot, repairGatewaySchedule, repairWooSchedule } from "@/lib/subscriptionSchedules";
import { AnalyticsSnapshot } from "@/models/AnalyticsSnapshot";
import { Customer } from "@/models/Customer";
import { Subscription, type SubscriptionDocument } from "@/models/Subscription";
import { WooCommerceSubscriptionRecord } from "@/models/WooCommerceSubscription";

export const activeWooStatus = "active";

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function money(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.round((parsed + Number.EPSILON) * 100) / 100 : 0;
}

function canonicalAuthorizeNetStatus(value: unknown) {
  const raw = clean(value).toLowerCase();
  if (raw === "active") return "active";
  if (raw.includes("active") && !raw.includes("in")) return "active";
  if (raw.includes("suspend") || raw.includes("past")) return "past_due";
  if (raw.includes("cancel") || raw.includes("terminate") || raw.includes("inactive")) return "canceled";
  if (raw.includes("expire")) return "canceled";
  return raw ? "unknown" : "unknown";
}

function authorizeNetSubscriptionRow(subscription: AuthorizeNetSubscriptionSummary, syncedAt: string): Partial<SubscriptionDocument> {
  const status = canonicalAuthorizeNetStatus(subscription.status);
  const schedule = repairGatewaySchedule({
    status: status as SubscriptionDocument["status"],
    nextBillingDate: "",
    lastBillingDate: "",
    billingInterval: "monthly",
    lastSyncedAt: subscription.createdAt || syncedAt,
  });
  return {
    subscriptionId: subscription.subscriptionId,
    source: "authorize_net",
    customerEmail: subscription.customerEmail || `authorize-net-sub-${subscription.subscriptionId}@authorize.local`,
    customerName: subscription.customerName || subscription.name || "Authorize.net Subscriber",
    customerPhone: subscription.customerPhone,
    authorizeNetCustomerProfileId: subscription.customerProfileId,
    gatewayCustomerId: subscription.customerProfileId,
    gatewayProfileId: subscription.customerPaymentProfileId || subscription.customerProfileId,
    status: status as SubscriptionDocument["status"],
    amount: subscription.amount,
    billingInterval: "monthly",
    nextBillingDate: schedule.nextPaymentDate,
    lastBillingDate: "",
    failedPaymentCount: 0,
    lastPaymentStatus: status,
    monthlyRecurringRevenue: status === "active" ? subscription.amount : 0,
    isPlaceholder: false,
    sourceStatus: "real",
    recordType: "subscription",
    lastSyncedAt: syncedAt,
    scheduleNeedsReview: schedule.scheduleNeedsReview,
    scheduleSource: schedule.scheduleSource,
  };
}

export async function fetchAllWooSubscriptions() {
  if (!isWooCommerceConfigured()) return { subscriptions: [] as WooCommerceSubscription[], warning: "WooCommerce is not configured.", failed: [] as Array<{ status: string; page: number; message: string }> };
  async function fetchStatusWithRetry(status: string) {
    let best: Awaited<ReturnType<typeof fetchWooCommerceSubscriptions>> = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await fetchWooCommerceSubscriptions({ statuses: [status], perPage: 100, maxPages: 100 });
      if (result && (!best || result.items.length > best.items.length)) best = result;
      if (result && !result.partialSync && !result.warning) return result;
    }
    return best;
  }
  const subscriptions: WooCommerceSubscription[] = [];
  const failed: Array<{ status: string; page: number; message: string }> = [];
  const warnings: string[] = [];
  const results = await Promise.all(wooCommerceSubscriptionStatuses.map(async (status) => ({
    status,
    result: await fetchStatusWithRetry(status),
  })));
  for (const { status, result } of results) {
    if (!result) {
      warnings.push(`${status}: WooCommerce subscriptions request unavailable.`);
      continue;
    }
    subscriptions.push(...result.items);
    failed.push(...result.failedRequests);
    if (result.warning) warnings.push(`${status}: ${result.warning}`);
  }
  return { subscriptions, warning: warnings.join(" "), failed };
}

export async function fetchAllAuthorizeNetSubscriptions() {
  if (!isAuthorizeNetConfigured()) return { subscriptions: [] as AuthorizeNetSubscriptionSummary[], warning: "Authorize.net is not configured.", totals: {} as Record<string, number> };
  const subscriptions: AuthorizeNetSubscriptionSummary[] = [];
  const totals: Record<string, number> = {};
  const warnings: string[] = [];
  for (const searchType of ["subscriptionActive", "subscriptionInactive"] as const) {
    let offset = 1;
    let total = 0;
    for (let page = 0; page < 10; page += 1) {
      try {
        const result = await fetchAuthorizeNetSubscriptionList(searchType, 100, offset);
        total = result.total || total;
        subscriptions.push(...result.subscriptions);
        if (result.subscriptions.length < 100) break;
        offset += result.subscriptions.length;
      } catch (error) {
        warnings.push(`${searchType}: ${error instanceof Error ? error.message : "request failed"}`);
        break;
      }
    }
    totals[searchType] = total || subscriptions.filter((subscription) => canonicalAuthorizeNetStatus(subscription.status) === (searchType === "subscriptionActive" ? "active" : "canceled")).length;
  }
  return { subscriptions, warning: warnings.join(" "), totals };
}

export async function readSubscriptionDashboardMetrics() {
  const [wooTotal, wooByStatus, wooMrr, authorizeNetTotal, authorizeNetActive, authorizeNetMrr, gatewayInferredActive] = await Promise.all([
    WooCommerceSubscriptionRecord.countDocuments({ status: { $ne: "deleted" } }),
    WooCommerceSubscriptionRecord.aggregate<{ _id: string; count: number }>([
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]),
    WooCommerceSubscriptionRecord.aggregate<{ _id: null; mrr: number }>([
      { $match: { status: activeWooStatus } },
      { $group: { _id: null, mrr: { $sum: { $ifNull: ["$recurringTotal", "$amount"] } } } },
    ]),
    Subscription.countDocuments({ source: "authorize_net", recordType: "subscription", sourceStatus: "real" }),
    Subscription.countDocuments({ source: "authorize_net", status: "active", recordType: "subscription", sourceStatus: "real" }),
    Subscription.aggregate<{ _id: null; mrr: number }>([
      { $match: { source: "authorize_net", status: "active", recordType: "subscription", sourceStatus: "real" } },
      { $group: { _id: null, mrr: { $sum: { $ifNull: ["monthlyRecurringRevenue", "$amount"] } } } },
    ]),
    Customer.countDocuments({ isGatewayRecurring: true }),
  ]);
  const byStatus = Object.fromEntries(wooByStatus.map((row) => [row._id || "unknown", row.count]));
  const wooActive = Number(byStatus.active ?? 0);
  const authMrr = money(authorizeNetMrr[0]?.mrr);
  const wooActiveMrr = money(wooMrr[0]?.mrr);
  return {
    totalSubscriptions: wooTotal + authorizeNetTotal,
    activeSubscriptions: wooActive + authorizeNetActive,
    activeWooSubscriptions: wooActive,
    activeAuthorizeNetSubscriptions: authorizeNetActive,
    activeGatewayRecurringCustomers: authorizeNetActive,
    inferredAuthorizeNetRecurringCustomers: gatewayInferredActive,
    totalActiveRecurringCustomers: wooActive + authorizeNetActive,
    monthlyRecurringRevenue: money(wooActiveMrr + authMrr),
    totalMonthlyRecurringRevenue: money(wooActiveMrr + authMrr),
    wooTotalSubscriptions: wooTotal,
    authorizeNetTotalSubscriptions: authorizeNetTotal,
    wooStatusCounts: byStatus,
    sourceNotes: `${wooActive} WooCommerce active + ${authorizeNetActive} Authorize.net active ARB`,
  };
}

export async function updateSubscriptionAnalyticsSnapshot() {
  const generatedAt = new Date().toISOString();
  const metrics = await readSubscriptionDashboardMetrics();
  const current = await AnalyticsSnapshot.findOne({ key: "dashboard_analytics" }).lean<{ payload?: Record<string, unknown> } | null>();
  await AnalyticsSnapshot.updateOne(
    { key: "dashboard_analytics" },
    {
      $set: {
        payload: {
          ...(current?.payload ?? {}),
          ...metrics,
          activeMRR: metrics.monthlyRecurringRevenue,
        },
        generatedAt,
        status: "ready",
      },
    },
    { upsert: true }
  );
  return { ...metrics, generatedAt };
}

async function updateCustomerWooSubscriptionCounts() {
  const activeByEmail = await WooCommerceSubscriptionRecord.aggregate<{ _id: string; count: number }>([
    { $match: { status: activeWooStatus, normalizedEmail: { $ne: "" } } },
    { $group: { _id: "$normalizedEmail", count: { $sum: 1 } } },
  ]);
  const operations = activeByEmail.map((row) => ({
    updateOne: {
      filter: { normalizedEmail: row._id },
      update: { $set: { activeSubscriptions: row.count, subscriptionStatus: row.count > 0 ? "active" : "inactive", "sourceCoverage.lastSubscriptionSyncAt": new Date().toISOString() } },
    },
  }));
  if (operations.length) await Customer.bulkWrite(operations, { ordered: false });
  return operations.length;
}

export async function fullRefreshSubscriptions({ source = "all", dryRun = true }: { source?: "woocommerce" | "authorizeNet" | "all"; dryRun?: boolean }) {
  await connectToDatabase();
  const startedAt = new Date().toISOString();
  const beforeMetrics = await readSubscriptionDashboardMetrics();
  let wooFetched = 0;
  let wooInserted = 0;
  let wooUpdated = 0;
  let authorizeNetFetched = 0;
  let authorizeNetInserted = 0;
  let authorizeNetUpdated = 0;
  let customersUpdated = 0;
  const warnings: string[] = dryRun ? ["Dry run: no subscription records were written."] : [];
  let wooStatusCounts: Record<string, number> = {};
  let authorizeNetStatusCounts: Record<string, number> = {};

  if (source === "all" || source === "woocommerce") {
    const woo = await fetchAllWooSubscriptions();
    if (woo.warning) warnings.push(woo.warning);
    wooFetched = woo.subscriptions.length;
    wooStatusCounts = countBy(woo.subscriptions.map((subscription) => clean(subscription.status || "unknown").toLowerCase()));
    const wooSourceComplete = !woo.warning && woo.failed.length === 0;
    if (!dryRun && woo.subscriptions.length && wooSourceComplete) {
      const operations = woo.subscriptions.map((subscription) => {
        const normalized = normalizeWooSubscription(subscription, startedAt);
        const schedule = repairWooSchedule({
          status: String(normalized.status ?? ""),
          nextPaymentDate: String(normalized.nextPaymentDate ?? ""),
          lastPaymentDate: String(normalized.lastPaymentDate ?? ""),
          startDate: String(normalized.startDate ?? ""),
          billingInterval: String(normalized.billingInterval ?? ""),
          billingPeriod: String(normalized.billingPeriod ?? ""),
        });
        return {
          updateOne: {
            filter: { wooSubscriptionId: Number(subscription.id) },
            update: { $set: { ...normalized, nextPaymentDate: schedule.nextPaymentDate, scheduleNeedsReview: schedule.scheduleNeedsReview, scheduleSource: schedule.scheduleSource } },
            upsert: true,
          },
        };
      });
      const write = await WooCommerceSubscriptionRecord.bulkWrite(operations, { ordered: false });
      wooInserted = write.upsertedCount;
      wooUpdated = write.modifiedCount;
      const fetchedIds = new Set(woo.subscriptions.map((subscription) => Number(subscription.id)));
      const storedIds = await WooCommerceSubscriptionRecord.find({}, { wooSubscriptionId: 1 }).lean<Array<{ wooSubscriptionId?: number }>>();
      const missingIds = storedIds.map((row) => Number(row.wooSubscriptionId ?? 0)).filter((id) => id && !fetchedIds.has(id));
      if (missingIds.length) {
        await WooCommerceSubscriptionRecord.updateMany({ wooSubscriptionId: { $in: missingIds } }, { $set: { status: "deleted", importedAt: startedAt } }).exec();
      }
      customersUpdated += await updateCustomerWooSubscriptionCounts();
    } else if (!dryRun && !wooSourceComplete) {
      warnings.push("WooCommerce subscription write skipped because source fetch was partial.");
    }
  }

  if (source === "all" || source === "authorizeNet") {
    const auth = await fetchAllAuthorizeNetSubscriptions();
    if (auth.warning) warnings.push(auth.warning);
    const unique = Array.from(new Map(auth.subscriptions.map((subscription) => [subscription.subscriptionId, subscription])).values());
    authorizeNetFetched = unique.length;
    authorizeNetStatusCounts = countBy(unique.map((subscription) => canonicalAuthorizeNetStatus(subscription.status)));
    if (!dryRun && unique.length) {
      const operations = unique.map((subscription) => ({
        updateOne: {
          filter: { source: "authorize_net", subscriptionId: subscription.subscriptionId },
          update: { $set: authorizeNetSubscriptionRow(subscription, startedAt) },
          upsert: true,
        },
      }));
      const write = await Subscription.bulkWrite(operations, { ordered: false });
      authorizeNetInserted = write.upsertedCount;
      authorizeNetUpdated = write.modifiedCount;
    }
  }

  const afterMetrics = dryRun ? beforeMetrics : await updateSubscriptionAnalyticsSnapshot();
  if (!dryRun) await refreshUpcomingBillsSnapshot();
  return {
    dryRun,
    source,
    wooFetched,
    wooInserted,
    wooUpdated,
    wooStatusCounts,
    authorizeNetFetched,
    authorizeNetInserted,
    authorizeNetUpdated,
    authorizeNetStatusCounts,
    missingBefore: Math.max(0, Number(beforeMetrics.wooTotalSubscriptions ?? 0) - wooFetched),
    missingAfter: dryRun ? Math.max(0, Number(beforeMetrics.wooTotalSubscriptions ?? 0) - wooFetched) : 0,
    activeBefore: beforeMetrics.activeSubscriptions,
    activeAfter: afterMetrics.activeSubscriptions,
    dashboardBefore: beforeMetrics,
    dashboardAfter: afterMetrics,
    customersUpdated,
    warnings: warnings.filter(Boolean),
  };
}

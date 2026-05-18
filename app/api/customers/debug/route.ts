import { NextResponse } from "next/server";
import { connectToDatabase } from "@/lib/mongodb";
import { Customer } from "@/models/Customer";

export const dynamic = "force-dynamic";

const DEBUG_ROUTE_TIMEOUT_MS = 5000;
const DEBUG_LIMIT = 10;

type DebugSourceCoverage = {
  deepWooSearch?: boolean;
  ordersStored?: number;
  ordersStoredCount?: number;
  matchReasonCounts?: Record<string, number>;
  statusCounts?: Record<string, number>;
  paymentMethodCounts?: Record<string, number>;
  syncStatus?: string;
  lastDeepSyncAt?: string;
  lastAttemptedDeepSyncAt?: string;
  lastDeepSyncStatus?: string;
  lastSyncedAt?: string;
  warningSummary?: string;
  warnings?: string[];
};

type DebugLineItem = {
  name?: string;
};

type DebugOrder = {
  orderNumber?: string;
  status?: string;
  total?: number;
  paymentMethod?: string;
  paymentMethodTitle?: string;
  matchedBy?: string[];
  matchConfidence?: string;
  lineItems?: DebugLineItem[];
};

type DebugCustomer = {
  _id: unknown;
  email?: string;
  normalizedEmail?: string;
  updatedAt?: string;
  paidTotal?: number;
  totalPaid?: number;
  attemptedTotal?: number;
  paidOrderCount?: number;
  attemptedOrderCount?: number;
  orderCount?: number;
  productJourneyCount?: number;
  orders?: DebugOrder[];
  sourceCoverage?: DebugSourceCoverage;
};

function withTimeout<T>(promise: Promise<T>, timeoutMs: number) {
  return Promise.race([
    promise.then((value) => ({ timedOut: false as const, value })),
    new Promise<{ timedOut: true; value: null }>((resolve) => {
      setTimeout(() => resolve({ timedOut: true, value: null }), timeoutMs);
    }),
  ]);
}

function sourceCoverageSummary(customer: DebugCustomer | null) {
  const coverage = customer?.sourceCoverage;
  return {
    ordersStored: Number(coverage?.ordersStored ?? coverage?.ordersStoredCount ?? customer?.orders?.length ?? customer?.orderCount ?? 0),
    matchReasonCounts: coverage?.matchReasonCounts ?? {},
    statusCounts: coverage?.statusCounts ?? {},
    paymentMethodCounts: coverage?.paymentMethodCounts ?? {},
    syncStatus: coverage?.syncStatus ?? "",
    lastDeepSyncAt: coverage?.lastDeepSyncAt ?? "",
    lastAttemptedDeepSyncAt: coverage?.lastAttemptedDeepSyncAt ?? "",
    lastDeepSyncStatus: coverage?.lastDeepSyncStatus ?? "",
    warningSummary: coverage?.warningSummary || coverage?.warnings?.join(" ") || "",
  };
}

function orderSummary(order: DebugOrder) {
  return {
    orderNumber: order.orderNumber ?? "",
    status: order.status ?? "",
    amount: Number(order.total ?? 0),
    paymentMethod: order.paymentMethodTitle || order.paymentMethod || "",
    products: (order.lineItems ?? []).map((item) => item.name).filter(Boolean),
    matchedBy: order.matchedBy ?? [],
    matchConfidence: order.matchConfidence ?? "",
  };
}

function ordersStoredCount(customer: DebugCustomer | null) {
  return Number(customer?.sourceCoverage?.ordersStored ?? customer?.sourceCoverage?.ordersStoredCount ?? customer?.orders?.length ?? customer?.orderCount ?? 0);
}

function chooseDebugCustomer(customers: DebugCustomer[]) {
  return [...customers].sort((a, b) => {
    const orderDiff = Number(ordersStoredCount(b) > 0) - Number(ordersStoredCount(a) > 0);
    if (orderDiff !== 0) return orderDiff;
    return new Date(b.updatedAt ?? 0).getTime() - new Date(a.updatedAt ?? 0).getTime();
  })[0] ?? null;
}

async function findDebugCustomers(normalizedEmail: string) {
  const projection = {
    _id: 1,
    email: 1,
    normalizedEmail: 1,
    updatedAt: 1,
    paidTotal: 1,
    totalPaid: 1,
    attemptedTotal: 1,
    paidOrderCount: 1,
    attemptedOrderCount: 1,
    orderCount: 1,
    sourceCoverage: 1,
    orders: { $slice: DEBUG_LIMIT },
    productJourneyCount: { $cond: [{ $isArray: "$productJourney" }, { $size: "$productJourney" }, 0] },
  } as Record<string, unknown>;

  const byNormalized = await Customer.find({ normalizedEmail }, projection)
    .sort({ updatedAt: -1 })
    .limit(DEBUG_LIMIT)
    .lean<DebugCustomer[]>()
    .exec();
  if (byNormalized.length > 0) return { customers: byNormalized, reason: "normalizedEmail_exact" };

  const byEmail = await Customer.find({ email: normalizedEmail }, projection)
    .sort({ updatedAt: -1 })
    .limit(DEBUG_LIMIT)
    .lean<DebugCustomer[]>()
    .exec();
  return { customers: byEmail, reason: "email_exact_fallback" };
}

export async function GET(request: Request) {
  const startedAt = Date.now();
  const { searchParams } = new URL(request.url);
  const email = (searchParams.get("email") ?? "").trim().toLowerCase();
  if (!email) return NextResponse.json({ error: "email query parameter is required" }, { status: 400 });

  const connectionResult = await withTimeout(connectToDatabase(), DEBUG_ROUTE_TIMEOUT_MS);
  if (connectionResult.timedOut) {
    return NextResponse.json({ email, customerFound: false, error: "MongoDB connection timed out.", dbLookupMs: Date.now() - startedAt }, { status: 504 });
  }
  if (!connectionResult.value) {
    return NextResponse.json({ email, customerFound: false, error: "MongoDB is unavailable.", dbLookupMs: Date.now() - startedAt }, { status: 503 });
  }

  let lookupResult: { timedOut: false; value: { customers: DebugCustomer[]; reason: string } } | { timedOut: true; value: null };
  try {
    lookupResult = await withTimeout(findDebugCustomers(email), Math.max(1, DEBUG_ROUTE_TIMEOUT_MS - (Date.now() - startedAt)));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Debug lookup failed.";
    return NextResponse.json({ email, customerFound: false, error: message, dbLookupMs: Date.now() - startedAt }, { status: 500 });
  }

  if (lookupResult.timedOut) {
    return NextResponse.json({ email, customerFound: false, error: "Debug lookup timed out.", dbLookupMs: Date.now() - startedAt }, { status: 504 });
  }

  const candidates = lookupResult.value.customers;
  const customer = chooseDebugCustomer(candidates);
  const storedOrders = (customer?.orders ?? []).slice(0, DEBUG_LIMIT).map(orderSummary);
  const productJourneyCount = Number(customer?.productJourneyCount ?? 0);

  return NextResponse.json({
    email,
    customerFound: Boolean(customer),
    mongoId: customer ? String(customer._id) : "",
    documentsWithSameEmail: candidates.length,
    selectedDocumentReason: customer ? `${lookupResult.value.reason}_${ordersStoredCount(customer) > 0 ? "with_orders" : "newest"}` : "not_found",
    dbLookupMs: Date.now() - startedAt,
    ordersStoredCount: ordersStoredCount(customer),
    paidTotal: customer?.paidTotal ?? customer?.totalPaid ?? 0,
    attemptedTotal: customer?.attemptedTotal ?? 0,
    paidOrderCount: customer?.paidOrderCount ?? 0,
    attemptedOrderCount: customer?.attemptedOrderCount ?? 0,
    sourceCoverage: sourceCoverageSummary(customer),
    storedOrders,
    productJourneyCount,
  });
}

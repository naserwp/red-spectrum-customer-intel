import { NextResponse } from "next/server";
import { connectToDatabase } from "@/lib/mongodb";
import { Customer } from "@/models/Customer";

export const dynamic = "force-dynamic";

const DEBUG_QUERY_TIMEOUT_MS = 2000;
const DEBUG_ROUTE_TIMEOUT_MS = 2800;

type DebugSourceCoverage = {
  deepWooSearch?: boolean;
  ordersStored?: number;
  ordersStoredCount?: number;
  matchReasonCounts?: Record<string, number>;
  statusCounts?: Record<string, number>;
  paymentMethodCounts?: Record<string, number>;
  syncStatus?: string;
  lastDeepSyncAt?: string;
  lastSyncedAt?: string;
  warningSummary?: string;
  warnings?: string[];
};

type DebugCustomer = {
  _id: unknown;
  sourceCoverage?: DebugSourceCoverage;
  ordersStoredCount?: number;
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
    ordersStored: Number(coverage?.ordersStored ?? coverage?.ordersStoredCount ?? customer?.ordersStoredCount ?? 0),
    matchReasonCounts: coverage?.matchReasonCounts ?? {},
    statusCounts: coverage?.statusCounts ?? {},
    paymentMethodCounts: coverage?.paymentMethodCounts ?? {},
    syncStatus: coverage?.syncStatus ?? "",
    lastDeepSyncAt: coverage?.lastDeepSyncAt ?? "",
    warningSummary: coverage?.warningSummary || coverage?.warnings?.join(" ") || "",
  };
}

async function findDebugCustomer(email: string) {
  return Customer.findOne(
    { email },
    {
      _id: 1,
      sourceCoverage: 1,
      ordersStoredCount: { $cond: [{ $isArray: "$orders" }, { $size: "$orders" }, 0] },
    }
  )
    .sort({ updatedAt: -1, lastSyncedAt: -1 })
    .maxTimeMS(DEBUG_QUERY_TIMEOUT_MS)
    .lean<DebugCustomer | null>()
    .exec();
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

  const remainingMs = Math.max(250, DEBUG_ROUTE_TIMEOUT_MS - (Date.now() - startedAt));
  let queryResult: { timedOut: false; value: DebugCustomer | null } | { timedOut: true; value: null };
  try {
    queryResult = await withTimeout(findDebugCustomer(email), remainingMs);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Debug lookup failed.";
    const timedOut = message.toLowerCase().includes("timed out") || message.toLowerCase().includes("maxtimems");
    return NextResponse.json({ email, customerFound: false, error: timedOut ? "Debug lookup timed out." : message, dbLookupMs: Date.now() - startedAt }, { status: timedOut ? 504 : 500 });
  }

  if (queryResult.timedOut) {
    return NextResponse.json({ email, customerFound: false, error: "Debug lookup timed out.", dbLookupMs: Date.now() - startedAt }, { status: 504 });
  }

  const customer = queryResult.value;
  return NextResponse.json({
    email,
    customerFound: Boolean(customer),
    mongoId: customer ? String(customer._id) : "",
    dbLookupMs: Date.now() - startedAt,
    sourceCoverage: sourceCoverageSummary(customer),
  });
}

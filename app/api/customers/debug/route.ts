import { NextResponse } from "next/server";
import { connectToDatabase } from "@/lib/mongodb";
import { Customer } from "@/models/Customer";

export const dynamic = "force-dynamic";

const DEBUG_QUERY_TIMEOUT_MS = 2000;
const DEBUG_ROUTE_TIMEOUT_MS = 2800;
const DUPLICATE_LIMIT = 10;
const ARRAY_LIMIT = 10;

type DebugStoredOrder = {
  orderNumber?: string;
  status?: string;
  amount?: number;
  paymentMethod?: string;
  products?: string[];
};

type DebugCustomerResult = {
  _id: unknown;
  email: string;
  orderCount?: number;
  paidTotal?: number;
  totalPaid?: number;
  attemptedTotal?: number;
  paidOrderCount?: number;
  attemptedOrderCount?: number;
  attemptedProducts?: string[];
  paidProducts?: string[];
  lastProducts?: string[];
  firstSignupProduct?: string;
  firstSignupDate?: string;
  firstSignupAmount?: number;
  baseProductsPurchased?: string[];
  boostProductsPurchased?: string[];
  addOnProductsPurchased?: string[];
  attemptedBaseProducts?: string[];
  attemptedBoostProducts?: string[];
  attemptedAddOnProducts?: string[];
  lastPurchasedProduct?: string;
  lastAttemptedProduct?: string;
  lastAttemptDate?: string;
  lastAttemptPaymentMethod?: string;
  lastAttemptStatus?: string;
  leadStatus?: string;
  paymentStatus?: string;
  tier?: string;
  documentsWithSameEmail: number;
  hasOrdersArray: boolean;
  ordersStoredCount: number;
  productJourneyCount: number;
  storedOrders: DebugStoredOrder[];
  productJourney: Array<Record<string, unknown>>;
  gatewayVerification?: {
    provider?: string;
    matched?: boolean;
    confidence?: string;
    matchedBy?: string;
    transactionStatus?: string;
    lastCheckedAt?: string;
    configured?: boolean;
    notes?: string;
  };
};

function withTimeout<T>(promise: Promise<T>, timeoutMs: number) {
  return Promise.race([
    promise.then((value) => ({ timedOut: false as const, value })),
    new Promise<{ timedOut: true; value: null }>((resolve) => {
      setTimeout(() => resolve({ timedOut: true, value: null }), timeoutMs);
    }),
  ]);
}

function storedOrderStatusCounts(storedOrders: DebugStoredOrder[]) {
  return storedOrders.reduce<Record<string, number>>((acc, order) => {
    const status = order.status || "unknown";
    acc[status] = (acc[status] ?? 0) + 1;
    return acc;
  }, {});
}

async function findDebugCustomers(email: string) {
  return Customer.aggregate<DebugCustomerResult>([
    { $match: { email } },
    {
      $addFields: {
        hasOrdersArray: { $isArray: "$orders" },
        ordersForDebug: { $cond: [{ $isArray: "$orders" }, "$orders", []] },
        productJourneyForDebug: { $cond: [{ $isArray: "$productJourney" }, "$productJourney", []] },
      },
    },
    {
      $addFields: {
        ordersStoredCount: { $size: "$ordersForDebug" },
        productJourneyCount: { $size: "$productJourneyForDebug" },
      },
    },
    {
      $addFields: {
        hasOrdersSort: { $cond: [{ $gt: ["$ordersStoredCount", 0] }, 1, 0] },
      },
    },
    { $sort: { hasOrdersSort: -1, updatedAt: -1, lastSyncedAt: -1 } },
    { $limit: DUPLICATE_LIMIT },
    {
      $project: {
        _id: 1,
        email: 1,
        orderCount: 1,
        paidTotal: 1,
        totalPaid: 1,
        attemptedTotal: 1,
        paidOrderCount: 1,
        attemptedOrderCount: 1,
        attemptedProducts: 1,
        paidProducts: 1,
        lastProducts: 1,
        firstSignupProduct: 1,
        firstSignupDate: 1,
        firstSignupAmount: 1,
        baseProductsPurchased: 1,
        boostProductsPurchased: 1,
        addOnProductsPurchased: 1,
        attemptedBaseProducts: 1,
        attemptedBoostProducts: 1,
        attemptedAddOnProducts: 1,
        lastPurchasedProduct: 1,
        lastAttemptedProduct: 1,
        lastAttemptDate: 1,
        lastAttemptPaymentMethod: 1,
        lastAttemptStatus: 1,
        leadStatus: 1,
        paymentStatus: 1,
        tier: 1,
        hasOrdersArray: 1,
        ordersStoredCount: 1,
        productJourneyCount: 1,
        storedOrders: {
          $map: {
            input: { $slice: ["$ordersForDebug", ARRAY_LIMIT] },
            as: "order",
            in: {
              orderNumber: "$$order.orderNumber",
              status: "$$order.status",
              amount: "$$order.total",
              paymentMethod: { $ifNull: ["$$order.paymentMethodTitle", "$$order.paymentMethod"] },
              products: {
                $map: {
                  input: { $ifNull: ["$$order.lineItems", []] },
                  as: "item",
                  in: "$$item.name",
                },
              },
            },
          },
        },
        productJourney: { $slice: ["$productJourneyForDebug", ARRAY_LIMIT] },
        gatewayVerification: {
          provider: "$gatewayVerification.provider",
          matched: "$gatewayVerification.matched",
          confidence: "$gatewayVerification.confidence",
          matchedBy: "$gatewayVerification.matchedBy",
          transactionStatus: "$gatewayVerification.transactionStatus",
          lastCheckedAt: "$gatewayVerification.lastCheckedAt",
          configured: "$gatewayVerification.configured",
          notes: "$gatewayVerification.notes",
        },
      },
    },
  ]).option({ maxTimeMS: DEBUG_QUERY_TIMEOUT_MS }).exec();
}

export async function GET(request: Request) {
  const startedAt = Date.now();
  const { searchParams } = new URL(request.url);
  const email = (searchParams.get("email") ?? "").trim().toLowerCase();
  if (!email) return NextResponse.json({ error: "email query parameter is required" }, { status: 400 });

  const connectionResult = await withTimeout(connectToDatabase(), DEBUG_ROUTE_TIMEOUT_MS);
  if (connectionResult.timedOut) {
    return NextResponse.json({
      email,
      customerFound: false,
      error: "MongoDB connection timed out.",
      dbLookupMs: Date.now() - startedAt,
      responseTruncated: false,
    }, { status: 504 });
  }

  if (!connectionResult.value) {
    return NextResponse.json({
      email,
      customerFound: false,
      error: "MongoDB is unavailable.",
      dbLookupMs: Date.now() - startedAt,
      responseTruncated: false,
    }, { status: 503 });
  }

  const remainingMs = Math.max(250, DEBUG_ROUTE_TIMEOUT_MS - (Date.now() - startedAt));
  let queryResult: { timedOut: false; value: DebugCustomerResult[] } | { timedOut: true; value: null };
  try {
    queryResult = await withTimeout(findDebugCustomers(email), remainingMs);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Debug lookup failed.";
    const timedOut = message.toLowerCase().includes("timed out") || message.toLowerCase().includes("maxtimems");
    return NextResponse.json({
      email,
      customerFound: false,
      error: timedOut ? "Debug lookup timed out." : message,
      dbLookupMs: Date.now() - startedAt,
      responseTruncated: false,
    }, { status: timedOut ? 504 : 500 });
  }
  const dbLookupMs = Date.now() - startedAt;
  if (queryResult.timedOut) {
    return NextResponse.json({
      email,
      customerFound: false,
      error: "Debug lookup timed out.",
      dbLookupMs,
      responseTruncated: false,
    }, { status: 504 });
  }

  const candidates = queryResult.value;
  const customer = candidates[0];
  if (!customer) {
    return NextResponse.json({
      email,
      customerFound: false,
      dbLookupMs,
      selectedDocumentReason: "not_found",
      documentsWithSameEmail: 0,
      responseTruncated: false,
    });
  }

  const responseTruncated =
    candidates.length >= DUPLICATE_LIMIT ||
    customer.ordersStoredCount > customer.storedOrders.length ||
    customer.productJourneyCount > customer.productJourney.length;
  const selectedDocumentReason = customer.ordersStoredCount > 0 ? "debug_exact_email_with_orders" : "debug_exact_email_latest";

  return NextResponse.json({
    email,
    customerFound: true,
    mongoId: String(customer._id),
    dbLookupMs,
    selectedDocumentReason,
    documentsWithSameEmail: candidates.length,
    hasOrdersArray: customer.hasOrdersArray,
    orderCount: customer.orderCount ?? 0,
    paidTotal: customer.paidTotal ?? customer.totalPaid ?? 0,
    attemptedTotal: customer.attemptedTotal ?? 0,
    paidOrderCount: customer.paidOrderCount ?? 0,
    attemptedOrderCount: customer.attemptedOrderCount ?? 0,
    ordersStoredCount: customer.ordersStoredCount,
    attemptedProducts: customer.attemptedProducts ?? [],
    paidProducts: customer.paidProducts ?? [],
    lastProducts: customer.lastProducts ?? [],
    firstSignupProduct: customer.firstSignupProduct ?? "",
    firstSignupDate: customer.firstSignupDate ?? "",
    firstSignupAmount: customer.firstSignupAmount ?? 0,
    baseProductsPurchased: customer.baseProductsPurchased ?? [],
    boostProductsPurchased: customer.boostProductsPurchased ?? [],
    addOnProductsPurchased: customer.addOnProductsPurchased ?? [],
    attemptedBaseProducts: customer.attemptedBaseProducts ?? [],
    attemptedBoostProducts: customer.attemptedBoostProducts ?? [],
    attemptedAddOnProducts: customer.attemptedAddOnProducts ?? [],
    lastPurchasedProduct: customer.lastPurchasedProduct ?? "",
    lastAttemptedProduct: customer.lastAttemptedProduct ?? "",
    productJourneyCount: customer.productJourneyCount,
    productJourney: customer.productJourney,
    lastAttemptDate: customer.lastAttemptDate ?? "",
    lastAttemptPaymentMethod: customer.lastAttemptPaymentMethod ?? "",
    lastAttemptStatus: customer.lastAttemptStatus ?? "",
    leadStatus: customer.leadStatus ?? "",
    paymentStatus: customer.paymentStatus ?? "",
    tier: customer.tier ?? "",
    storedOrderStatusCounts: storedOrderStatusCounts(customer.storedOrders),
    storedOrders: customer.storedOrders,
    gatewayVerification: customer.gatewayVerification ?? null,
    responseTruncated,
  });
}

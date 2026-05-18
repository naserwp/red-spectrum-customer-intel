import { NextResponse } from "next/server";
import { connectToDatabase } from "@/lib/mongodb";
import { Customer } from "@/models/Customer";

export const dynamic = "force-dynamic";

const DEBUG_QUERY_TIMEOUT_MS = 2000;
const DEBUG_ROUTE_TIMEOUT_MS = 2800;
const DUPLICATE_LIMIT = 10;
const ARRAY_LIMIT = 10;

type DebugGatewayVerification = {
  provider?: string;
  matched?: boolean;
  confidence?: string;
  matchedBy?: string;
  transactionId?: string;
  transactionStatus?: string;
  amount?: number;
  transactionDate?: string;
  customerVaultId?: string;
  paymentProfileId?: string;
  customerProfileId?: string;
  paymentIntentId?: string;
  chargeId?: string;
  stripeCustomerId?: string;
  paymentMethodId?: string;
  last4?: string;
  cardType?: string;
  candidatesCount?: number;
  rawSummary?: string;
  lastCheckedAt?: string;
  configured?: boolean;
  notes?: string;
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
  lineItems?: DebugLineItem[];
  gatewayVerification?: DebugGatewayVerification;
};

type DebugCustomer = {
  _id: unknown;
  email?: string;
  orderCount?: number;
  paidTotal?: number;
  totalPaid?: number;
  attemptedTotal?: number;
  paidOrderCount?: number;
  attemptedOrderCount?: number;
  paidProducts?: string[];
  attemptedProducts?: string[];
  firstSignupProduct?: string;
  firstSignupDate?: string;
  firstSignupAmount?: number;
  baseProductsPurchased?: string[];
  boostProductsPurchased?: string[];
  hasOrdersArray?: boolean;
  ordersStoredCount?: number;
  productJourneyCount?: number;
  orders?: DebugOrder[];
  productJourney?: Array<Record<string, unknown>>;
  gatewayVerification?: DebugGatewayVerification;
  authorizeMatchedOrders?: number;
  authorizeUnmatchedOrders?: number;
  authorizeLastCheckedAt?: string;
  nmiMatchedOrders?: number;
  nmiUnmatchedOrders?: number;
  nmiLastCheckedAt?: string;
  stripeMatchedOrders?: number;
  stripeUnmatchedOrders?: number;
  stripeLastCheckedAt?: string;
};

function withTimeout<T>(promise: Promise<T>, timeoutMs: number) {
  return Promise.race([
    promise.then((value) => ({ timedOut: false as const, value })),
    new Promise<{ timedOut: true; value: null }>((resolve) => {
      setTimeout(() => resolve({ timedOut: true, value: null }), timeoutMs);
    }),
  ]);
}

function gatewaySummary(verification?: DebugGatewayVerification) {
  if (!verification) return null;
  const candidatesCount = Number(verification.candidatesCount ?? 0);
  return {
    provider: verification.provider ?? "",
    matched: Boolean(verification.matched),
    confidence: verification.confidence ?? "not_found",
    matchedBy: verification.matchedBy ?? "",
    transactionId: verification.transactionId ?? "",
    transactionStatus: verification.transactionStatus ?? "",
    amount: Number(verification.amount ?? 0),
    transactionDate: verification.transactionDate ?? "",
    customerVaultId: verification.customerVaultId ?? "",
    paymentProfileId: verification.paymentProfileId ?? "",
    customerProfileId: verification.customerProfileId ?? "",
    paymentIntentId: verification.paymentIntentId ?? "",
    chargeId: verification.chargeId ?? "",
    stripeCustomerId: verification.stripeCustomerId ?? "",
    paymentMethodId: verification.paymentMethodId ?? "",
    last4: verification.last4 ?? "",
    cardType: verification.cardType ?? "",
    candidatesCount: verification.matched ? Math.max(1, candidatesCount) : candidatesCount,
    rawSummary: verification.rawSummary ?? "",
    lastCheckedAt: verification.lastCheckedAt ?? "",
    configured: Boolean(verification.configured),
    notes: verification.notes ?? "",
  };
}

function orderSummary(order: DebugOrder) {
  return {
    orderNumber: order.orderNumber ?? "",
    status: order.status ?? "",
    amount: Number(order.total ?? 0),
    paymentMethod: order.paymentMethodTitle || order.paymentMethod || "",
    products: (order.lineItems ?? []).map((item) => item.name).filter(Boolean),
    gatewayVerification: gatewaySummary(order.gatewayVerification),
  };
}

const debugProjection = {
  _id: 1,
  email: 1,
  orderCount: 1,
  paidTotal: 1,
  totalPaid: 1,
  attemptedTotal: 1,
  paidOrderCount: 1,
  attemptedOrderCount: 1,
  paidProducts: 1,
  attemptedProducts: 1,
  firstSignupProduct: 1,
  firstSignupDate: 1,
  firstSignupAmount: 1,
  baseProductsPurchased: 1,
  boostProductsPurchased: 1,
  gatewayVerification: 1,
  hasOrdersArray: { $isArray: "$orders" },
  ordersStoredCount: { $cond: [{ $isArray: "$orders" }, { $size: "$orders" }, 0] },
  productJourneyCount: { $cond: [{ $isArray: "$productJourney" }, { $size: "$productJourney" }, 0] },
  stripeMatchedOrders: {
    $cond: [
      { $isArray: "$orders" },
      {
        $size: {
          $filter: {
            input: "$orders",
            as: "order",
            cond: {
              $and: [
                { $eq: ["$$order.gatewayVerification.provider", "stripe"] },
                { $eq: ["$$order.gatewayVerification.matched", true] },
              ],
            },
          },
        },
      },
      0,
    ],
  },
  stripeUnmatchedOrders: {
    $cond: [
      { $isArray: "$orders" },
      {
        $size: {
          $filter: {
            input: "$orders",
            as: "order",
            cond: {
              $and: [
                { $eq: ["$$order.gatewayVerification.provider", "stripe"] },
                { $ne: ["$$order.gatewayVerification.matched", true] },
              ],
            },
          },
        },
      },
      0,
    ],
  },
  stripeLastCheckedAt: {
    $cond: [
      { $isArray: "$orders" },
      {
        $reduce: {
          input: {
            $filter: {
              input: "$orders",
              as: "order",
              cond: { $eq: ["$$order.gatewayVerification.provider", "stripe"] },
            },
          },
          initialValue: "",
          in: {
            $cond: [
              { $gt: [{ $ifNull: ["$$this.gatewayVerification.lastCheckedAt", ""] }, "$$value"] },
              { $ifNull: ["$$this.gatewayVerification.lastCheckedAt", ""] },
              "$$value",
            ],
          },
        },
      },
      "",
    ],
  },
  authorizeMatchedOrders: {
    $cond: [
      { $isArray: "$orders" },
      {
        $size: {
          $filter: {
            input: "$orders",
            as: "order",
            cond: {
              $and: [
                { $eq: ["$$order.gatewayVerification.provider", "authorize_net"] },
                { $eq: ["$$order.gatewayVerification.matched", true] },
              ],
            },
          },
        },
      },
      0,
    ],
  },
  authorizeUnmatchedOrders: {
    $cond: [
      { $isArray: "$orders" },
      {
        $size: {
          $filter: {
            input: "$orders",
            as: "order",
            cond: {
              $and: [
                { $eq: ["$$order.gatewayVerification.provider", "authorize_net"] },
                { $ne: ["$$order.gatewayVerification.matched", true] },
              ],
            },
          },
        },
      },
      0,
    ],
  },
  authorizeLastCheckedAt: {
    $cond: [
      { $isArray: "$orders" },
      {
        $reduce: {
          input: {
            $filter: {
              input: "$orders",
              as: "order",
              cond: { $eq: ["$$order.gatewayVerification.provider", "authorize_net"] },
            },
          },
          initialValue: "",
          in: {
            $cond: [
              { $gt: [{ $ifNull: ["$$this.gatewayVerification.lastCheckedAt", ""] }, "$$value"] },
              { $ifNull: ["$$this.gatewayVerification.lastCheckedAt", ""] },
              "$$value",
            ],
          },
        },
      },
      "",
    ],
  },
  nmiMatchedOrders: {
    $cond: [
      { $isArray: "$orders" },
      {
        $size: {
          $filter: {
            input: "$orders",
            as: "order",
            cond: {
              $and: [
                { $in: ["$$order.gatewayVerification.provider", ["nmi", "cliq"]] },
                { $eq: ["$$order.gatewayVerification.matched", true] },
              ],
            },
          },
        },
      },
      0,
    ],
  },
  nmiUnmatchedOrders: {
    $cond: [
      { $isArray: "$orders" },
      {
        $size: {
          $filter: {
            input: "$orders",
            as: "order",
            cond: {
              $and: [
                { $in: ["$$order.gatewayVerification.provider", ["nmi", "cliq"]] },
                { $ne: ["$$order.gatewayVerification.matched", true] },
              ],
            },
          },
        },
      },
      0,
    ],
  },
  nmiLastCheckedAt: {
    $cond: [
      { $isArray: "$orders" },
      {
        $reduce: {
          input: {
            $filter: {
              input: "$orders",
              as: "order",
              cond: { $in: ["$$order.gatewayVerification.provider", ["nmi", "cliq"]] },
            },
          },
          initialValue: "",
          in: {
            $cond: [
              { $gt: [{ $ifNull: ["$$this.gatewayVerification.lastCheckedAt", ""] }, "$$value"] },
              { $ifNull: ["$$this.gatewayVerification.lastCheckedAt", ""] },
              "$$value",
            ],
          },
        },
      },
      "",
    ],
  },
  orders: { $slice: ARRAY_LIMIT },
  productJourney: { $slice: ARRAY_LIMIT },
} as Record<string, unknown>;

async function findDebugCustomers(email: string) {
  return Customer.find({ email }, debugProjection)
    .sort({ updatedAt: -1, lastSyncedAt: -1 })
    .limit(DUPLICATE_LIMIT)
    .maxTimeMS(DEBUG_QUERY_TIMEOUT_MS)
    .lean<DebugCustomer[]>()
    .exec();
}

function chooseDebugCustomer(customers: DebugCustomer[]) {
  return customers.find((customer) => Number(customer.ordersStoredCount ?? customer.orders?.length ?? 0) > 0) ?? customers[0] ?? null;
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
  let queryResult: { timedOut: false; value: DebugCustomer[] } | { timedOut: true; value: null };
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
  const customer = chooseDebugCustomer(candidates);
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

  const storedOrders = (customer.orders ?? []).slice(0, ARRAY_LIMIT).map(orderSummary);
  const productJourney = (customer.productJourney ?? []).slice(0, ARRAY_LIMIT);
  const ordersStoredCount = Number(customer.ordersStoredCount ?? customer.orders?.length ?? 0);
  const productJourneyCount = Number(customer.productJourneyCount ?? customer.productJourney?.length ?? 0);
  const responseTruncated =
    candidates.length >= DUPLICATE_LIMIT ||
    ordersStoredCount > storedOrders.length ||
    productJourneyCount > productJourney.length;

  return NextResponse.json({
    email,
    customerFound: true,
    mongoId: String(customer._id),
    dbLookupMs,
    selectedDocumentReason: ordersStoredCount > 0 ? "debug_exact_email_with_orders" : "debug_exact_email_latest",
    documentsWithSameEmail: candidates.length,
    hasOrdersArray: Boolean(customer.hasOrdersArray ?? Array.isArray(customer.orders)),
    paidTotal: customer.paidTotal ?? customer.totalPaid ?? 0,
    attemptedTotal: customer.attemptedTotal ?? 0,
    paidOrderCount: customer.paidOrderCount ?? 0,
    attemptedOrderCount: customer.attemptedOrderCount ?? 0,
    ordersStoredCount,
    paidProducts: customer.paidProducts ?? [],
    attemptedProducts: customer.attemptedProducts ?? [],
    firstSignupProduct: customer.firstSignupProduct ?? "",
    firstSignupDate: customer.firstSignupDate ?? "",
    firstSignupAmount: customer.firstSignupAmount ?? 0,
    baseProductsPurchased: customer.baseProductsPurchased ?? [],
    boostProductsPurchased: customer.boostProductsPurchased ?? [],
    storedOrders,
    stripeConfigured: Boolean(process.env.STRIPE_SECRET_KEY),
    stripeLastCheckedAt: customer.stripeLastCheckedAt ?? "",
    stripeMatchedOrders: customer.stripeMatchedOrders ?? 0,
    stripeUnmatchedOrders: customer.stripeUnmatchedOrders ?? 0,
    authorizeConfigured: Boolean(process.env.AUTHORIZE_NET_API_LOGIN_ID && process.env.AUTHORIZE_NET_TRANSACTION_KEY),
    authorizeLastCheckedAt: customer.authorizeLastCheckedAt ?? "",
    authorizeMatchedOrders: customer.authorizeMatchedOrders ?? 0,
    authorizeUnmatchedOrders: customer.authorizeUnmatchedOrders ?? 0,
    nmiConfigured: Boolean(process.env.NMI_SECURITY_KEY),
    nmiLastCheckedAt: customer.nmiLastCheckedAt ?? "",
    nmiMatchedOrders: customer.nmiMatchedOrders ?? 0,
    nmiUnmatchedOrders: customer.nmiUnmatchedOrders ?? 0,
    productJourneyCount,
    productJourney,
    gatewayVerification: gatewaySummary(customer.gatewayVerification),
    responseTruncated,
  });
}

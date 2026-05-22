"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AdminHeader } from "@/app/admin/_components/AdminHeader";
import { AdminLayout, AdminLoadingState } from "@/app/admin/_components/AdminLayout";

type OrderLineItem = {
  productId: number;
  variationId: number;
  name: string;
  sku: string;
  quantity: number;
  subtotal: number;
  total: number;
  price: number;
};

type GatewayVerification = {
  provider: string;
  matched: boolean;
  confidence: string;
  matchedBy: string;
  transactionId: string;
  transactionStatus: string;
  amount: number;
  transactionDate: string;
  customerVaultId?: string;
  paymentProfileId: string;
  customerProfileId?: string;
  paymentIntentId?: string;
  chargeId?: string;
  stripeCustomerId?: string;
  paymentMethodId?: string;
  last4?: string;
  cardType?: string;
  candidatesCount?: number;
  rawSummary: string;
  lastCheckedAt: string;
  configured: boolean;
  notes: string;
};

type ProductJourneyItem = {
  date: string;
  orderNumber: string;
  status: string;
  paymentMethod: string;
  productName: string;
  category: "base_product" | "boost" | "design_or_setup" | "other";
  productType: string;
  amount: number;
  type: "paid" | "attempted";
};

type OrderHistoryItem = {
  orderId: string;
  orderNumber: string;
  customerId?: number;
  status: string;
  dateCreated: string;
  dateModified: string;
  total: number;
  currency: string;
  paymentMethod: string;
  paymentMethodTitle: string;
  transactionId: string;
  paidDate: string;
  attemptedDate: string;
  isPaid: boolean;
  isAttempted: boolean;
  billingName: string;
  billingEmail: string;
  billingPhone: string;
  billingFirstName?: string;
  billingLastName?: string;
  billingCompany?: string;
  billingAddress?: { address1?: string; address2?: string; city?: string; state?: string; postcode?: string; country?: string };
  lineItems: OrderLineItem[];
  products?: OrderLineItem[];
  refundsCount: number;
  refundsAmount: number;
  customerNote: string;
  checkoutSource: string;
  source: string;
  matchedBy?: string[];
  matchConfidence?: string;
  gatewayVerification?: GatewayVerification;
};

type SourceCoverage = {
  deepWooSearch?: boolean;
  ordersStored?: number;
  ordersStoredCount?: number;
  matchReasonCounts?: Record<string, number>;
  statusCounts?: Record<string, number>;
  paymentMethodCounts?: Record<string, number>;
  aggregationKey?: string;
  aggregationKeyType?: string;
  lastBackfillImportAt?: string;
  lastCustomerRebuildAt?: string;
  wooCommerceCustomerOrdersStored?: number;
  wooCommerceOrderRecordsFound?: number;
  authorizeNetTransactionsFound?: number;
  nmiQuickPayTransactionsFound?: number;
  gatewayOnlyPaymentsAttached?: number;
  reconciledRecords?: number;
  missingUnattachedRecords?: number;
  revenueCoveragePercent?: number;
  warningSummary?: string;
  lastSyncedAt?: string;
  warnings?: string[];
  wooProfileMatched?: boolean;
  wooOrdersUsedForEnrichment?: number;
  businessFieldsSource?: Record<string, string>;
  creditMetaSource?: string;
  approvedCreditsFound?: number;
  availableCreditsFound?: number;
  einSource?: string;
  creditMetaVerified?: boolean;
  creditFallbackReason?: string;
};

type SourceCompare = {
  customerOrdersCount: number;
  wooCommerceOrderRecordsCount: number;
  mismatch: boolean;
  missingOrderNumbers: string[];
  recommendation: string;
};

type GatewayPayment = {
  date: string;
  provider: string;
  transactionId: string;
  invoiceNumber: string;
  status: string;
  amount: number;
  cardLast4: string;
  cardType?: string;
  matchedBy: string;
  matchConfidence: string;
  source: string;
  customerProfileId?: string;
  customerPaymentProfileId?: string;
};

type UnifiedPaymentLedgerRow = {
  date: string;
  source: "woocommerce" | "authorize_net" | "nmi_quick_pay";
  provider: string;
  transactionId: string;
  invoiceNumber: string;
  productDescription: string;
  status: string;
  amount: number;
  cardLast4: string;
  matchMethod: string;
  confidence: string;
  revenueType: "paid" | "attempted" | "refund" | "pending";
};

type UnifiedPaymentMetrics = {
  paidTotal: number;
  attemptedTotal: number;
  refundTotal: number;
  paidCount: number;
  attemptedCount: number;
  duplicateSkipped: number;
  lastActivity: string;
};

type BusinessProfile = {
  firstName?: string;
  lastName?: string;
  company?: string;
  dba?: string;
  email?: string;
  phone?: string;
  address1?: string;
  address2?: string;
  shippingAddress1?: string;
  shippingAddress2?: string;
  shippingCity?: string;
  shippingState?: string;
  shippingZip?: string;
  shippingCountry?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
  website?: string;
  sourcePlatform?: string;
  customerSince?: string;
  lastActivity?: string;
  ein?: string;
  approvedCredits?: number;
  availableCredit?: number;
  outstandingBalance?: number;
  creditStatus?: string;
  creditMetaVerified?: boolean;
  creditMetaSource?: string;
  creditFallbackReason?: string;
  potentialCreditLimit?: number;
  creditLimit?: number;
  creditLimitLastUpdated?: string;
  lastBillDate?: string;
  nextBillingDate?: string;
  net30Status?: string;
  accountStatus?: string;
  businessType?: string;
  source?: string;
  importedAt?: string;
};

type CustomerDetail = {
  _id: string;
  name: string;
  email: string;
  phone?: string;
  totalPaid: number;
  paidTotal?: number;
  attemptedTotal?: number;
  paidOrderCount?: number;
  attemptedOrderCount?: number;
  leadStatus?: string;
  paymentStatus?: string;
  lastPaidDate?: string;
  lastAttemptDate?: string;
  lastPaymentMethod?: string;
  lastAttemptPaymentMethod?: string;
  lastAttemptStatus?: string;
  leadUrgency?: string;
  recommendedContactMethod?: string;
  nextAction?: string;
  orders?: OrderHistoryItem[];
  lastProducts?: string[];
  attemptedProducts?: string[];
  paidProducts?: string[];
  firstSignupOrderNumber?: string;
  firstSignupDate?: string;
  firstPaidDate?: string;
  firstSignupAmount?: number;
  firstSignupProduct?: string;
  baseProductsPurchased?: string[];
  boostProductsPurchased?: string[];
  addOnProductsPurchased?: string[];
  attemptedBaseProducts?: string[];
  attemptedBoostProducts?: string[];
  attemptedAddOnProducts?: string[];
  lastPurchasedProduct?: string;
  lastAttemptedProduct?: string;
  productJourney?: ProductJourneyItem[];
  gatewayVerification?: GatewayVerification;
  gatewayPayments?: GatewayPayment[];
  unifiedPaymentLedger?: UnifiedPaymentLedgerRow[];
  unifiedPaymentMetrics?: UnifiedPaymentMetrics;
  sourceCoverage?: SourceCoverage;
  businessProfile?: BusinessProfile;
  orderCount: number;
  averageOrderValue: number;
  firstOrderDate: string;
  lastOrderDate: string;
  failedPayments: number;
  refunds: number;
  chargebacks: number;
  subscriptionStatus: string;
  activeSubscriptions?: number;
  isGatewayRecurring?: boolean;
  recurringSource?: string;
  recurringAmount?: number;
  recurringFrequencyEstimate?: string;
  recurringLastPayment?: string;
  recurringNextEstimatedPayment?: string;
  recurringPaymentCount?: number;
  score?: number;
  stars?: number;
  tier: string;
  riskLevel: string;
  estimatedCreditLimit: number;
  actualCreditLimit: number | null;
  lastSyncedAt: string;
  aiSummary: string;
  riskExplanation: string;
  recommendedAction: string;
  notes?: string;
  tags?: string[];
};

const money = (value: number) => `$${Number(value ?? 0).toFixed(2)}`;
const displayStatus = (value?: string) => value ? value.replaceAll("_", " ") : "-";
const displayDate = (value?: string) => {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleDateString();
};
const displayLongDate = (value?: string) => {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
};
const displayDateTime = (value?: string) => {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString();
};
const monthSpan = (start?: string, end = new Date()) => {
  const date = start ? new Date(start) : null;
  if (!date || Number.isNaN(date.getTime())) return 0;
  return Math.max(0, (end.getFullYear() - date.getFullYear()) * 12 + end.getMonth() - date.getMonth() + 1);
};
const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;
const productNames = (order?: OrderHistoryItem, fallback: string[] = []) => {
  const names = (order?.lineItems?.length ? order.lineItems : order?.products ?? []).map((item) => item.name).filter(Boolean);
  return names.length ? names.join(", ") : fallback.length ? fallback.join(", ") : "the selected product";
};
const paidStatuses = new Set(["completed", "processing", "paid"]);
const isGatewayPaidStatus = (status?: string) => {
  const normalized = String(status ?? "").toLowerCase();
  return normalized.includes("settled") || normalized === "paid";
};
const isGatewayDeclinedStatus = (status?: string) => /declin|fail|void|error/i.test(String(status ?? ""));
const isGatewayRefundStatus = (status?: string) => /refund|chargeback|charge back/i.test(String(status ?? ""));
const gatewayStatusBadgeClass = (status?: string) => {
  if (isGatewayPaidStatus(status)) return "border-emerald-500/50 bg-emerald-500/15 text-emerald-200";
  if (isGatewayDeclinedStatus(status)) return "border-red-500/50 bg-red-500/15 text-red-200";
  if (isGatewayRefundStatus(status)) return "border-amber-500/50 bg-amber-500/15 text-amber-100";
  return "border-sky-500/50 bg-sky-500/15 text-sky-200";
};

function isPaidOrder(order: OrderHistoryItem) {
  return order.isPaid || paidStatuses.has(order.status.toLowerCase());
}

function getOrderType(order: OrderHistoryItem) {
  const status = order.status.toLowerCase();
  const method = `${order.paymentMethod} ${order.paymentMethodTitle}`.toLowerCase();
  if (isPaidOrder(order)) return "Paid";
  if (status.includes("crypto") || method.includes("crypto")) return "Crypto Attempt";
  if (status === "failed") return "Failed";
  if (status === "on-hold") return "On Hold";
  if (["pending", "checkout-draft", "payment_pending"].includes(status)) return "Pending";
  return "Attempted";
}

function badgeClass(type: string) {
  if (type === "Paid") return "border-emerald-500/50 bg-emerald-500/15 text-emerald-200";
  if (type === "Failed") return "border-red-500/50 bg-red-500/15 text-red-200";
  if (type === "Crypto Attempt") return "border-purple-500/50 bg-purple-500/15 text-purple-200";
  if (type === "On Hold") return "border-amber-500/50 bg-amber-500/15 text-amber-200";
  if (type === "Pending") return "border-amber-500/50 bg-amber-500/15 text-amber-200";
  return "border-orange-500/50 bg-orange-500/15 text-orange-200";
}

function productCategoryLabel(category?: string) {
  if (category === "base_product") return "Base";
  if (category === "boost") return "Boost";
  if (category === "design_or_setup") return "Add-on";
  return "Other";
}

function productCategoryBadgeClass(category?: string) {
  if (category === "base_product") return "border-sky-500/50 bg-sky-500/15 text-sky-200";
  if (category === "boost") return "border-emerald-500/50 bg-emerald-500/15 text-emerald-200";
  if (category === "design_or_setup") return "border-fuchsia-500/50 bg-fuchsia-500/15 text-fuchsia-200";
  return "border-zinc-500/50 bg-zinc-500/15 text-zinc-200";
}

function verificationRank(verification?: GatewayVerification) {
  if (!verification) return -1;
  const confidenceRank: Record<string, number> = { exact: 5, high: 4, medium: 3, low: 2, not_found: 1 };
  return (verification.matched ? 10 : 0) + (confidenceRank[verification.confidence] ?? 0) + (verification.lastCheckedAt ? 1 : 0);
}

function chooseBestVerification(customer: CustomerDetail, orders: OrderHistoryItem[]) {
  return [
    customer.gatewayVerification,
    ...orders.map((order) => order.gatewayVerification),
  ]
    .filter((verification): verification is GatewayVerification => Boolean(verification))
    .sort((a, b) => verificationRank(b) - verificationRank(a) || new Date(b.lastCheckedAt || 0).getTime() - new Date(a.lastCheckedAt || 0).getTime())[0];
}

function listOrDash(values: string[]) {
  return values.length ? values.join(", ") : "-";
}

function buildTemplates(customer: CustomerDetail, actualPaid: number, attempted: number, attemptedOrders: OrderHistoryItem[]) {
  const latestAttempt = attemptedOrders[0];
  const fallbackProducts = actualPaid > 0
    ? (customer.paidProducts?.length ? customer.paidProducts : customer.lastProducts ?? [])
    : (customer.attemptedProducts?.length ? customer.attemptedProducts : customer.lastProducts ?? []);
  const products = productNames(latestAttempt, fallbackProducts);
  const shortProduct = products.split(",")[0] || products;
  const attemptDate = displayLongDate(latestAttempt?.attemptedDate || latestAttempt?.dateCreated || customer.lastAttemptDate);
  const attemptAmount = money(attempted);
  const method = latestAttempt?.paymentMethodTitle || latestAttempt?.paymentMethod || customer.lastAttemptPaymentMethod || "payment";
  const status = displayStatus(latestAttempt?.status || customer.lastAttemptStatus);
  const orderNumbers = attemptedOrders.map((order) => `#${order.orderNumber}`).filter(Boolean).join(", ");
  const name = firstName(customer.name);

  if (actualPaid > 0) {
    return {
      email: `Subject: Thanks for your Red Spectrum order\n\nHi ${name},\n\nThank you for your recent order for ${products}. Based on your purchase history, I can help with renewal, support, or matching products that fit your current setup.\n\nBest,\nRed Spectrum Team`,
      sms: `Hi ${name}, this is Red Spectrum. Thanks for your order for ${products}. Want help with setup, renewal, or a matching product recommendation?`,
      call: `Hi ${name}, this is [Rep Name] from Red Spectrum. I am calling to follow up on your purchase of ${products} and see if you need setup help or recommendations for the next best product.`,
      note: `Paid customer. Purchased ${products}. Actual paid total ${money(actualPaid)}. Review upsell, renewal, or support opportunity.`,
    };
  }

  return {
    email: `Subject: Need help completing your Red Spectrum order?\n\nHi ${name},\n\nI noticed you started checkout for ${products} on ${attemptDate}, but the ${method} payment is still ${status} and did not complete.\n\nI can help you finish the order or resend a secure payment link.\n\nWould you like me to help complete the payment?\n\nBest,\nRed Spectrum Team`,
    sms: `Hi ${name}, this is Red Spectrum. Your checkout for ${shortProduct} is still ${status} through ${method}. Want me to resend a secure payment link or help finish it?`,
    call: `Hi ${name}, this is [Rep Name] from Red Spectrum. I am calling because I saw you started checkout for ${shortProduct}, but the ${method} payment is still ${status}. I wanted to see if you need help completing the payment or prefer another payment option.`,
    note: `Very hot lead. ${attemptedOrders.length} ${status} WooCommerce order${attemptedOrders.length === 1 ? "" : "s"} via ${method} on ${attemptDate}. Orders: ${orderNumbers || "N/A"}. Attempted products: ${products}. Attempted total: ${attemptAmount}. Payment not completed. Follow up by phone/SMS and offer secure payment link or alternate payment method. Do not mark as paid until verified.`,
  };
}

function BackToCustomersLink() {
  return <Link href="/admin?tab=customers" className="w-fit rounded border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm font-semibold text-zinc-100 transition hover:border-red-500/60 hover:bg-zinc-800">
    Back to Customer List
  </Link>;
}

function DetailShell({ children, title = "Customer Details", description, actions }: { children: ReactNode; title?: string; description?: string; actions?: ReactNode }) {
  return <AdminLayout maxWidthClass="max-w-6xl" header={<AdminHeader
    eyebrow="Red Spectrum Customer Intelligence"
    title={title}
    description={description}
    actions={actions ?? <BackToCustomersLink />}
  />}>
    {children}
  </AdminLayout>;
}

function CustomerLoadingState() {
  return <DetailShell>
    <AdminLoadingState title="Loading customer details..." subtext="Fetching customer profile, payment history, and order timeline..." />
  </DetailShell>;
}

function CustomerErrorState({ onRetry }: { onRetry: () => void }) {
  return <DetailShell>
    <section className="rounded-xl border border-red-500/30 bg-red-950/20 p-6">
      <h2 className="text-xl font-semibold text-red-200">Unable to load customer details</h2>
      <p className="mt-2 text-zinc-300">Please go back and try again, or refresh this page.</p>
      <div className="mt-5 flex flex-wrap gap-3">
        <button onClick={onRetry} className="rounded bg-red-700 px-4 py-2 text-sm font-semibold text-white hover:bg-red-600">Retry</button>
        <Link href="/admin?tab=customers" className="rounded border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm font-semibold text-zinc-100 hover:bg-zinc-800">Back to Customer List</Link>
      </div>
    </section>
  </DetailShell>;
}

export default function CustomerDetailPage() {
  const params = useParams<{ id: string }>();
  const [customer, setCustomer] = useState<CustomerDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [notes, setNotes] = useState("");
  const [tags, setTags] = useState("");
  const [message, setMessage] = useState("");
  const [loadError, setLoadError] = useState("");
  const [subscriptions, setSubscriptions] = useState<Array<Record<string, string | number>>>([]);
  const [sourceCompare, setSourceCompare] = useState<SourceCompare | null>(null);
  const activeController = useRef<AbortController | null>(null);
  const requestSequence = useRef(0);

  const loadCustomer = useCallback(async () => {
    activeController.current?.abort();
    const controller = new AbortController();
    activeController.current = controller;
    const requestId = requestSequence.current + 1;
    requestSequence.current = requestId;
    let timedOut = false;
    const timeout = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 15000);

    setIsLoading(true);
    setLoadError("");
    setCustomer(null);
    setSourceCompare(null);
    setSubscriptions([]);

    try {
      const safeId = encodeURIComponent(decodeURIComponent(params.id));
      const response = await fetch(`/api/customers/${safeId}`, { signal: controller.signal, cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Customer not found.");
      if (requestSequence.current !== requestId) return;
      const nextCustomer = data.customer;
      setCustomer(nextCustomer);
      setNotes(nextCustomer?.notes ?? "");
      setTags((nextCustomer?.tags ?? []).join(", "));
      setIsLoading(false);

      const email = String(nextCustomer?.email ?? "").toLowerCase();
      if (email && !email.endsWith("@woocommerce.local")) {
        fetch(`/api/customers/compare-source?email=${encodeURIComponent(email)}`, { signal: controller.signal, cache: "no-store" }).then((r3) => r3.json()).then((compare) => {
          if (requestSequence.current === requestId && !compare.error) setSourceCompare(compare);
        }).catch(() => {
          if (requestSequence.current === requestId) setSourceCompare(null);
        });
        fetch(`/api/subscriptions?kind=all-real-data&limit=25&q=${encodeURIComponent(email)}`, { signal: controller.signal, cache: "no-store" }).then((r2) => r2.json()).then((subs) => {
          if (requestSequence.current === requestId) setSubscriptions((subs.rows ?? []).filter((row: Record<string, string | number>) => String(row.customerEmail ?? "").toLowerCase() === email));
        }).catch(() => {
          if (requestSequence.current === requestId) setSubscriptions([]);
        });
      }
    } catch (error) {
      if (requestSequence.current !== requestId || (controller.signal.aborted && !timedOut)) return;
      setLoadError(timedOut ? "timeout" : error instanceof Error ? error.message : "Unable to load customer details.");
      setIsLoading(false);
    } finally {
      window.clearTimeout(timeout);
    }
  }, [params.id]);

  useEffect(() => {
    const loadTimer = window.setTimeout(() => {
      void loadCustomer();
    }, 0);
    return () => {
      window.clearTimeout(loadTimer);
      activeController.current?.abort();
    };
  }, [loadCustomer]);

  const save = async () => {
    const response = await fetch(`/api/customers/${params.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ notes, tags: tags.split(",").map((t) => t.trim()).filter(Boolean) }) });
    const data = await response.json();
    setMessage(data.message || "Saved");
    setCustomer(data.customer);
  };

  const copy = async (text: string, label: string) => {
    await navigator.clipboard.writeText(text);
    setMessage(`${label} copied.`);
  };

  const backToCustomerList = () => {
    if (window.history.length > 1) {
      window.history.back();
      return;
    }
    window.location.href = "/admin?tab=customers";
  };

  const downloadPdf = () => {
    const safeId = encodeURIComponent(params.id);
    window.open(`/api/customers/${safeId}/pdf`, "_blank", "noopener,noreferrer");
  };

  const repairGatewayPayments = async () => {
    setMessage("Repairing gateway payments...");
    try {
      const response = await fetch("/api/authorize-net/repair-customer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: customer?.email, customerId: customer?._id }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Gateway repair failed.");
      setMessage(data.message || "Gateway repair complete.");
      await loadCustomer();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Gateway repair failed.");
    }
  };

  const rebuildCustomerRevenue = async () => {
    setMessage("Rebuilding customer revenue from gateway transactions...");
    try {
      const response = await fetch("/api/admin/rebuild-customer-revenue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customerId: customer?._id, dryRun: false }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Rebuild failed.");
      if (data.stats?.length) {
        const stat = data.stats[0];
        setMessage(`Revenue rebuilt: Found ${stat.totalGatewayPaymentsFound} gateway transactions. Updated from ${money(stat.beforeRankingTotal)} to ${money(stat.rankingTotal)}.`);
      } else {
        setMessage("Rebuild complete - no changes needed.");
      }
      await loadCustomer();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Rebuild failed.");
    }
  };

  const attemptedProductRows = useMemo(() => {
    const rows = new Map<string, { name: string; quantity: number; amount: number; lastAttemptDate: string; status: string; paymentMethod: string }>();
    for (const order of customer?.orders?.filter((item) => item.isAttempted) ?? []) {
      const items = order.lineItems?.length ? order.lineItems : order.products?.length ? order.products : [{ name: "Unknown product", quantity: 1, total: order.total } as OrderLineItem];
      for (const item of items) {
        const existing = rows.get(item.name);
        const currentDate = order.attemptedDate || order.dateCreated;
        rows.set(item.name, {
          name: item.name,
          quantity: (existing?.quantity ?? 0) + Number(item.quantity ?? 0),
          amount: (existing?.amount ?? 0) + Number(item.total ?? 0),
          lastAttemptDate: !existing || new Date(currentDate).getTime() > new Date(existing.lastAttemptDate).getTime() ? currentDate : existing.lastAttemptDate,
          status: order.status,
          paymentMethod: order.paymentMethodTitle || order.paymentMethod || existing?.paymentMethod || "-",
        });
      }
    }
    return Array.from(rows.values()).sort((a, b) => new Date(b.lastAttemptDate).getTime() - new Date(a.lastAttemptDate).getTime());
  }, [customer]);

  const paidProductRows = useMemo(() => {
    const rows = new Map<string, { name: string; quantity: number; amount: number; lastPaidDate: string; status: string; paymentMethod: string }>();
    for (const order of customer?.orders?.filter(isPaidOrder) ?? []) {
      const items = order.lineItems?.length ? order.lineItems : order.products?.length ? order.products : [{ name: "Unknown product", quantity: 1, total: order.total } as OrderLineItem];
      for (const item of items) {
        const existing = rows.get(item.name);
        const currentDate = order.paidDate || order.dateCreated;
        const itemTotal = Number(item.total ?? 0) || Number(item.price ?? 0) * Number(item.quantity ?? 0);
        rows.set(item.name, {
          name: item.name,
          quantity: (existing?.quantity ?? 0) + Number(item.quantity ?? 0),
          amount: (existing?.amount ?? 0) + itemTotal,
          lastPaidDate: !existing || new Date(currentDate).getTime() > new Date(existing.lastPaidDate).getTime() ? currentDate : existing.lastPaidDate,
          status: order.status,
          paymentMethod: order.paymentMethodTitle || order.paymentMethod || existing?.paymentMethod || "-",
        });
      }
    }

    if (rows.size === 0 && Number(customer?.paidTotal ?? customer?.totalPaid ?? 0) > 0) {
      for (const name of customer?.paidProducts ?? []) {
        rows.set(name, {
          name,
          quantity: 0,
          amount: 0,
          lastPaidDate: customer?.lastPaidDate || customer?.lastOrderDate || "",
          status: "timeline not synced",
          paymentMethod: customer?.lastPaymentMethod || "-",
        });
      }
    }

    return Array.from(rows.values()).sort((a, b) => new Date(b.lastPaidDate).getTime() - new Date(a.lastPaidDate).getTime());
  }, [customer]);

  if (isLoading) return <CustomerLoadingState />;
  if (loadError || !customer) return <CustomerErrorState onRetry={loadCustomer} />;

  const orders = [...(customer.orders ?? [])].sort((a, b) => new Date(b.dateCreated).getTime() - new Date(a.dateCreated).getTime());
  const gatewayOnlyOrders = orders.filter((order) => order.source === "authorize_net_only" || order.source === "nmi_quick_pay_only");
  const wooCustomerOrdersStored = orders.length - gatewayOnlyOrders.length;
  const attemptedOrders = orders.filter((order) => order.isAttempted);
  const paidOrdersFromTimeline = orders.filter(isPaidOrder);
  const actualPaid = Number(customer.paidTotal ?? customer.totalPaid ?? 0);
  const attempted = Number(customer.attemptedTotal ?? 0);
  const displayedPaidOrderCount = orders.length > 0 ? paidOrdersFromTimeline.length : customer.paidOrderCount ?? 0;
  const timelineMissingForPaid = actualPaid > 0 && orders.length === 0 && Number(customer.orderCount ?? 0) > 0;
  const templates = buildTemplates(customer, actualPaid, attempted, attemptedOrders);
  const isLead = actualPaid === 0 && attempted > 0;
  const verification = chooseBestVerification(customer, orders);
  const productJourney = [...(customer.productJourney ?? [])].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  const baseProductsPurchased = customer.baseProductsPurchased ?? [];
  const boostProductsPurchased = customer.boostProductsPurchased ?? [];
  const addOnProductsPurchased = customer.addOnProductsPurchased ?? [];
  const attemptedBaseProducts = customer.attemptedBaseProducts ?? [];
  const attemptedBoostProducts = customer.attemptedBoostProducts ?? [];
  const attemptedAddOnProducts = customer.attemptedAddOnProducts ?? [];
  const boostAndAddOns = [...boostProductsPurchased, ...addOnProductsPurchased];
  const classifiedAttemptedProducts = [...attemptedBaseProducts, ...attemptedBoostProducts, ...attemptedAddOnProducts];
  const attemptedProductSummary = classifiedAttemptedProducts.length ? classifiedAttemptedProducts : customer.attemptedProducts ?? [];
  const requiresProductReview = isLead && attemptedBoostProducts.length > 0 && baseProductsPurchased.length === 0;
  const profile = customer.businessProfile ?? {};
  const latestOrderWithBilling = orders.find((order) => order.billingCompany || order.billingPhone || order.billingAddress?.address1 || order.billingEmail) ?? orders[0];
  const businessInfo = {
    businessName: profile.company || latestOrderWithBilling?.billingCompany || customer.name || "-",
    dba: profile.dba || "-",
    ein: profile.ein || "-",
    phone: profile.phone || latestOrderWithBilling?.billingPhone || customer.phone || "-",
    email: profile.email || customer.email || latestOrderWithBilling?.billingEmail || "-",
    billingAddress: [profile.address1 || latestOrderWithBilling?.billingAddress?.address1, profile.address2 || latestOrderWithBilling?.billingAddress?.address2].filter(Boolean).join(", ") || "-",
    shippingAddress: [profile.shippingAddress1, profile.shippingAddress2].filter(Boolean).join(", ") || "-",
    city: profile.city || latestOrderWithBilling?.billingAddress?.city || "-",
    state: profile.state || latestOrderWithBilling?.billingAddress?.state || "-",
    zip: profile.zip || latestOrderWithBilling?.billingAddress?.postcode || "-",
    country: profile.country || latestOrderWithBilling?.billingAddress?.country || "-",
    website: profile.website || "-",
    sourcePlatform: profile.sourcePlatform || profile.source || latestOrderWithBilling?.source || "customer_record",
    customerSince: profile.customerSince || customer.firstPaidDate || customer.firstSignupDate || customer.firstOrderDate || "",
    lastActivity: profile.lastActivity || customer.lastPaidDate || customer.lastOrderDate || customer.lastSyncedAt || "",
  };
  const creditMetaVerified = Boolean(profile.creditMetaVerified || customer.sourceCoverage?.creditMetaVerified);
  const approvedCredits = creditMetaVerified ? Number(profile.approvedCredits ?? profile.creditLimit ?? 0) : 0;
  const totalCreditLimit = creditMetaVerified ? Math.max(
    approvedCredits,
    Number(profile.potentialCreditLimit ?? 0)
  ) : 0;
  const availableCredit = creditMetaVerified ? Number(profile.availableCredit ?? 0) : 0;
  const outstandingBalance = creditMetaVerified ? Number(profile.outstandingBalance ?? 0) : 0;
  const hasProfileData = Boolean(
    profile.source ||
    profile.company ||
    profile.ein ||
    approvedCredits ||
    totalCreditLimit ||
    availableCredit ||
    outstandingBalance ||
    profile.address1
  );
  const missingUnattachedRecords = Math.max(
    Number(customer.sourceCoverage?.missingUnattachedRecords ?? 0),
    sourceCompare ? Math.max(0, sourceCompare.wooCommerceOrderRecordsCount - sourceCompare.customerOrdersCount) : 0
  );
  const gatewayHistoryRows = (() => {
    const byTransaction = new Map<string, GatewayPayment>();
    for (const payment of customer.gatewayPayments ?? []) {
      byTransaction.set(payment.transactionId || `${payment.provider}-${payment.invoiceNumber}-${payment.amount}-${payment.date}`, payment);
    }
    for (const order of gatewayOnlyOrders) {
      if (!order.transactionId || byTransaction.has(order.transactionId)) continue;
      const isNmi = order.source === "nmi_quick_pay_only" || order.gatewayVerification?.provider === "nmi";
      byTransaction.set(order.transactionId, {
        date: order.paidDate || order.dateCreated,
        provider: isNmi ? "nmi" : "authorize_net",
        transactionId: order.transactionId,
        invoiceNumber: order.orderNumber,
        status: order.gatewayVerification?.transactionStatus || order.status,
        amount: order.total,
        cardLast4: order.gatewayVerification?.last4 || "",
        cardType: order.gatewayVerification?.cardType || "",
        matchedBy: order.gatewayVerification?.matchedBy || order.matchedBy?.join(", ") || "",
        matchConfidence: order.gatewayVerification?.confidence || order.matchConfidence || "",
        source: isNmi ? "nmi_quick_pay_only" : "authorize_net_only",
        customerProfileId: order.gatewayVerification?.customerProfileId || "",
        customerPaymentProfileId: order.gatewayVerification?.paymentProfileId || "",
      });
    }
    return Array.from(byTransaction.values()).sort((a, b) => new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime());
  })();
  const latestGatewayPayment = gatewayHistoryRows[0];
  const gatewayPaidTotal = gatewayHistoryRows.reduce((sum, payment) => isGatewayPaidStatus(payment.status) ? sum + Number(payment.amount ?? 0) : isGatewayRefundStatus(payment.status) ? sum - Math.abs(Number(payment.amount ?? 0)) : sum, 0);
  const gatewayDeclinedTotal = gatewayHistoryRows.reduce((sum, payment) => isGatewayDeclinedStatus(payment.status) ? sum + Math.abs(Number(payment.amount ?? 0)) : sum, 0);
  const gatewayDecisionCount = gatewayHistoryRows.filter((payment) => isGatewayPaidStatus(payment.status) || isGatewayDeclinedStatus(payment.status)).length;
  const gatewayApprovalRate = gatewayDecisionCount > 0 ? (gatewayHistoryRows.filter((payment) => isGatewayPaidStatus(payment.status)).length / gatewayDecisionCount) * 100 : 0;
  const unifiedPaymentRows = (customer.unifiedPaymentLedger ?? []).length
    ? customer.unifiedPaymentLedger ?? []
    : gatewayHistoryRows.map((payment) => ({
      date: payment.date,
      source: payment.provider === "nmi" || payment.provider === "nmi_quick_pay" ? "nmi_quick_pay" as const : "authorize_net" as const,
      provider: payment.provider,
      transactionId: payment.transactionId,
      invoiceNumber: payment.invoiceNumber,
      productDescription: payment.provider === "nmi" ? "NMI Quick Pay" : "Authorize.net Payment",
      status: payment.status,
      amount: payment.amount,
      cardLast4: payment.cardLast4,
      matchMethod: payment.matchedBy,
      confidence: payment.matchConfidence,
      revenueType: isGatewayPaidStatus(payment.status) ? "paid" as const : isGatewayDeclinedStatus(payment.status) ? "attempted" as const : isGatewayRefundStatus(payment.status) ? "refund" as const : "pending" as const,
    }));
  const activeSubscriptionRows = subscriptions.filter((sub) => String(sub.status ?? "").toLowerCase() === "active");
  const activeSubscriptionCount = activeSubscriptionRows.length + (customer.isGatewayRecurring ? 1 : 0);
  const wooRecurringRevenue = activeSubscriptionRows.reduce((sum, sub) => sum + Number(sub.monthlyRecurringRevenue ?? sub.amount ?? 0), 0);
  const recurringRevenue = wooRecurringRevenue + (customer.isGatewayRecurring ? Number(customer.recurringAmount ?? 0) : 0);
  const nextRenewal = activeSubscriptionRows.map((sub) => String(sub.nextBillingDate ?? "")).filter(Boolean).sort()[0] || customer.recurringNextEstimatedPayment || "";
  const lastRenewal = activeSubscriptionRows.map((sub) => String(sub.lastBillingDate ?? "")).filter(Boolean).sort().reverse()[0] || customer.recurringLastPayment || customer.lastPaidDate || "";
  const subscriptionStart = activeSubscriptionRows.map((sub) => String(sub.startDate ?? "")).filter(Boolean).sort()[0] || customer.firstSignupDate || customer.firstOrderDate || "";
  const subscriptionAgeMonths = monthSpan(subscriptionStart);
  const estimatedYearlyValue = recurringRevenue * 12;
  const renewalRisk = customer.riskLevel === "high" || customer.failedPayments > 1 ? "high" : customer.riskLevel === "medium" || customer.failedPayments > 0 ? "medium" : "low";
  const sourceCoverageRows = [
    ["WooCommerce customer orders stored", customer.sourceCoverage?.wooCommerceCustomerOrdersStored ?? wooCustomerOrdersStored],
    ["WooCommerceOrder records found", customer.sourceCoverage?.wooCommerceOrderRecordsFound ?? sourceCompare?.wooCommerceOrderRecordsCount ?? "-"],
    ["Woo profile matched", customer.sourceCoverage?.wooProfileMatched ? "yes" : "no"],
    ["Woo orders used for enrichment", customer.sourceCoverage?.wooOrdersUsedForEnrichment ?? 0],
    ["Authorize.net transactions found", customer.sourceCoverage?.authorizeNetTransactionsFound ?? gatewayHistoryRows.filter((payment) => payment.provider === "authorize_net").length],
    ["NMI Quick Pay transactions found", customer.sourceCoverage?.nmiQuickPayTransactionsFound ?? gatewayHistoryRows.filter((payment) => payment.provider === "nmi" || payment.provider === "nmi_quick_pay").length],
    ["Gateway-only payments attached", customer.sourceCoverage?.gatewayOnlyPaymentsAttached ?? gatewayOnlyOrders.length],
    ["Reconciled records", customer.sourceCoverage?.reconciledRecords ?? gatewayHistoryRows.length],
    ["Missing/unattached records", missingUnattachedRecords],
    ["Business fields source", Object.entries(customer.sourceCoverage?.businessFieldsSource ?? {}).map(([field, source]) => `${field}: ${source}`).join(", ") || "-"],
    ["Credit meta source", customer.sourceCoverage?.creditMetaSource || "-"],
    ["Credit meta verified", creditMetaVerified ? "true" : "false"],
    ["Credit fallback reason", customer.sourceCoverage?.creditFallbackReason || profile.creditFallbackReason || "-"],
    ["Approved credits found", customer.sourceCoverage?.approvedCreditsFound ? money(Number(customer.sourceCoverage.approvedCreditsFound)) : "-"],
    ["Available credits found", customer.sourceCoverage?.availableCreditsFound ? money(Number(customer.sourceCoverage.availableCreditsFound)) : "-"],
    ["EIN source", customer.sourceCoverage?.einSource || "-"],
    ["Revenue coverage", `${Number(customer.sourceCoverage?.revenueCoveragePercent ?? (actualPaid > 0 ? 100 : 0)).toFixed(0)}%`],
  ];
  const plan = isLead
    ? {
        priority: customer.leadUrgency === "very_high" ? "Very High" : "High",
        bestAction: requiresProductReview ? "Manual review: attempted boost without paid base product" : customer.nextAction || "Call and resend payment link",
        goal: "Help complete payment",
        detail: `Mention attempted products: ${listOrDash(attemptedProductSummary)}. Offer payment support and send a secure payment link or invoice. Do not call this lead a paid customer until payment completes.`,
      }
    : actualPaid > 0 && baseProductsPurchased.length > 0 && boostProductsPurchased.length > 0
      ? {
          priority: "Normal",
          bestAction: customer.nextAction || "Review retention and cross-sell missing boosts or add-ons",
          goal: "Retain customer and identify relevant cross-sell",
          detail: `Base product: ${listOrDash(baseProductsPurchased)}. Purchased boosts/add-ons: ${listOrDash(boostAndAddOns)}. Review missing boosts, add-ons, or support needs.`,
        }
      : actualPaid > 0 && baseProductsPurchased.length > 0
        ? {
            priority: "Normal",
            bestAction: customer.nextAction || "Suggest a boost upsell for the base product",
            goal: "Grow paid customer value",
            detail: `Base product: ${listOrDash(baseProductsPurchased)}. No purchased boost is recorded yet; suggest a relevant boost or setup add-on.`,
          }
    : {
        priority: "Normal",
        bestAction: customer.nextAction || "Review upsell or renewal opportunity",
        goal: "Retain and grow paid customer value",
        detail: "Suggest upsell or cross-sell based on purchased products and use renewal/retention flow if an active subscription exists.",
      };

  return <DetailShell
    title={customer.name}
    description={`${customer.email} - ${customer.phone || "N/A"}`}
    actions={<>
      <button onClick={backToCustomerList} className="w-fit rounded border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm font-semibold text-zinc-100 transition hover:border-red-500/60 hover:bg-zinc-800">Back to Customer List</button>
      <button onClick={downloadPdf} className="w-fit rounded border border-orange-500/50 bg-orange-600/20 px-4 py-2 text-sm font-semibold text-orange-100 transition hover:bg-orange-600/30">Download Customer PDF</button>
      <button onClick={rebuildCustomerRevenue} className="w-fit rounded bg-blue-700 px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-600">Rebuild Revenue</button>
      <button onClick={repairGatewayPayments} className="w-fit rounded bg-red-700 px-4 py-2 text-sm font-semibold text-white transition hover:bg-red-600">Repair Gateway Payments</button>
    </>}
  >

      <section className="grid gap-3 md:grid-cols-4">
        {[
          ["Actual Paid", money(actualPaid)],
          ["Attempted Amount", money(attempted)],
          ["Paid Orders", displayedPaidOrderCount],
          ["Attempted Orders", customer.attemptedOrderCount ?? 0],
          ["Lead Status", displayStatus(customer.leadStatus)],
          ["Payment Status", displayStatus(customer.paymentStatus)],
          ["Last Paid", displayDate(customer.lastPaidDate)],
          ["Last Attempt", displayDate(customer.lastAttemptDate)],
          ["Order Count", customer.orderCount],
          ["Average Order Value", money(Number(customer.averageOrderValue ?? 0))],
          ["Risk", customer.riskLevel],
          ["Tier", actualPaid > 0 ? customer.tier : "Lead"],
          ["Credit Limit", creditMetaVerified ? money(approvedCredits) : "WP credit meta not verified"],
          ["Available Credit", creditMetaVerified ? money(availableCredit) : "WP credit meta not verified"],
          ["Total Credit Limit", creditMetaVerified ? money(totalCreditLimit) : "WP credit meta not verified"],
        ].map(([k, v]) => <div key={String(k)} className="rounded-xl border border-zinc-800 bg-zinc-900 p-4"><p className="text-xs font-semibold uppercase text-zinc-400">{k}</p><p className="mt-2 text-xl font-bold">{String(v)}</p></div>)}
      </section>

      {timelineMissingForPaid && <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-amber-100">
        <p className="font-semibold">Timeline not synced yet - run single customer sync</p>
        <p className="mt-1 text-sm text-amber-100/80">This customer has paid value and historical order count, but no saved WooCommerce order timeline on the selected record.</p>
      </div>}

      <section className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
        <h2 className="text-xl font-semibold text-blue-300">Customer Profile Summary</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
          {[
            ["Customer Name", customer.name],
            ["Email", customer.email],
            ["Category", actualPaid >= 2000 ? "VIP Paid" : actualPaid > 0 ? "Paying" : attempted >= 2000 ? "Very Hot Lead" : attempted > 0 ? "Hot Lead" : "Cold Lead"],
            ["Tier", actualPaid > 0 ? customer.tier : "Lead"],
            ["Actual Paid", money(actualPaid)],
            ["Paid Orders", displayedPaidOrderCount],
            ["Attempted Orders", customer.attemptedOrderCount ?? 0],
            ["Start Date", displayDate(customer.firstSignupDate || customer.firstOrderDate)],
            ["Tenure", (() => {
              const startDate = customer.firstSignupDate || customer.firstOrderDate;
              const date = startDate ? new Date(startDate) : null;
              if (!date || Number.isNaN(date.getTime())) return "-";
              const now = new Date();
              const months = Math.max(0, (now.getFullYear() - date.getFullYear()) * 12 + now.getMonth() - date.getMonth() + 1);
              return `${months} mo`;
            })()],
            ["Payment Status", displayStatus(customer.paymentStatus)],
            ["Lead Status", displayStatus(customer.leadStatus)],
            ["Last Paid", displayDate(customer.lastPaidDate)],
            ["Last Attempt", displayDate(customer.lastAttemptDate)],
            ["Risk", customer.riskLevel],
            ["Score", `${customer.score ?? 0}/${customer.stars ?? 0}`],
            ["Credit Limit", creditMetaVerified ? money(approvedCredits) : "WP credit meta not verified"],
            ["Available Credit", creditMetaVerified ? money(availableCredit) : "WP credit meta not verified"],
            ["Total Credit Limit", creditMetaVerified ? money(totalCreditLimit) : "WP credit meta not verified"],
            ["AI Summary", customer.aiSummary?.substring(0, 100) || "-"],
          ].map(([label, value]) => <div key={label} className="rounded border border-zinc-700 bg-zinc-950 p-3">
            <p className="text-xs font-semibold uppercase text-zinc-400">{label}</p>
            <p className="mt-2 text-sm font-semibold text-zinc-100 line-clamp-2">{String(value)}</p>
          </div>)}
        </div>
      </section>

      <section className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
        <h2 className="text-xl font-semibold text-red-300">Subscription Intelligence</h2>
        <div className="mt-3 grid gap-3 md:grid-cols-4">
          {[
            ["Active subscriptions", activeSubscriptionCount],
            ["Recurring revenue", money(recurringRevenue)],
            ["Payment frequency", customer.recurringFrequencyEstimate || activeSubscriptionRows[0]?.billingInterval || "-"],
            ["Renewal risk", renewalRisk],
            ["Subscription age", `${subscriptionAgeMonths} months`],
            ["Next payment", displayDate(nextRenewal)],
            ["Last payment", displayDate(lastRenewal)],
            ["Estimated yearly value", money(estimatedYearlyValue)],
          ].map(([label, value]) => <div key={label} className="rounded border border-zinc-700 bg-zinc-950 p-3">
            <p className="text-xs font-semibold uppercase text-zinc-400">{label}</p>
            <p className="mt-2 text-sm font-semibold text-zinc-100">{String(value)}</p>
          </div>)}
        </div>
      </section>

      <section className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
        <h2 className="text-xl font-semibold text-orange-300">Business Information</h2>
        <div className="mt-3 grid gap-3 md:grid-cols-4">
          {[
            ["Business Name", businessInfo.businessName],
            ["DBA", businessInfo.dba],
            ["EIN", businessInfo.ein],
            ["Phone", businessInfo.phone],
            ["Email", businessInfo.email],
            ["Billing Address", businessInfo.billingAddress],
            ["Shipping Address", businessInfo.shippingAddress],
            ["City", businessInfo.city],
            ["State", businessInfo.state],
            ["ZIP", businessInfo.zip],
            ["Country", businessInfo.country],
            ["Website", businessInfo.website],
            ["Source Platform", displayStatus(businessInfo.sourcePlatform)],
            ["Customer Since", displayDate(businessInfo.customerSince)],
            ["Last Activity", displayDateTime(businessInfo.lastActivity)],
          ].map(([label, value]) => <div key={label} className="rounded border border-zinc-700 bg-zinc-950 p-3">
            <p className="text-xs font-semibold uppercase text-zinc-400">{label}</p>
            <p className="mt-2 text-sm font-semibold text-zinc-100">{String(value || "-")}</p>
          </div>)}
        </div>
      </section>

      <section className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
        <h2 className="text-xl font-semibold text-orange-300">Customer Profile</h2>
        {hasProfileData ? <div className="mt-3 grid gap-3 md:grid-cols-4">
          {[
            ["Name", `${profile.firstName || ""} ${profile.lastName || ""}`.trim() || customer.name],
            ["Email", customer.email],
            ["Phone", profile.phone || customer.phone || "-"],
            ["Company", profile.company || "-"],
            ["EIN", profile.ein || "-"],
            ["Address", [profile.address1, profile.address2].filter(Boolean).join(", ") || "-"],
            ["City/State/ZIP", [profile.city, profile.state, profile.zip].filter(Boolean).join(", ") || "-"],
            ["Country", profile.country || "-"],
            ["Credit Limit / Approved Credits", approvedCredits ? money(approvedCredits) : "-"],
            ["Available Credit", availableCredit ? money(availableCredit) : "-"],
            ["Outstanding Balance", outstandingBalance ? money(outstandingBalance) : "-"],
            ["Total Credit Limit", totalCreditLimit ? money(totalCreditLimit) : "-"],
            ["Credit Status", displayStatus(profile.creditStatus || profile.net30Status || profile.accountStatus)],
            ["Last credit update", displayDate(profile.creditLimitLastUpdated)],
            ["Last bill date", displayDate(profile.lastBillDate)],
            ["Next billing date", displayDate(profile.nextBillingDate)],
            ["Net 30 status", displayStatus(profile.net30Status || profile.accountStatus)],
          ].map(([label, value]) => <div key={label} className="rounded border border-zinc-700 bg-zinc-950 p-3">
            <p className="text-xs font-semibold uppercase text-zinc-400">{label}</p>
            <p className="mt-2 text-sm font-semibold text-zinc-100">{String(value)}</p>
          </div>)}
        </div> : <p className="mt-3 rounded border border-zinc-700 bg-zinc-950 p-3 text-zinc-400">No WordPress profile data imported yet.</p>}
      </section>

      <section className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
        <h2 className="text-xl font-semibold text-emerald-300">Data Source Coverage</h2>
        <div className="mt-3 grid gap-3 md:grid-cols-4">
          <div><p className="text-xs uppercase text-zinc-400">Orders Stored</p><p className="font-semibold">{customer.sourceCoverage?.ordersStoredCount ?? orders.length}</p></div>
          <div><p className="text-xs uppercase text-zinc-400">Aggregation Key</p><p className="font-semibold">{customer.sourceCoverage?.aggregationKeyType || Object.keys(customer.sourceCoverage?.matchReasonCounts ?? {})[0] || "-"}</p></div>
          <div><p className="text-xs uppercase text-zinc-400">Last Backfill Import</p><p className="font-semibold">{displayDateTime(customer.sourceCoverage?.lastBackfillImportAt)}</p></div>
          <div><p className="text-xs uppercase text-zinc-400">Last Customer Rebuild</p><p className="font-semibold">{displayDateTime(customer.sourceCoverage?.lastCustomerRebuildAt || customer.sourceCoverage?.lastSyncedAt || customer.lastSyncedAt)}</p></div>
          {sourceCoverageRows.map(([label, value]) => <div key={String(label)}><p className="text-xs uppercase text-zinc-400">{label}</p><p className="font-semibold">{String(value)}</p></div>)}
        </div>
        {sourceCompare && <p className={`mt-3 rounded border p-3 text-sm ${sourceCompare.mismatch ? "border-amber-500/30 bg-amber-500/10 text-amber-100" : "border-emerald-500/30 bg-emerald-500/10 text-emerald-100"}`}>
          Stored customer orders: {sourceCompare.customerOrdersCount}. WooCommerceOrder records: {sourceCompare.wooCommerceOrderRecordsCount}. {sourceCompare.mismatch ? `${sourceCompare.missingOrderNumbers.length} missing orders. ${sourceCompare.recommendation}.` : "Order counts match stored WooCommerce records."}
        </p>}
        {(customer.sourceCoverage?.warningSummary || customer.sourceCoverage?.warnings?.length) ? <p className="mt-3 rounded border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-100">{customer.sourceCoverage.warningSummary || customer.sourceCoverage.warnings?.join(" ")}</p> : null}
      </section>

      <section className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
        <h2 className="text-xl font-semibold text-sky-300">Customer Product Journey</h2>
        <div className="mt-3 grid gap-3 md:grid-cols-4">
          {[
            ["First Signup Product", customer.firstSignupProduct || "-"],
            ["First Signup Date", displayDate(customer.firstSignupDate)],
            ["First Signup Amount", money(Number(customer.firstSignupAmount ?? 0))],
            ["Last Purchased Product", customer.lastPurchasedProduct || "-"],
            ["Base Products", listOrDash(baseProductsPurchased)],
            ["Boost/Add-ons", listOrDash(boostAndAddOns)],
            ["Attempted Products", listOrDash(attemptedProductSummary)],
          ].map(([label, value]) => <div key={label} className="rounded border border-zinc-700 bg-zinc-950 p-3">
            <p className="text-xs font-semibold uppercase text-zinc-400">{label}</p>
            <p className="mt-2 text-sm font-semibold text-zinc-100">{value}</p>
          </div>)}
        </div>
        <div className="mt-4 overflow-x-auto rounded border border-zinc-800">
          <table className="min-w-[1000px] text-sm">
            <thead className="bg-zinc-950"><tr>{["Date", "Order #", "Product", "Category", "Amount", "Type", "Status", "Payment Method"].map((h) => <th key={h} className="px-3 py-2 text-left text-xs uppercase text-zinc-400">{h}</th>)}</tr></thead>
            <tbody>{productJourney.map((item, index) => <tr key={`${item.orderNumber}-${item.productName}-${index}`} className="border-t border-zinc-800">
              <td className="px-3 py-3">{displayDate(item.date)}</td>
              <td className="px-3 py-3">{item.orderNumber}</td>
              <td className="px-3 py-3 font-semibold">{item.productName || "Authorize.net Payment"}</td>
              <td className="px-3 py-3"><span className={`rounded border px-2 py-1 text-xs ${productCategoryBadgeClass(item.category)}`}>{productCategoryLabel(item.category)}</span></td>
              <td className="px-3 py-3">{money(item.amount)}</td>
              <td className="px-3 py-3">{displayStatus(item.type)}</td>
              <td className="px-3 py-3">{displayStatus(item.status)}</td>
              <td className="px-3 py-3">{item.paymentMethod || "-"}</td>
            </tr>)}</tbody>
          </table>
          {productJourney.length === 0 && <p className="p-3 text-zinc-400">No product journey has been synced for this customer yet.</p>}
        </div>
      </section>

      <section className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
        <h2 className="text-xl font-semibold text-amber-300">Product / Checkout Timeline</h2>
        <div className="mt-3 overflow-x-auto">
          <table className="min-w-[1100px] text-sm">
            <thead className="bg-zinc-950"><tr>{["Date", "Order #", "Status", "Payment Method", "Products", "Amount", "Type", "Action"].map((h) => <th key={h} className="px-3 py-2 text-left text-xs uppercase text-zinc-400">{h}</th>)}</tr></thead>
            <tbody>{orders.map((order) => {
              const type = getOrderType(order);
              return <tr key={order.orderId} className="border-t border-zinc-800">
                <td className="px-3 py-3">{displayDateTime(order.dateCreated)}</td>
                <td className="px-3 py-3">{order.orderNumber}{order.source === "authorize_net_only" && <span className="ml-2 rounded border border-emerald-500/50 bg-emerald-500/15 px-2 py-1 text-xs text-emerald-200">Authorize.net Only</span>}{order.source === "nmi_quick_pay_only" && <span className="ml-2 rounded border border-sky-500/50 bg-sky-500/15 px-2 py-1 text-xs text-sky-200">NMI Quick Pay Only</span>}</td>
                <td className="px-3 py-3">{displayStatus(order.status)}</td>
                <td className="px-3 py-3">{order.paymentMethodTitle || order.paymentMethod || "-"}</td>
                <td className="px-3 py-3">{productNames(order)}</td>
                <td className="px-3 py-3">{money(order.total)}</td>
                <td className="px-3 py-3"><span className={`rounded border px-2 py-1 text-xs ${badgeClass(type)}`}>{type}</span></td>
                <td className="px-3 py-3">{order.isPaid ? "Review retention" : "Recover checkout"}</td>
              </tr>;
            })}</tbody>
          </table>
          {orders.length === 0 && <p className="p-3 text-zinc-400">No WooCommerce order timeline has been synced for this customer yet.</p>}
        </div>
      </section>

      <section className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
        <h2 className="text-xl font-semibold text-emerald-300">Products Purchased</h2>
        <div className="mt-3 grid gap-3 md:grid-cols-3">{paidProductRows.map((product) => <div key={product.name} className="rounded border border-emerald-500/30 bg-emerald-500/10 p-3">
          <p className="font-semibold">{product.name}</p>
          <p className="text-sm text-zinc-300">Qty: {product.quantity || "-"}</p>
          <p className="text-sm text-zinc-300">Paid: {product.amount > 0 ? money(product.amount) : "-"}</p>
          <p className="text-sm text-zinc-400">Last paid: {displayDate(product.lastPaidDate)}</p>
          <p className="text-sm text-zinc-400">Status: {displayStatus(product.status)}</p>
          <p className="text-sm text-zinc-400">Payment method: {product.paymentMethod}</p>
        </div>)}</div>
        {paidProductRows.length === 0 && <p className="mt-2 text-zinc-400">No purchased products found.</p>}
      </section>

      <section className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
        <h2 className="text-xl font-semibold text-orange-300">Attempted Products</h2>
        <div className="mt-3 grid gap-3 md:grid-cols-3">{attemptedProductRows.map((product) => <div key={product.name} className="rounded border border-orange-500/30 bg-orange-500/10 p-3">
          <p className="font-semibold">{product.name}</p>
          <p className="text-sm text-zinc-300">Qty: {product.quantity}</p>
          <p className="text-sm text-zinc-300">Attempted: {money(product.amount)}</p>
          <p className="text-sm text-zinc-400">Last attempt: {displayDate(product.lastAttemptDate)}</p>
          <p className="text-sm text-zinc-400">Status: {displayStatus(product.status)}</p>
          <p className="text-sm text-zinc-400">Payment method: {product.paymentMethod}</p>
        </div>)}</div>
        {attemptedProductRows.length === 0 && <p className="mt-2 text-zinc-400">No attempted products found.</p>}
      </section>

      <section className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
        <h2 className="text-xl font-semibold text-red-300">Unified Payment History</h2>
        <div className="mt-3 grid gap-3 md:grid-cols-4">
          {[
            ["Unified Paid", money(Number(customer.unifiedPaymentMetrics?.paidTotal ?? actualPaid))],
            ["Unified Attempted", money(Number(customer.unifiedPaymentMetrics?.attemptedTotal ?? attempted))],
            ["Refunds / Chargebacks", money(Number(customer.unifiedPaymentMetrics?.refundTotal ?? 0))],
            ["Duplicates Skipped", Number(customer.unifiedPaymentMetrics?.duplicateSkipped ?? 0)],
          ].map(([label, value]) => <div key={label} className="rounded border border-zinc-700 bg-zinc-950 p-3">
            <p className="text-xs font-semibold uppercase text-zinc-400">{label}</p>
            <p className="mt-2 text-sm font-semibold text-zinc-100">{value}</p>
          </div>)}
        </div>
        <div className="mt-3 overflow-x-auto rounded border border-zinc-800">
          <table className="min-w-[1350px] text-sm">
            <thead className="bg-zinc-950"><tr>{["Date", "Source", "Provider", "Transaction ID", "Invoice / Order #", "Product / Description", "Status", "Amount", "Card Last4", "Match Method", "Confidence"].map((h) => <th key={h} className="px-3 py-2 text-left text-xs uppercase text-zinc-400">{h}</th>)}</tr></thead>
            <tbody>{unifiedPaymentRows.map((payment, index) => <tr key={`${payment.source}-${payment.transactionId || payment.invoiceNumber}-${index}`} className={`border-t border-zinc-800 ${payment.revenueType === "paid" ? "bg-emerald-500/5" : payment.revenueType === "attempted" ? "bg-orange-500/5" : payment.revenueType === "refund" ? "bg-amber-500/5" : ""}`}>
              <td className="px-3 py-3">{displayDateTime(payment.date)}</td>
              <td className="px-3 py-3">{payment.source === "nmi_quick_pay" ? "NMI Quick Pay" : payment.source === "authorize_net" ? "Authorize.net" : "Website / WooCommerce"}</td>
              <td className="px-3 py-3">{displayStatus(payment.provider)}</td>
              <td className="px-3 py-3">{payment.transactionId || "-"}</td>
              <td className="px-3 py-3">{payment.invoiceNumber || "-"}</td>
              <td className="px-3 py-3">{payment.productDescription || "-"}</td>
              <td className="px-3 py-3"><span className={`rounded border px-2 py-1 text-xs ${gatewayStatusBadgeClass(payment.status)}`}>{displayStatus(payment.status)}</span></td>
              <td className="px-3 py-3">{money(payment.amount)}</td>
              <td className="px-3 py-3">{payment.cardLast4 || "-"}</td>
              <td className="px-3 py-3">{displayStatus(payment.matchMethod)}</td>
              <td className="px-3 py-3">{displayStatus(payment.confidence)}</td>
            </tr>)}</tbody>
          </table>
          {unifiedPaymentRows.length === 0 && <p className="p-3 text-zinc-400">No unified payment history has been imported for this customer yet.</p>}
        </div>
      </section>

      <section className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
        <h2 className="text-xl font-semibold text-sky-300">Payment Verification</h2>
        {latestGatewayPayment ? <>
          <div className="mt-3 grid gap-3 md:grid-cols-4">
            <div><p className="text-xs uppercase text-zinc-400">Provider</p><p className="font-semibold">{displayStatus(latestGatewayPayment.provider || verification?.provider)}</p></div>
            <div><p className="text-xs uppercase text-zinc-400">Status</p><p className="font-semibold">{displayStatus(latestGatewayPayment.status || verification?.transactionStatus)}</p></div>
            <div><p className="text-xs uppercase text-zinc-400">Transaction ID</p><p className="font-semibold">{latestGatewayPayment.transactionId || verification?.transactionId || "-"}</p></div>
            <div><p className="text-xs uppercase text-zinc-400">Invoice #</p><p className="font-semibold">{latestGatewayPayment.invoiceNumber || "-"}</p></div>
            <div><p className="text-xs uppercase text-zinc-400">Amount</p><p className="font-semibold">{money(Number(latestGatewayPayment.amount ?? verification?.amount ?? 0))}</p></div>
            <div><p className="text-xs uppercase text-zinc-400">Card Type</p><p className="font-semibold">{latestGatewayPayment.cardType || verification?.cardType || "-"}</p></div>
            <div><p className="text-xs uppercase text-zinc-400">Last 4</p><p className="font-semibold">{latestGatewayPayment.cardLast4 || verification?.last4 || "-"}</p></div>
            <div><p className="text-xs uppercase text-zinc-400">Customer Profile ID</p><p className="font-semibold">{latestGatewayPayment.customerProfileId || verification?.customerProfileId || "-"}</p></div>
            <div><p className="text-xs uppercase text-zinc-400">Payment Profile ID</p><p className="font-semibold">{latestGatewayPayment.customerPaymentProfileId || verification?.paymentProfileId || "-"}</p></div>
            <div><p className="text-xs uppercase text-zinc-400">Last Checked</p><p className="font-semibold">{displayDateTime(verification?.lastCheckedAt || latestGatewayPayment.date)}</p></div>
          </div>
          <p className="mt-3 text-zinc-300">{verification?.notes || "Latest gateway payment matched to this customer."}</p>
        </> : <p className="mt-3 rounded border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-100">No gateway payment has been matched yet. Run Authorize.net repair or reconciliation.</p>}
      </section>

      <section className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
        <h2 className="text-xl font-semibold text-emerald-300">Gateway Payment History</h2>
        <div className="mt-3 grid gap-3 md:grid-cols-4">
          {[
            ["Total Gateway Paid", money(gatewayPaidTotal)],
            ["Total Declined Attempts", money(gatewayDeclinedTotal)],
            ["Gateway Approval Rate", `${gatewayApprovalRate.toFixed(0)}%`],
            ["Last Gateway Activity", displayDateTime(latestGatewayPayment?.date)],
          ].map(([label, value]) => <div key={label} className="rounded border border-zinc-700 bg-zinc-950 p-3">
            <p className="text-xs font-semibold uppercase text-zinc-400">{label}</p>
            <p className="mt-2 text-sm font-semibold text-zinc-100">{value}</p>
          </div>)}
        </div>
        <div className="mt-3 overflow-x-auto rounded border border-zinc-800">
          <table className="min-w-[1050px] text-sm">
            <thead className="bg-zinc-950"><tr>{["Date", "Provider", "Transaction ID", "Invoice #", "Status", "Amount", "Card Last4", "Card Type", "Match Method", "Confidence", "Source"].map((h) => <th key={h} className="px-3 py-2 text-left text-xs uppercase text-zinc-400">{h}</th>)}</tr></thead>
            <tbody>{gatewayHistoryRows.map((payment) => <tr key={payment.transactionId || `${payment.invoiceNumber}-${payment.date}`} className={`border-t border-zinc-800 ${payment.source === "authorize_net_only" ? "bg-emerald-500/5" : ""}`}>
              <td className="px-3 py-3">{displayDateTime(payment.date)}</td>
              <td className="px-3 py-3">{displayStatus(payment.provider)}</td>
              <td className="px-3 py-3">{payment.transactionId}</td>
              <td className="px-3 py-3">{payment.invoiceNumber || "-"}</td>
              <td className="px-3 py-3"><span className={`rounded border px-2 py-1 text-xs ${gatewayStatusBadgeClass(payment.status)}`}>{displayStatus(payment.status)}</span></td>
              <td className="px-3 py-3">{money(payment.amount)}</td>
              <td className="px-3 py-3">{payment.cardLast4 || "-"}</td>
              <td className="px-3 py-3">{payment.cardType || "-"}</td>
              <td className="px-3 py-3">{displayStatus(payment.matchedBy)}</td>
              <td className="px-3 py-3">{displayStatus(payment.matchConfidence)}</td>
              <td className="px-3 py-3">{payment.source === "authorize_net_only" ? "Authorize.net only" : payment.source === "nmi_quick_pay_only" ? "NMI Quick Pay only" : displayStatus(payment.source)}</td>
            </tr>)}</tbody>
          </table>
          {gatewayHistoryRows.length === 0 && <p className="p-3 text-zinc-400">No gateway payment history has been reconciled for this customer yet.</p>}
        </div>
      </section>

      <section className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
        <h2 className="text-xl font-semibold text-red-300">Sales Executive Follow-Up Plan</h2>
        <div className="mt-3 grid gap-3 md:grid-cols-4">
          <div><p className="text-xs uppercase text-zinc-400">Priority</p><p className="font-semibold">{plan.priority}</p></div>
          <div><p className="text-xs uppercase text-zinc-400">Best Action</p><p className="font-semibold">{plan.bestAction}</p></div>
          <div><p className="text-xs uppercase text-zinc-400">Contact Method</p><p className="font-semibold">{customer.recommendedContactMethod || "email"}</p></div>
          <div><p className="text-xs uppercase text-zinc-400">Goal</p><p className="font-semibold">{plan.goal}</p></div>
        </div>
        <p className="mt-3 text-zinc-300">{plan.detail}</p>
      </section>

      <section className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
        <h2 className="text-xl font-semibold text-emerald-300">Follow-Up Templates</h2>
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          {[
            ["Email Template", templates.email],
            ["SMS Template", templates.sms],
            ["Call Script", templates.call],
            ["Internal CRM Note", templates.note],
          ].map(([label, text]) => <div key={label} className="rounded border border-zinc-700 bg-zinc-950 p-3">
            <div className="flex items-center justify-between gap-2"><h3 className="font-semibold">{label}</h3><button onClick={() => copy(text, label)} className="rounded bg-zinc-700 px-2 py-1 text-sm">Copy</button></div>
            <pre className="mt-2 whitespace-pre-wrap text-sm text-zinc-300">{text}</pre>
          </div>)}
        </div>
      </section>

      <section className="rounded-xl border border-zinc-800 bg-zinc-900 p-4"><h2 className="font-semibold text-red-300">Internal Review</h2><input className="mt-2 w-full rounded bg-zinc-800 p-2" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="tags, separated, by commas" /><textarea className="mt-2 h-32 w-full rounded bg-zinc-800 p-2" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Internal notes" /><button className="mt-2 rounded bg-red-700 px-4 py-2" onClick={save}>Save Notes</button>{message && <p className="mt-2 text-emerald-300">{message}</p>}</section>

      <section className="rounded-xl border border-zinc-800 bg-zinc-900 p-4"><h2 className="font-semibold text-amber-300">Subscriptions and Candidates</h2><div className="mt-2 space-y-2">{subscriptions.length === 0 ? <p className="text-zinc-400">No linked subscription or recurring product candidate records.</p> : subscriptions.map((sub) => <div key={String(sub.subscriptionId)} className="rounded border border-zinc-700 p-2 text-sm"><p className="font-semibold">{String(sub.source)} - {String(sub.subscriptionId)}</p><p>Status: {String(sub.status)} | Amount: {String(sub.amount)} | Next Bill: {String(sub.nextBillingDate || "N/A")}</p></div>)}</div></section>
  </DetailShell>;
}

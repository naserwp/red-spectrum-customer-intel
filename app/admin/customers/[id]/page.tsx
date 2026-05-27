"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { Fragment, type ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { AdminHeader } from "@/app/admin/_components/AdminHeader";
import { AdminLayout, AdminLoadingState } from "@/app/admin/_components/AdminLayout";
import { resolveCustomerState } from "@/lib/customerState";

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
  selectedCreditKey?: string;
  selectedAvailableCreditKey?: string;
  selectedOutstandingKey?: string;
  selectedEinKey?: string;
  factiivSearchQuery?: string;
  factiivMatchReason?: string;
  lastFactiivSearchQueries?: string[];
  lastFactiivSearchResultsCount?: number;
  lastFactiivMatchReason?: string;
  manualAttachedBy?: string;
  manualAttachedAt?: string;
  enrichmentSources?: string[];
  socialProfilesFound?: number;
  publicBusinessDataFound?: boolean;
  lastEnrichmentRun?: string;
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

type UnifiedPaymentOrigin =
  | "woocommerce_checkout"
  | "woocommerce_subscription_renewal"
  | "authorize_net_manual"
  | "authorize_net_cim_profile"
  | "authorize_net_recurring"
  | "ghl_payment_link"
  | "nmi"
  | "stripe"
  | "unknown_gateway";

type UnifiedPaymentLedgerRow = {
  date: string;
  source: "woocommerce" | "authorize_net" | "nmi_quick_pay";
  provider: string;
  origin: UnifiedPaymentOrigin;
  originClassificationReason: string;
  transactionId: string;
  invoiceNumber: string;
  productDescription: string;
  status: string;
  amount: number;
  cardLast4: string;
  matchMethod: string;
  confidence: string;
  revenueType: "paid" | "attempted" | "refund" | "pending";
  matchedWooOrderId: string;
  matchedSubscriptionId: string;
  gatewayProfileId: string;
  paymentProfileId: string;
  recurringPatternDetected: boolean;
  retryDetected: boolean;
  staleNextPaymentPrevented: boolean;
};

type UnifiedPaymentMetrics = {
  paidTotal: number;
  attemptedTotal: number;
  refundTotal: number;
  paidCount: number;
  attemptedCount: number;
  duplicateSkipped: number;
  lastActivity: string;
  paidByWooCommerce: number;
  paidBySubscriptionRenewal: number;
  paidByAuthorizeNetManual: number;
  paidByCimRecurring: number;
  failedAttemptsBySource: Partial<Record<UnifiedPaymentOrigin, number>>;
  lastFailedAttempt: string;
  nextRetryAttempt: string;
  lastSuccessfulPayment: string;
  activePaymentProfileCount: number;
};

type SubscriptionIntelligence = {
  activeSubscriptionCount: number;
  paymentFrequency: string;
  nextPayment: string;
  lastPayment: string;
  nextRetryAttempt: string;
  staleNextPaymentPrevented: boolean;
};

type BusinessProfile = {
  firstName?: string;
  lastName?: string;
  businessName?: string;
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
  industry?: string;
  industryClassification?: string;
  naicsCode?: string;
  sicCode?: string;
  fundingReadinessScore?: number;
  fundingReadinessTier?: string;
  source?: string;
  importedAt?: string;
};

type CreditProfile = {
  approvedCredits?: number;
  availableCredit?: number;
  outstandingBalance?: number;
  creditStatus?: string;
  lastBillDate?: string;
  nextBillingDate?: string;
  sourcePostId?: string;
  source?: string;
  verified?: boolean;
  ein?: string;
};

type FactiivProfile = {
  profileId?: string;
  factiivProfileId?: string;
  factiivScore?: number;
  reputationScore?: number;
  historyScore?: number;
  utilizationScore?: number;
  tradeQuantity?: number;
  tradeAmountTotal?: number;
  tradeBalanceTotal?: number;
  activityQuantity?: number;
  activityPaymentAmountTotal?: number;
  activityLastKnownBalanceTotal?: number;
  matchedBusinessName?: string;
  matchedEmail?: string;
  matchedUsername?: string;
  factiivMatched?: boolean;
  factiivMatchConfidence?: string;
  matchedBy?: string;
  autoPersisted?: boolean;
  autoPersistReason?: string;
  factiivSearchQuery?: string;
  factiivMatchReason?: string;
  lastFactiivSync?: string;
  manualAttachedBy?: string;
  manualAttachedAt?: string;
  trades?: Array<{
    tradeId?: string;
    tradeName?: string;
    tradeType?: string;
    relation?: string;
    amount?: number;
    balance?: number;
    tradeStatus?: string;
    adminStatus?: string;
    fromCompanyName?: string;
    toCompanyName?: string;
    lastActivity?: string;
    utilizationPercent?: number;
  }>;
  activities?: Array<{
    activityDate?: string;
    activityType?: string;
    paymentAmount?: number;
    chargeAmount?: number;
    interest?: number;
    daysLate?: number;
    paymentStatus?: string;
  }>;
};

type FactiivSearchRow = {
  profileId: string;
  businessName: string;
  email: string;
  username: string;
  factiivScore: number;
  tradeQuantity: number;
  tradeAmountTotal: number;
  tradeBalanceTotal: number;
  rawSummary: string;
  matchConfidence: string;
  matchReason: string;
  selectedProfileData: FactiivProfile;
};

type PublicEnrichment = {
  websiteDomain?: string;
  linkedInCompanyUrl?: string;
  facebookPageUrl?: string;
  instagramUrl?: string;
  twitterUrl?: string;
  publicBusinessWebsite?: string;
  googleBusinessProfileUrl?: string;
  secretaryOfStateUrl?: string;
  inferredIndustry?: string;
  naicsCode?: string;
  sicCode?: string;
  enrichmentSources?: string[];
  socialProfilesFound?: number;
  publicBusinessDataFound?: boolean;
  confidence?: string;
  enrichmentStatus?: string;
  lastChecked?: string;
  lastEnrichmentRun?: string;
};

type CustomerDetail = {
  _id: string;
  name: string;
  email: string;
  phone?: string;
  businessName?: string;
  businessNameSource?: string;
  totalPaid: number;
  paidTotal?: number;
  attemptedTotal?: number;
  paidOrderCount?: number;
  attemptedOrderCount?: number;
  paidMonths?: number;
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
  creditProfile?: CreditProfile;
  factiivProfile?: FactiivProfile;
  publicEnrichment?: PublicEnrichment;
  subscriptionIntelligence?: SubscriptionIntelligence;
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
const displayDateTime = (value?: string) => {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString();
};
const paymentSourceLabel = (value?: string) => {
  if (value === "nmi_quick_pay") return "NMI Quick Pay";
  if (value === "authorize_net") return "Authorize.net";
  if (value === "woocommerce") return "Website / WooCommerce";
  return displayStatus(value);
};
const paymentOriginLabel = (value?: UnifiedPaymentOrigin) => {
  switch (value) {
    case "woocommerce_checkout":
      return "WooCommerce Checkout";
    case "woocommerce_subscription_renewal":
      return "Subscription Renewal";
    case "authorize_net_manual":
      return "Authorize.net Manual";
    case "authorize_net_cim_profile":
      return "Authorize.net CIM";
    case "authorize_net_recurring":
      return "Authorize.net Recurring";
    case "ghl_payment_link":
      return "GHL Payment Link";
    case "nmi":
      return "NMI";
    case "stripe":
      return "Stripe";
    default:
      return "Unknown Gateway";
  }
};
const monthSpan = (start?: string, end = new Date()) => {
  const date = start ? new Date(start) : null;
  if (!date || Number.isNaN(date.getTime())) return 0;
  return Math.max(0, (end.getFullYear() - date.getFullYear()) * 12 + end.getMonth() - date.getMonth() + 1);
};
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

function BackToCustomersLink() {
  return <Link href="/admin?tab=customers" className="w-fit rounded border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm font-semibold text-zinc-100 transition hover:border-red-500/60 hover:bg-zinc-800">
    Back to Customer List
  </Link>;
}

function fundingTierLabel(score: number, paid: number) {
  if (score >= 85 && paid >= 10000) return "Funding VIP Elite";
  if (score >= 75 && paid >= 5000) return "Funding VIP";
  if (score >= 65) return "Funding Ready";
  if (score >= 50) return "Needs Enrichment";
  return "Not Ready";
}

function vipTierLabel(paid: number) {
  if (paid >= 10000) return "VIP Elite";
  if (paid >= 5000) return "VIP";
  if (paid >= 2000) return "High Value";
  return "Standard";
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
  const [message, setMessage] = useState("");
  const [loadError, setLoadError] = useState("");
  const [subscriptions, setSubscriptions] = useState<Array<Record<string, string | number>>>([]);
  const [sourceCompare, setSourceCompare] = useState<SourceCompare | null>(null);
  const [expandedPaymentRow, setExpandedPaymentRow] = useState<string | null>(null);
  const [factiivSearchMode, setFactiivSearchMode] = useState<"email" | "business" | "name" | "ein" | "custom">("email");
  const [factiivCustomQuery, setFactiivCustomQuery] = useState("");
  const [factiivResults, setFactiivResults] = useState<FactiivSearchRow[]>([]);
  const [isFactiivSearching, setIsFactiivSearching] = useState(false);
  const [attachingProfileId, setAttachingProfileId] = useState("");
  const activeController = useRef<AbortController | null>(null);
  const requestSequence = useRef(0);
  const factiivAutoSearchKey = useRef("");

  const mergeCustomerWithAttachedFactiiv = useCallback((
    current: CustomerDetail | null,
    attachedProfile?: FactiivProfile | null,
    fundingIntelligence?: { fundingReadinessScore?: number; fundingReadinessTier?: string } | null
  ) => {
    if (!current) return current;
    if (!attachedProfile?.factiivMatched) return current;
    return {
      ...current,
      factiivProfile: attachedProfile,
      businessProfile: {
        ...(current.businessProfile ?? {}),
        fundingReadinessScore: Number(
          fundingIntelligence?.fundingReadinessScore
          ?? current.businessProfile?.fundingReadinessScore
          ?? 0
        ),
        fundingReadinessTier: String(
          fundingIntelligence?.fundingReadinessTier
          ?? current.businessProfile?.fundingReadinessTier
          ?? ""
        ),
      },
    };
  }, []);

  const refreshCustomerSnapshot = useCallback(async (
    attachedProfile?: FactiivProfile | null,
    fundingIntelligence?: { fundingReadinessScore?: number; fundingReadinessTier?: string } | null
  ) => {
    const safeId = encodeURIComponent(decodeURIComponent(params.id));
    const response = await fetch(`/api/customers/${safeId}`, { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Customer not found.");
    const freshCustomer = data.customer as CustomerDetail;
    const refetchProfileMatched = Boolean(freshCustomer?.factiivProfile?.factiivMatched);
    const attachedProfileReceived = Boolean(attachedProfile?.factiivMatched);
    const usingLocalAttachedProfileFallback = !refetchProfileMatched && attachedProfileReceived;
    if (typeof window !== "undefined") {
      console.debug("[factiv-ui]", {
        attachedProfileReceived,
        refetchProfileMatched,
        usingLocalAttachedProfileFallback,
      });
    }
    const nextCustomer = usingLocalAttachedProfileFallback
      ? mergeCustomerWithAttachedFactiiv(freshCustomer, attachedProfile, fundingIntelligence)
      : freshCustomer;
    setCustomer(nextCustomer);
  }, [mergeCustomerWithAttachedFactiiv, params.id]);

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

    try {
      const safeId = encodeURIComponent(decodeURIComponent(params.id));
      const response = await fetch(`/api/customers/${safeId}`, { signal: controller.signal, cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Customer not found.");
      if (requestSequence.current !== requestId) return;
      const nextCustomer = data.customer;
      setCustomer(nextCustomer);
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

  const runFactiivSearch = useCallback(async () => {
    if (!customer) return;
    setIsFactiivSearching(true);
    try {
      const response = await fetch("/api/factiv/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customerId: customer._id,
          mode: factiivSearchMode,
          email: customer.email,
          businessName: customer.businessProfile?.company || customer.name || "",
          customerName: customer.name,
          ein: customer.businessProfile?.ein || "",
          customQuery: factiivCustomQuery,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Factiiv search failed.");
      setFactiivResults(data.results ?? []);
      if (data.autoPersisted) {
        const attachedProfile = (data.attachedProfile ?? null) as FactiivProfile | null;
        const fundingIntelligence = data.fundingIntelligence ?? null;
        setCustomer((current) => mergeCustomerWithAttachedFactiiv(current, attachedProfile, fundingIntelligence));
        setMessage("Factiiv profile attached.");
        await refreshCustomerSnapshot(attachedProfile, fundingIntelligence);
        return;
      }
      setMessage(`Factiiv search returned ${Number(data.resultsCount ?? 0)} results.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Factiiv search failed.");
      setFactiivResults([]);
    } finally {
      setIsFactiivSearching(false);
    }
  }, [customer, factiivCustomQuery, factiivSearchMode, mergeCustomerWithAttachedFactiiv, refreshCustomerSnapshot]);

  useEffect(() => {
    if (!customer?._id || !customer.email || customer.factiivProfile?.factiivMatched || isFactiivSearching) return;
    const key = `${customer._id}:${customer.email}`;
    if (factiivAutoSearchKey.current === key) return;
    factiivAutoSearchKey.current = key;
    void runFactiivSearch();
  }, [customer?._id, customer?.email, customer?.factiivProfile?.factiivMatched, isFactiivSearching, runFactiivSearch]);

  const attachFactiivProfile = useCallback(async (result: FactiivSearchRow) => {
    if (!customer) return;
    setAttachingProfileId(result.profileId);
    try {
      const response = await fetch("/api/factiv/attach-profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customerId: customer._id,
          profileId: result.profileId,
          selectedProfileData: result.selectedProfileData,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Factiiv attach failed.");
      const attachedProfile = (data.factiivProfile ?? result.selectedProfileData) as FactiivProfile;
      const fundingIntelligence = data.fundingIntelligence ?? null;
      setCustomer((current) => mergeCustomerWithAttachedFactiiv(current, attachedProfile, fundingIntelligence));
      setMessage("Factiiv profile attached.");
      await refreshCustomerSnapshot(attachedProfile, fundingIntelligence);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Factiiv attach failed.");
    } finally {
      setAttachingProfileId("");
    }
  }, [customer, mergeCustomerWithAttachedFactiiv, refreshCustomerSnapshot]);

  if (isLoading) return <CustomerLoadingState />;
  if (loadError || !customer) return <CustomerErrorState onRetry={loadCustomer} />;

  const orders = [...(customer.orders ?? [])].sort((a, b) => new Date(b.dateCreated).getTime() - new Date(a.dateCreated).getTime());
  const gatewayOnlyOrders = orders.filter((order) => order.source === "authorize_net_only" || order.source === "nmi_quick_pay_only");
  const wooCustomerOrdersStored = orders.length - gatewayOnlyOrders.length;
  const paidOrdersFromTimeline = orders.filter(isPaidOrder);
  const actualPaid = Number(customer.paidTotal ?? customer.totalPaid ?? 0);
  const attempted = Number(customer.attemptedTotal ?? 0);
  const displayedPaidOrderCount = orders.length > 0 ? paidOrdersFromTimeline.length : customer.paidOrderCount ?? 0;
  const timelineMissingForPaid = actualPaid > 0 && orders.length === 0 && Number(customer.orderCount ?? 0) > 0;
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
  const profile = customer.businessProfile ?? {};
  const factiiv = customer.factiivProfile ?? {};
  const enrichment = customer.publicEnrichment ?? {};
  const latestOrderWithBilling = orders.find((order) => order.billingCompany || order.billingPhone || order.billingAddress?.address1 || order.billingEmail) ?? orders[0];
  const businessState = resolveCustomerState(customer);
  const businessInfo = {
    businessName: customer.businessName || profile.businessName || profile.company || latestOrderWithBilling?.billingCompany || customer.name || "-",
    dba: profile.dba || "-",
    ein: profile.ein || "-",
    phone: profile.phone || latestOrderWithBilling?.billingPhone || customer.phone || "-",
    email: profile.email || customer.email || latestOrderWithBilling?.billingEmail || "-",
    billingAddress: [profile.address1 || latestOrderWithBilling?.billingAddress?.address1, profile.address2 || latestOrderWithBilling?.billingAddress?.address2].filter(Boolean).join(", ") || "-",
    shippingAddress: [profile.shippingAddress1, profile.shippingAddress2].filter(Boolean).join(", ") || "-",
    city: profile.city || latestOrderWithBilling?.billingAddress?.city || "-",
    state: businessState.stateCode || profile.state || latestOrderWithBilling?.billingAddress?.state || "-",
    zip: profile.zip || latestOrderWithBilling?.billingAddress?.postcode || "-",
    country: profile.country || latestOrderWithBilling?.billingAddress?.country || "-",
    website: profile.website || enrichment.publicBusinessWebsite || enrichment.websiteDomain || "-",
    sourcePlatform: profile.sourcePlatform || profile.source || latestOrderWithBilling?.source || "customer_record",
    customerSince: profile.customerSince || customer.firstPaidDate || customer.firstSignupDate || customer.firstOrderDate || "",
    lastActivity: profile.lastActivity || customer.lastPaidDate || customer.lastOrderDate || customer.lastSyncedAt || "",
  };
  const credit = customer.creditProfile ?? {};
  const creditMetaVerified = Boolean(credit.verified && credit.source === "wc_cs_credits");
  const approvedCredits = creditMetaVerified ? Number(credit.approvedCredits ?? profile.approvedCredits ?? profile.creditLimit ?? 0) : 0;
  const totalCreditLimit = creditMetaVerified ? Math.max(
    approvedCredits,
    Number(credit.availableCredit ?? profile.potentialCreditLimit ?? 0)
  ) : 0;
  const availableCredit = creditMetaVerified ? Number(credit.availableCredit ?? profile.availableCredit ?? 0) : 0;
  const outstandingBalance = creditMetaVerified ? Number(credit.outstandingBalance ?? profile.outstandingBalance ?? 0) : 0;
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
  const gatewayDecisionCount = gatewayHistoryRows.filter((payment) => isGatewayPaidStatus(payment.status) || isGatewayDeclinedStatus(payment.status)).length;
  const gatewayApprovalRate = gatewayDecisionCount > 0 ? (gatewayHistoryRows.filter((payment) => isGatewayPaidStatus(payment.status)).length / gatewayDecisionCount) * 100 : 0;
  const unifiedPaymentRows = (customer.unifiedPaymentLedger ?? []).length
    ? customer.unifiedPaymentLedger ?? []
    : gatewayHistoryRows.map((payment) => ({
      date: payment.date,
      source: payment.provider === "nmi" || payment.provider === "nmi_quick_pay" ? "nmi_quick_pay" as const : "authorize_net" as const,
      provider: payment.provider,
      origin: payment.provider === "nmi" || payment.provider === "nmi_quick_pay" ? "nmi" as const : "unknown_gateway" as const,
      originClassificationReason: "fallback_gateway_history",
      transactionId: payment.transactionId,
      invoiceNumber: payment.invoiceNumber,
      productDescription: payment.provider === "nmi" ? "NMI Quick Pay" : "Authorize.net Payment",
      status: payment.status,
      amount: payment.amount,
      cardLast4: payment.cardLast4,
      matchMethod: payment.matchedBy,
      confidence: payment.matchConfidence,
      revenueType: isGatewayPaidStatus(payment.status) ? "paid" as const : isGatewayDeclinedStatus(payment.status) ? "attempted" as const : isGatewayRefundStatus(payment.status) ? "refund" as const : "pending" as const,
      matchedWooOrderId: "",
      matchedSubscriptionId: "",
      gatewayProfileId: payment.customerProfileId || "",
      paymentProfileId: payment.customerPaymentProfileId || "",
      recurringPatternDetected: false,
      retryDetected: false,
      staleNextPaymentPrevented: false,
    }));
  const activeSubscriptionRows = subscriptions.filter((sub) => String(sub.status ?? "").toLowerCase() === "active");
  const activeSubscriptionCount = Number(customer.subscriptionIntelligence?.activeSubscriptionCount ?? (activeSubscriptionRows.length + (customer.isGatewayRecurring ? 1 : 0)));
  const wooRecurringRevenue = activeSubscriptionRows.reduce((sum, sub) => sum + Number(sub.monthlyRecurringRevenue ?? sub.amount ?? 0), 0);
  const recurringRevenue = wooRecurringRevenue + (customer.isGatewayRecurring ? Number(customer.recurringAmount ?? 0) : 0);
  const nextRenewal = customer.subscriptionIntelligence?.nextPayment || "";
  const lastRenewal = customer.subscriptionIntelligence?.lastPayment || activeSubscriptionRows.map((sub) => String(sub.lastBillingDate ?? "")).filter(Boolean).sort().reverse()[0] || customer.recurringLastPayment || customer.lastPaidDate || "";
  const subscriptionStart = activeSubscriptionRows.map((sub) => String(sub.startDate ?? "")).filter(Boolean).sort()[0] || customer.firstSignupDate || customer.firstOrderDate || "";
  const subscriptionAgeMonths = monthSpan(subscriptionStart);
  const estimatedYearlyValue = recurringRevenue * 12;
  const renewalRisk = customer.riskLevel === "high" || customer.failedPayments > 1 ? "high" : customer.riskLevel === "medium" || customer.failedPayments > 0 ? "medium" : "low";
  const fundingTier = fundingTierLabel(Number(customer.score ?? 0), actualPaid);
  const vipTier = vipTierLabel(actualPaid);
  const fundingTierDisplay = profile.fundingReadinessTier || fundingTier;
  const paymentActivity = actualPaid > 0
    ? `${displayedPaidOrderCount} paid records, ${customer.attemptedOrderCount ?? 0} attempted`
    : `${customer.attemptedOrderCount ?? 0} attempted records`;
  const factiivTrades = factiiv.trades ?? [];
  const factiivActivities = factiiv.activities ?? [];
  const factiivScoreDisplay = factiiv.factiivMatched ? Number(factiiv.factiivScore ?? 0) : null;
  const factiivUtilizationDisplay = factiiv.factiivMatched ? `${(Number(factiiv.utilizationScore ?? 0) * 100).toFixed(1)}%` : "—";
  const fundingInsight = (() => {
    if (Number(customer.score ?? 0) >= 75 && actualPaid >= 5000) return "Strong payment history with funding-ready revenue signals.";
    if (Number(customer.score ?? 0) >= 65) return "Usable revenue profile. Verify remaining credit and business metadata before underwriting.";
    if (!creditMetaVerified) return "WP credit meta is not verified. Complete credit verification before using this profile for funding decisions.";
    return "Profile needs more paid history or recurring activity before funding outreach.";
  })();
  const gatewayProfileIds = Array.from(new Set(unifiedPaymentRows.flatMap((payment) => [payment.gatewayProfileId, payment.paymentProfileId]).filter(Boolean)));
  const paymentVerificationMessage = latestGatewayPayment
    ? (verification?.matched
        ? "Gateway verification is attached to this customer."
        : unifiedPaymentRows.some((payment) => payment.transactionId)
          ? "Gateway rows imported but not fully verified against WooCommerce orders."
          : "Gateway transactions exist for this customer, but some records remain unverified against a WooCommerce order.")
    : "No gateway rows are attached yet. Run reconciliation to import and match gateway records.";
  const failedAttemptsBySourceText = Object.entries(customer.unifiedPaymentMetrics?.failedAttemptsBySource ?? {})
    .sort((a, b) => b[1] - a[1])
    .map(([origin, count]) => `${paymentOriginLabel(origin as UnifiedPaymentOrigin)}: ${count}`)
    .join(", ") || "-";
  const paymentDetailByKey = new Map(gatewayHistoryRows.map((payment) => [payment.transactionId || `${payment.provider}-${payment.invoiceNumber}-${payment.amount}-${payment.date}`, payment]));
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
    ["Selected credit key", customer.sourceCoverage?.selectedCreditKey || "-"],
    ["Selected available key", customer.sourceCoverage?.selectedAvailableCreditKey || "-"],
    ["Selected outstanding key", customer.sourceCoverage?.selectedOutstandingKey || "-"],
    ["Selected EIN key", customer.sourceCoverage?.selectedEinKey || "-"],
    ["Credit fallback reason", customer.sourceCoverage?.creditFallbackReason || profile.creditFallbackReason || "-"],
    ["Approved credits found", customer.sourceCoverage?.approvedCreditsFound ? money(Number(customer.sourceCoverage.approvedCreditsFound)) : "-"],
    ["Available credits found", customer.sourceCoverage?.availableCreditsFound ? money(Number(customer.sourceCoverage.availableCreditsFound)) : "-"],
    ["EIN source", customer.sourceCoverage?.einSource || "-"],
    ["Factiiv search query", customer.sourceCoverage?.factiivSearchQuery || factiiv.factiivSearchQuery || "-"],
    ["Factiiv match reason", customer.sourceCoverage?.factiivMatchReason || factiiv.factiivMatchReason || "-"],
    ["Last Factiiv search queries", (customer.sourceCoverage?.lastFactiivSearchQueries ?? []).join(", ") || "-"],
    ["Last Factiiv results count", customer.sourceCoverage?.lastFactiivSearchResultsCount ?? "-"],
    ["Last Factiiv match reason", customer.sourceCoverage?.lastFactiivMatchReason || "-"],
    ["Manual attached by", customer.sourceCoverage?.manualAttachedBy || factiiv.manualAttachedBy || "-"],
    ["Manual attached at", displayDateTime(customer.sourceCoverage?.manualAttachedAt || factiiv.manualAttachedAt)],
    ["Enrichment sources", (customer.sourceCoverage?.enrichmentSources ?? enrichment.enrichmentSources ?? []).join(", ") || "-"],
    ["Social profiles found", customer.sourceCoverage?.socialProfilesFound ?? enrichment.socialProfilesFound ?? 0],
    ["Public business data found", (customer.sourceCoverage?.publicBusinessDataFound ?? enrichment.publicBusinessDataFound) ? "yes" : "no"],
    ["Last enrichment run", displayDateTime(customer.sourceCoverage?.lastEnrichmentRun || enrichment.lastEnrichmentRun)],
    ["Revenue coverage", `${Number(customer.sourceCoverage?.revenueCoveragePercent ?? (actualPaid > 0 ? 100 : 0)).toFixed(0)}%`],
  ];
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
      {message && <p className="rounded border border-emerald-800 bg-emerald-950/50 p-3 text-emerald-100">{message}</p>}

      {timelineMissingForPaid && <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-amber-100">
        <p className="font-semibold">Timeline not synced yet - run single customer sync</p>
        <p className="mt-1 text-sm text-amber-100/80">This customer has paid value and historical order count, but no saved WooCommerce order timeline on the selected record.</p>
      </div>}

      <section className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
        <h2 className="text-xl font-semibold text-blue-300">Customer Profile Summary</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
          {[
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
          ].map(([label, value]) => <div key={label} className="rounded border border-zinc-700 bg-zinc-950 p-3">
            <p className="text-xs font-semibold uppercase text-zinc-400">{label}</p>
            <p className="mt-2 text-sm font-semibold text-zinc-100 line-clamp-2">{String(value)}</p>
          </div>)}
        </div>
      </section>

      <section className="rounded-xl border border-sky-900/70 bg-sky-950/25 p-4">
        <h2 className="text-xl font-semibold text-sky-200">Factiiv Funding Intelligence</h2>
        {!factiiv.factiivMatched ? <p className="mt-3 rounded border border-sky-900/60 bg-zinc-950/70 p-3 text-sm text-zinc-300">No Factiiv profile auto-matched. Use manual search below.</p> : null}
        {factiiv.factiivMatched ? <div className="mt-3 grid gap-3 lg:grid-cols-[220px_1fr]">
          <div className="rounded border border-sky-900/60 bg-zinc-950/80 p-4">
            <p className="text-xs font-semibold uppercase text-sky-200/80">Factiiv Score</p>
            <div className="mt-3 flex items-end gap-2">
              <span className="text-4xl font-bold text-zinc-100">{factiivScoreDisplay ?? "—"}</span>
              <span className={`rounded border px-2 py-1 text-xs font-semibold ${factiiv.factiivMatchConfidence === "high" ? "border-emerald-500/50 bg-emerald-500/15 text-emerald-200" : factiiv.factiivMatchConfidence === "medium" ? "border-amber-500/50 bg-amber-500/15 text-amber-100" : "border-red-500/50 bg-red-500/15 text-red-200"}`}>{displayStatus(factiiv.factiivMatchConfidence) || "-"}</span>
            </div>
            <div className="mt-4 h-2 overflow-hidden rounded bg-zinc-800">
              <div className="h-full rounded bg-sky-500" style={{ width: `${Math.max(0, Math.min(100, Number(factiiv.factiivScore ?? 0) / 10))}%` }} />
            </div>
            <div className="mt-4 space-y-2 text-sm text-zinc-300">
              <p><span className="text-zinc-500">Matched Business:</span> {factiiv.matchedBusinessName || "—"}</p>
              <p><span className="text-zinc-500">Matched Email:</span> {factiiv.matchedEmail || "—"}</p>
              <p><span className="text-zinc-500">Matched Username / Owner:</span> {factiiv.matchedUsername || "—"}</p>
              <p><span className="text-zinc-500">Last Factiiv Sync:</span> {displayDateTime(factiiv.lastFactiivSync)}</p>
            </div>
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            {[
              ["Reputation Score", String(Number(factiiv.reputationScore ?? 0))],
              ["History Score", String(Number(factiiv.historyScore ?? 0))],
              ["Utilization Score", factiivUtilizationDisplay],
              ["Activity Quantity", String(Number(factiiv.activityQuantity ?? 0))],
              ["Payment Activity Total", money(Number(factiiv.activityPaymentAmountTotal ?? 0))],
              ["Last Known Balance", money(Number(factiiv.activityLastKnownBalanceTotal ?? 0))],
              ["Matched By", displayStatus(factiiv.matchedBy) || "-"],
              ["Auto Persist", factiiv.autoPersisted ? `yes (${factiiv.autoPersistReason || "high confidence"})` : "no"],
            ].map(([label, value]) => <div key={label} className="rounded border border-sky-900/60 bg-zinc-950/80 p-3">
              <p className="text-xs font-semibold uppercase text-sky-200/80">{label}</p>
              <p className="mt-2 text-sm font-semibold text-zinc-100">{String(value)}</p>
            </div>)}
          </div>
        </div> : null}
        <div className="mt-3 grid gap-3 md:grid-cols-4">
          {[
            ["Factiiv Score", factiiv.factiivMatched ? String(Number(factiiv.factiivScore ?? profile.fundingReadinessScore ?? 0)) : "Not matched"],
            ["Funding Tier", fundingTierDisplay],
            ["Trade Lines", factiiv.factiivMatched ? String(factiiv.tradeQuantity ?? 0) : "Not matched"],
            ["Total Trade Amount", factiiv.factiivMatched ? money(Number(factiiv.tradeAmountTotal ?? 0)) : "Not matched"],
            ["Outstanding Balance", factiiv.factiivMatched ? money(Number(factiiv.tradeBalanceTotal ?? factiiv.activityLastKnownBalanceTotal ?? 0)) : "Not matched"],
            ["Payment Activity", factiiv.factiivMatched ? `${Number(factiiv.activityQuantity ?? 0)} activities / ${money(Number(factiiv.activityPaymentAmountTotal ?? 0))}` : paymentActivity],
            ["Risk", customer.riskLevel],
            ["Verified Credit Limit", creditMetaVerified ? money(approvedCredits) : "Not verified"],
            ["VIP Tier", vipTier],
            ["MRR", recurringRevenue > 0 ? money(recurringRevenue) : "Not verified"],
          ].map(([label, value]) => <div key={label} className="rounded border border-sky-900/60 bg-zinc-950/80 p-3">
            <p className="text-xs font-semibold uppercase text-sky-200/80">{label}</p>
            <p className="mt-2 text-sm font-semibold text-zinc-100">{String(value)}</p>
          </div>)}
        </div>
        {factiivTrades.length > 0 ? <div className="mt-4 rounded border border-sky-900/60 bg-zinc-950/70 p-4">
          <p className="text-xs font-semibold uppercase text-sky-200/80">Factiiv Trades</p>
          <div className="mt-3 grid gap-3 lg:grid-cols-2">
            {factiivTrades.map((trade, index) => <div key={`${trade.tradeId || trade.tradeName || "trade"}-${index}`} className="rounded border border-zinc-800 bg-zinc-950/80 p-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-semibold text-zinc-100">{trade.tradeName || trade.tradeType || "Trade"}</p>
                  <p className="mt-1 text-xs text-zinc-400">{trade.relation || trade.tradeType || "-"}</p>
                </div>
                <span className={`rounded border px-2 py-1 text-xs font-semibold ${/verify|active|open|on[_ -]?time/i.test(String(trade.tradeStatus || trade.adminStatus)) ? "border-emerald-500/50 bg-emerald-500/15 text-emerald-200" : /late|risk|hold|review/i.test(String(trade.tradeStatus || trade.adminStatus)) ? "border-amber-500/50 bg-amber-500/15 text-amber-100" : "border-red-500/50 bg-red-500/15 text-red-200"}`}>{displayStatus(trade.tradeStatus || trade.adminStatus) || "-"}</span>
              </div>
              <div className="mt-3 grid gap-2 sm:grid-cols-2 text-sm text-zinc-300">
                <p><span className="text-zinc-500">Amount:</span> {money(Number(trade.amount ?? 0))}</p>
                <p><span className="text-zinc-500">Balance:</span> {money(Number(trade.balance ?? 0))}</p>
                <p><span className="text-zinc-500">From:</span> {trade.fromCompanyName || "-"}</p>
                <p><span className="text-zinc-500">To:</span> {trade.toCompanyName || "-"}</p>
                <p><span className="text-zinc-500">Last Activity:</span> {displayDateTime(trade.lastActivity)}</p>
                <p><span className="text-zinc-500">Utilization:</span> {Number(trade.utilizationPercent ?? 0).toFixed(1)}%</p>
              </div>
            </div>)}
          </div>
        </div> : null}
        {factiivActivities.length > 0 ? <div className="mt-4 rounded border border-sky-900/60 bg-zinc-950/70 p-4">
          <p className="text-xs font-semibold uppercase text-sky-200/80">Factiiv Activity / Payment History</p>
          <div className="mt-3 overflow-x-auto rounded border border-zinc-800">
            <table className="min-w-[900px] text-sm">
              <thead className="bg-zinc-950">
                <tr>{["Date", "Type", "Payment Amount", "Charge Amount", "Interest", "Days Late", "Status"].map((header) => <th key={header} className="px-3 py-2 text-left text-xs uppercase text-zinc-400">{header}</th>)}</tr>
              </thead>
              <tbody>
                {factiivActivities.map((activity, index) => <tr key={`${activity.activityDate || "activity"}-${index}`} className="border-t border-zinc-800">
                  <td className="px-3 py-3">{displayDateTime(activity.activityDate)}</td>
                  <td className="px-3 py-3">{displayStatus(activity.activityType) || "-"}</td>
                  <td className="px-3 py-3">{money(Number(activity.paymentAmount ?? 0))}</td>
                  <td className="px-3 py-3">{money(Number(activity.chargeAmount ?? 0))}</td>
                  <td className="px-3 py-3">{money(Number(activity.interest ?? 0))}</td>
                  <td className="px-3 py-3">{Number(activity.daysLate ?? 0)}</td>
                  <td className="px-3 py-3"><span className={`rounded border px-2 py-1 text-xs font-semibold ${String(activity.paymentStatus ?? "") === "on_time" ? "border-emerald-500/50 bg-emerald-500/15 text-emerald-200" : String(activity.paymentStatus ?? "") === "late" ? "border-red-500/50 bg-red-500/15 text-red-200" : "border-zinc-600 bg-zinc-800 text-zinc-200"}`}>{displayStatus(activity.paymentStatus) || "-"}</span></td>
                </tr>)}
              </tbody>
            </table>
          </div>
        </div> : null}
        <div className="mt-4 rounded border border-sky-900/60 bg-zinc-950/70 p-4">
          <p className="text-xs font-semibold uppercase text-sky-200/80">AI Funding Insight</p>
          <p className="mt-2 text-sm text-zinc-100">{fundingInsight}</p>
        </div>
        <div className="mt-4 rounded border border-sky-900/60 bg-zinc-950/70 p-4">
          <div className="flex flex-wrap items-center gap-3">
            {([
              ["email", "Search by Email"],
              ["business", "Search by Business Name"],
              ["name", "Search by Customer Name"],
              ["ein", "Search by EIN"],
              ["custom", "Custom search input"],
            ] as const).map(([value, label]) => (
              <button
                key={value}
                onClick={() => setFactiivSearchMode(value)}
                className={`rounded border px-3 py-2 text-sm font-semibold ${factiivSearchMode === value ? "border-sky-400 bg-sky-500/20 text-sky-100" : "border-zinc-700 bg-zinc-900 text-zinc-200 hover:bg-zinc-800"}`}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="mt-4 flex flex-col gap-3 md:flex-row">
            <input
              value={
                factiivSearchMode === "custom" ? factiivCustomQuery
                  : factiivSearchMode === "email" ? customer.email
                    : factiivSearchMode === "business" ? (profile.company || businessInfo.businessName)
                      : factiivSearchMode === "name" ? customer.name
                        : (profile.ein || "")
              }
              onChange={(event) => {
                if (factiivSearchMode === "custom") setFactiivCustomQuery(event.target.value);
              }}
              readOnly={factiivSearchMode !== "custom"}
              placeholder="Enter custom Factiiv search"
              className="flex-1 rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-sky-500"
            />
            <button
              onClick={runFactiivSearch}
              disabled={isFactiivSearching}
              className="rounded bg-sky-700 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-600 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isFactiivSearching ? "Searching..." : "Search Factiiv"}
            </button>
          </div>
          <div className="mt-4 overflow-x-auto rounded border border-zinc-800">
            <table className="min-w-[980px] text-sm">
              <thead className="bg-zinc-950">
                <tr>{["Business Name", "Email", "Username / Owner", "Factiiv Score", "Trade Lines", "Trade Amount", "Balance", "Match Confidence", "Action"].map((header) => (
                  <th key={header} className="px-3 py-2 text-left text-xs uppercase text-zinc-400">{header}</th>
                ))}</tr>
              </thead>
              <tbody>
                {factiivResults.map((result) => (
                  <tr key={result.profileId} className="border-t border-zinc-800">
                    <td className="px-3 py-3 font-semibold text-zinc-100">{result.businessName || "-"}</td>
                    <td className="px-3 py-3">{result.email || "-"}</td>
                    <td className="px-3 py-3">{result.username || "-"}</td>
                    <td className="px-3 py-3">{result.factiivScore || "-"}</td>
                    <td className="px-3 py-3">{result.tradeQuantity || "-"}</td>
                    <td className="px-3 py-3">{money(result.tradeAmountTotal)}</td>
                    <td className="px-3 py-3">{money(result.tradeBalanceTotal)}</td>
                    <td className="px-3 py-3">{displayStatus(result.matchConfidence) || "-"}</td>
                    <td className="px-3 py-3">
                      <button
                        onClick={() => attachFactiivProfile(result)}
                        disabled={attachingProfileId === result.profileId}
                        className="rounded bg-emerald-700 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {attachingProfileId === result.profileId ? "Attaching..." : "Attach Profile"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {factiivResults.length === 0 ? <p className="p-3 text-zinc-400">No Factiiv search results loaded yet.</p> : null}
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
        <h2 className="text-xl font-semibold text-red-300">Subscription Intelligence</h2>
        <div className="mt-3 grid gap-3 md:grid-cols-4">
          {[
            ["Active subscriptions", activeSubscriptionCount],
            ["Recurring revenue", money(recurringRevenue)],
            ["Payment frequency", customer.subscriptionIntelligence?.paymentFrequency || customer.recurringFrequencyEstimate || activeSubscriptionRows[0]?.billingInterval || "-"],
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
        {customer.subscriptionIntelligence?.staleNextPaymentPrevented ? <p className="mt-3 rounded border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-100">A stale next payment date was suppressed because no active renewal schedule or valid retry window is currently attached.</p> : null}
      </section>

      <section className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
        <h2 className="text-xl font-semibold text-orange-300">Business Information</h2>
        <div className="mt-3 grid gap-3 md:grid-cols-4">
          {[
            ["Customer Name", customer.name],
            ["Business Name", businessInfo.businessName],
            ["Business State", businessInfo.state],
            ["Industry", profile.industry || enrichment.inferredIndustry || "-"],
            ["EIN", businessInfo.ein],
            ["Net30 status", displayStatus(profile.net30Status || profile.accountStatus)],
            ["Estimated Credit Capacity", money(Number(profile.potentialCreditLimit || profile.creditLimit || customer.estimatedCreditLimit || 0))],
            ["Business Source", customer.businessNameSource || "-"],
            ["DBA", businessInfo.dba],
            ["Phone", businessInfo.phone],
            ["Email", businessInfo.email],
            ["Billing Address", businessInfo.billingAddress],
            ["Shipping Address", businessInfo.shippingAddress],
            ["City", businessInfo.city],
            ["State Source", businessState.stateSource || "-"],
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
        <h2 className="text-xl font-semibold text-orange-300">Credit Information</h2>
        {hasProfileData ? <div className="mt-3 grid gap-3 md:grid-cols-4">
          {[
            ["Credit Limit / Approved Credits", creditMetaVerified ? money(approvedCredits) : "WP credit meta not verified"],
            ["Available Credit", creditMetaVerified ? money(availableCredit) : "WP credit meta not verified"],
            ["Outstanding Balance", creditMetaVerified ? money(outstandingBalance) : "WP credit meta not verified"],
            ["Total Credit Limit", creditMetaVerified ? money(totalCreditLimit) : "WP credit meta not verified"],
            ["Credit Status", displayStatus(credit.creditStatus || profile.creditStatus || profile.net30Status || profile.accountStatus)],
            ["Last credit update", displayDate(profile.creditLimitLastUpdated)],
            ["Last bill date", displayDate(credit.lastBillDate || profile.lastBillDate)],
            ["Next billing date", displayDate(credit.nextBillingDate || profile.nextBillingDate)],
            ["Net 30 status", displayStatus(profile.net30Status || profile.accountStatus)],
            ["Credit meta verified", creditMetaVerified ? "true" : "false"],
            ["Credit meta source", credit.source || profile.creditMetaSource || customer.sourceCoverage?.creditMetaSource || "-"],
          ].map(([label, value]) => <div key={label} className="rounded border border-zinc-700 bg-zinc-950 p-3">
            <p className="text-xs font-semibold uppercase text-zinc-400">{label}</p>
            <p className="mt-2 text-sm font-semibold text-zinc-100">{String(value)}</p>
          </div>)}
        </div> : <p className="mt-3 rounded border border-zinc-700 bg-zinc-950 p-3 text-zinc-400">WP credit meta not verified.</p>}
      </section>

      <section className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
        <h2 className="text-xl font-semibold text-sky-300">Customer Intelligence Summary</h2>
        <div className="mt-3 rounded border border-zinc-700 bg-zinc-950 p-4">
          <p className="text-sm leading-7 text-zinc-200">{customer.aiSummary || "No customer intelligence summary is available yet."}</p>
        </div>
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
        <h2 className="text-xl font-semibold text-red-300">Payment Intelligence</h2>
        <div className="mt-3 grid gap-3 md:grid-cols-4">
          {[
            ["Paid by WooCommerce", money(Number(customer.unifiedPaymentMetrics?.paidByWooCommerce ?? 0))],
            ["Paid by Subscription Renewal", money(Number(customer.unifiedPaymentMetrics?.paidBySubscriptionRenewal ?? 0))],
            ["Paid by Authorize.net Manual", money(Number(customer.unifiedPaymentMetrics?.paidByAuthorizeNetManual ?? 0))],
            ["Paid by CIM Recurring", money(Number(customer.unifiedPaymentMetrics?.paidByCimRecurring ?? 0))],
            ["Failed Attempts by source", failedAttemptsBySourceText],
            ["Last Failed Attempt", displayDateTime(customer.unifiedPaymentMetrics?.lastFailedAttempt)],
            ["Next Retry Attempt", displayDateTime(customer.subscriptionIntelligence?.nextRetryAttempt || customer.unifiedPaymentMetrics?.nextRetryAttempt)],
            ["Last Successful Payment", displayDateTime(customer.unifiedPaymentMetrics?.lastSuccessfulPayment || latestGatewayPayment?.date)],
            ["Active Payment Profile Count", String(customer.unifiedPaymentMetrics?.activePaymentProfileCount ?? gatewayProfileIds.length)],
            ["Gateway Approval Rate", `${gatewayApprovalRate.toFixed(0)}%`],
            ["Unmatched gateway records", missingUnattachedRecords],
            ["Gateway verification", paymentVerificationMessage],
          ].map(([label, value]) => <div key={label} className="rounded border border-zinc-700 bg-zinc-950 p-3">
            <p className="text-xs font-semibold uppercase text-zinc-400">{label}</p>
            <p className="mt-2 text-sm font-semibold text-zinc-100">{value}</p>
          </div>)}
        </div>
      </section>

      <section className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
        <h2 className="text-xl font-semibold text-red-300">Unified Payment History</h2>
        <div className="mt-3 overflow-x-auto rounded border border-zinc-800">
          <table className="min-w-[980px] text-sm">
            <thead className="bg-zinc-950"><tr>{["Date", "Origin", "Status", "Amount", "Invoice / Order #", "Product", "Card Last4", "Match", ""].map((h) => <th key={h} className="px-3 py-2 text-left text-xs uppercase text-zinc-400">{h}</th>)}</tr></thead>
            <tbody>{unifiedPaymentRows.map((payment, index) => {
              const rowKey = `${payment.origin}-${payment.transactionId || payment.invoiceNumber}-${index}`;
              const details = paymentDetailByKey.get(payment.transactionId || `${payment.provider}-${payment.invoiceNumber}-${payment.amount}-${payment.date}`);
              const isExpanded = expandedPaymentRow === rowKey;
              return <Fragment key={rowKey}>
                <tr key={rowKey} className={`border-t border-zinc-800 ${payment.revenueType === "paid" ? "bg-emerald-500/5" : payment.revenueType === "attempted" ? "bg-orange-500/5" : payment.revenueType === "refund" ? "bg-amber-500/5" : ""}`}>
                  <td className="px-3 py-3">{displayDateTime(payment.date)}</td>
                  <td className="px-3 py-3">{paymentOriginLabel(payment.origin)}</td>
                  <td className="px-3 py-3"><span className={`rounded border px-2 py-1 text-xs ${gatewayStatusBadgeClass(payment.status)}`}>{displayStatus(payment.status)}</span></td>
                  <td className="px-3 py-3">{money(payment.amount)}</td>
                  <td className="px-3 py-3">{payment.invoiceNumber || "-"}</td>
                  <td className="px-3 py-3">{payment.productDescription || "-"}</td>
                  <td className="px-3 py-3">{payment.cardLast4 || "-"}</td>
                  <td className="px-3 py-3">{displayStatus(payment.matchMethod) || "-"}</td>
                  <td className="px-3 py-3"><button onClick={() => setExpandedPaymentRow(isExpanded ? null : rowKey)} className="rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs font-semibold text-zinc-200 hover:bg-zinc-800">{isExpanded ? "Hide" : "Details"}</button></td>
                </tr>
                {isExpanded && <tr className="border-t border-zinc-800 bg-zinc-950/80">
                  <td colSpan={9} className="px-3 py-3">
                    <div className="grid gap-3 md:grid-cols-3">
                      <div><p className="text-xs uppercase text-zinc-500">Transaction ID</p><p className="mt-1 break-all text-sm text-zinc-100">{payment.transactionId || "-"}</p></div>
                      <div><p className="text-xs uppercase text-zinc-500">Customer Profile ID</p><p className="mt-1 break-all text-sm text-zinc-100">{payment.gatewayProfileId || details?.customerProfileId || "-"}</p></div>
                      <div><p className="text-xs uppercase text-zinc-500">Payment Profile ID</p><p className="mt-1 break-all text-sm text-zinc-100">{payment.paymentProfileId || details?.customerPaymentProfileId || "-"}</p></div>
                      <div><p className="text-xs uppercase text-zinc-500">Raw Gateway Status</p><p className="mt-1 text-sm text-zinc-100">{displayStatus(payment.status)}</p></div>
                      <div><p className="text-xs uppercase text-zinc-500">Confidence</p><p className="mt-1 text-sm text-zinc-100">{displayStatus(payment.confidence) || "-"}</p></div>
                      <div><p className="text-xs uppercase text-zinc-500">Origin Reason</p><p className="mt-1 text-sm text-zinc-100">{displayStatus(payment.originClassificationReason) || "-"}</p></div>
                      <div><p className="text-xs uppercase text-zinc-500">Matched Woo Order ID</p><p className="mt-1 break-all text-sm text-zinc-100">{payment.matchedWooOrderId || "-"}</p></div>
                      <div><p className="text-xs uppercase text-zinc-500">Matched Subscription ID</p><p className="mt-1 break-all text-sm text-zinc-100">{payment.matchedSubscriptionId || "-"}</p></div>
                      <div><p className="text-xs uppercase text-zinc-500">Recurring Pattern</p><p className="mt-1 text-sm text-zinc-100">{payment.recurringPatternDetected ? "yes" : "no"}</p></div>
                      <div><p className="text-xs uppercase text-zinc-500">Retry Detected</p><p className="mt-1 text-sm text-zinc-100">{payment.retryDetected ? "yes" : "no"}</p></div>
                      <div><p className="text-xs uppercase text-zinc-500">Stale Next Payment Prevented</p><p className="mt-1 text-sm text-zinc-100">{payment.staleNextPaymentPrevented ? "yes" : "no"}</p></div>
                      <div><p className="text-xs uppercase text-zinc-500">Source Debug</p><p className="mt-1 text-sm text-zinc-100">{details?.source ? displayStatus(details.source) : paymentSourceLabel(payment.source)}</p></div>
                    </div>
                  </td>
                </tr>}
              </Fragment>;
            })}</tbody>
          </table>
          {unifiedPaymentRows.length === 0 && <p className="p-3 text-zinc-400">No unified payment history has been imported for this customer yet.</p>}
        </div>
      </section>

  </DetailShell>;
}

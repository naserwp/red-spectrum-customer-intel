import { extractBestBusinessContactFields } from "@/lib/customerContactFields";
import { calculateCustomerValueMetrics, monthsSince, type CustomerValueMetrics } from "@/lib/customerValue";
import { resolveFactiivScore } from "@/lib/factivScore";
import type { AuthorizeNetTransactionDocument } from "@/models/AuthorizeNetTransaction";
import type { CustomerDocument, CustomerFactiivProfile } from "@/models/Customer";
import type { CustomerRankingDocument } from "@/models/CustomerRanking";
import type { NmiQuickPayTransactionDocument } from "@/models/NmiQuickPayTransaction";
import type { StripeTransactionDocument } from "@/models/StripeTransaction";
import type { WooCommerceOrderDocument } from "@/models/WooCommerceOrder";
import type { WooCommerceSubscriptionDocument } from "@/models/WooCommerceSubscription";

export type VerificationStatus = "Verified" | "Partially Verified" | "Needs Review" | "Missing Critical Data";

export type VerificationInput = {
  customer: Partial<CustomerDocument> & { _id?: unknown };
  ranking?: Partial<CustomerRankingDocument> | null;
  wooOrders?: Partial<WooCommerceOrderDocument>[];
  authorizeNetTransactions?: Partial<AuthorizeNetTransactionDocument>[];
  nmiTransactions?: Partial<NmiQuickPayTransactionDocument>[];
  stripeTransactions?: Partial<StripeTransactionDocument>[];
  subscriptions?: Partial<WooCommerceSubscriptionDocument>[];
  duplicateEmailCount?: number;
};

export type VerificationResult = {
  customerId: string;
  email: string;
  verificationStatus: VerificationStatus;
  verificationScore: number;
  missingFields: string[];
  reviewReasons: string[];
  sourceConfidence: string;
  revenueMetrics: CustomerValueMetrics;
  revenueMismatch: boolean;
  subscriptionVerified: boolean;
  factiivScorePresent: boolean;
  fundingScorePresent: boolean;
  contactMissing: boolean;
  duplicateSuspect: boolean;
  set: Record<string, unknown>;
  rankingSet: Record<string, unknown>;
  changedFields: string[];
};

function clean(value: unknown) {
  const text = String(value ?? "").trim();
  return text && text !== "Missing" && text !== "-" ? text : "";
}

function money(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.round((parsed + Number.EPSILON) * 100) / 100 : 0;
}

function normalizeEmail(value: unknown) {
  return clean(value).toLowerCase();
}

function dateOnly(value: unknown) {
  const raw = clean(value);
  if (!raw) return "";
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString();
}

function hasValue(value: unknown) {
  return Boolean(clean(value));
}

function currentPathValue(source: unknown, path: string) {
  return path.split(".").reduce<unknown>((current, key) => {
    if (!current || typeof current !== "object") return undefined;
    return (current as Record<string, unknown>)[key];
  }, source);
}

function setIfBetter(set: Record<string, unknown>, changed: string[], customer: unknown, path: string, value: unknown) {
  const next = typeof value === "number" ? value : clean(value);
  if (next === "" || next === null || next === undefined) return;
  const current = currentPathValue(customer, path);
  if (typeof next === "number") {
    if (money(current) === money(next)) return;
  } else if (hasValue(current)) {
    return;
  }
  set[path] = next;
  changed.push(path);
}

function setNumberIfChanged(set: Record<string, unknown>, changed: string[], customer: unknown, path: string, value: unknown) {
  const next = money(value);
  const current = money(currentPathValue(customer, path));
  if (next <= 0 || Math.abs(current - next) < 0.01) return;
  set[path] = next;
  changed.push(path);
}

function fundingScore(customer: Partial<CustomerDocument>, ranking?: Partial<CustomerRankingDocument> | null) {
  return money(customer.businessProfile?.fundingScore || customer.businessProfile?.fundingReadinessScore || ranking?.fundingScore);
}

function factiivValues(customer: Partial<CustomerDocument>, ranking?: Partial<CustomerRankingDocument> | null) {
  const profile = (customer.factiivProfile ?? {}) as Partial<CustomerFactiivProfile>;
  const resolved = resolveFactiivScore(profile);
  const score = resolved.exportValue === "Missing" ? money(ranking?.factiivScore) : money(resolved.exportValue);
  const tradeLines = money(profile.tradeQuantity || ranking?.factiivTradeLines);
  return {
    profileId: clean(resolved.factiivProfileId || ranking?.factiivProfileId),
    score,
    tradeLines,
    totalTradeAmount: money(profile.tradeAmountTotal || ranking?.factiivTotalTradeAmount),
    outstandingBalance: money(profile.tradeBalanceTotal || profile.activityLastKnownBalanceTotal || ranking?.factiivOutstandingBalance),
    matchedBusiness: clean(profile.matchedBusinessName || ranking?.factiivMatchedBusiness),
    matchedEmail: clean(profile.matchedEmail || ranking?.factiivMatchedEmail),
    confidence: clean(profile.factiivMatchConfidence),
    matchReason: clean(profile.factiivMatchReason),
  };
}

function subscriptionSummary(subscriptions: Partial<WooCommerceSubscriptionDocument>[] = [], customer: Partial<CustomerDocument>) {
  const active = subscriptions.filter((sub) => clean(sub.status).toLowerCase() === "active");
  const mrr = active.reduce((sum, sub) => sum + money(sub.recurringTotal || sub.amount), 0) + (customer.isGatewayRecurring ? money(customer.recurringAmount) : 0);
  const nextPayment = active.map((sub) => clean(sub.nextPaymentDate)).filter(Boolean).sort()[0] || clean(customer.recurringNextEstimatedPayment);
  const lastPayment = subscriptions.map((sub) => clean(sub.lastPaymentDate)).filter(Boolean).sort().reverse()[0] || clean(customer.recurringLastPayment || customer.lastPaidDate);
  const start = subscriptions.map((sub) => clean(sub.startDate)).filter(Boolean).sort()[0] || clean(customer.subscriptionStartDate || customer.firstSignupDate || customer.firstOrderDate);
  return {
    activeSubscription: active.length > 0 || Boolean(customer.isGatewayRecurring),
    activeSubscriptionCount: active.length + (customer.isGatewayRecurring ? 1 : 0),
    mrr,
    nextPayment,
    lastPayment,
    subscriptionAge: monthsSince(start),
    start,
  };
}

export function verifyCustomer(input: VerificationInput): VerificationResult {
  const { customer, ranking } = input;
  const set: Record<string, unknown> = {};
  const rankingSet: Record<string, unknown> = {};
  const changedFields: string[] = [];
  const email = normalizeEmail(customer.normalizedEmail || customer.email || ranking?.email);
  const contact = extractBestBusinessContactFields(customer, ranking as CustomerRankingDocument | undefined, input.wooOrders as WooCommerceOrderDocument[] | undefined);
  const revenueMetrics = calculateCustomerValueMetrics({
    customer,
    wooOrders: input.wooOrders,
    authorizeNetTransactions: input.authorizeNetTransactions,
    nmiTransactions: input.nmiTransactions,
    stripeTransactions: input.stripeTransactions,
    subscriptions: input.subscriptions,
  });
  const factiiv = factiivValues(customer, ranking);
  const subscription = subscriptionSummary(input.subscriptions, customer);
  const storedRevenue = money(customer.rankingPaidTotal || customer.lifetimeValue || customer.paidTotal || customer.totalPaid || ranking?.lifetimeSpent);
  const revenueMismatch = Math.abs(storedRevenue - revenueMetrics.rankingTotal) > 1;
  const duplicateSuspect = Number(input.duplicateEmailCount ?? 0) > 1;

  setIfBetter(set, changedFields, customer, "businessProfile.businessName", contact.businessName);
  setIfBetter(set, changedFields, customer, "businessProfile.businessNameSource", contact.businessNameSource);
  setIfBetter(set, changedFields, customer, "businessProfile.address1", contact.address1);
  setIfBetter(set, changedFields, customer, "businessProfile.address2", contact.address2);
  setIfBetter(set, changedFields, customer, "businessProfile.city", contact.city);
  setIfBetter(set, changedFields, customer, "businessProfile.state", contact.state);
  setIfBetter(set, changedFields, customer, "businessProfile.stateCode", contact.state);
  setIfBetter(set, changedFields, customer, "businessProfile.zip", contact.zip);
  setIfBetter(set, changedFields, customer, "businessProfile.country", contact.country);
  setIfBetter(set, changedFields, customer, "businessProfile.phone", contact.phoneNumber);
  setIfBetter(set, changedFields, customer, "businessProfile.email", contact.email || email);
  setIfBetter(set, changedFields, customer, "businessProfile.ein", contact.ein);

  setIfBetter(set, changedFields, customer, "subscriptionStatus", subscription.activeSubscription ? "active" : "");
  setNumberIfChanged(set, changedFields, customer, "activeSubscriptions", subscription.activeSubscriptionCount);
  setNumberIfChanged(set, changedFields, customer, "recurringAmount", subscription.mrr);
  setIfBetter(set, changedFields, customer, "recurringNextEstimatedPayment", subscription.nextPayment);
  setIfBetter(set, changedFields, customer, "recurringLastPayment", subscription.lastPayment);
  setIfBetter(set, changedFields, customer, "subscriptionStartDate", subscription.start);
  setNumberIfChanged(set, changedFields, customer, "stayWithUsMonths", subscription.subscriptionAge);

  setNumberIfChanged(set, changedFields, customer, "wooPaidTotal", revenueMetrics.wooPaidTotal);
  setNumberIfChanged(set, changedFields, customer, "authorizeNetPaidTotal", revenueMetrics.authorizeNetPaidTotal);
  setNumberIfChanged(set, changedFields, customer, "nmiQuickPayPaidTotal", revenueMetrics.nmiQuickPayPaidTotal);
  setNumberIfChanged(set, changedFields, customer, "stripePaidTotal", revenueMetrics.stripePaidTotal);
  setNumberIfChanged(set, changedFields, customer, "gatewayOnlyPaidTotal", revenueMetrics.gatewayOnlyPaidTotal);
  setNumberIfChanged(set, changedFields, customer, "attemptedTotal", revenueMetrics.attemptedTotal);
  setIfBetter(set, changedFields, customer, "firstPaidDate", revenueMetrics.firstPaidDate);
  setIfBetter(set, changedFields, customer, "lastPaidDate", revenueMetrics.lastPaidDate);
  if (revenueMismatch) {
    setNumberIfChanged(set, changedFields, customer, "paidTotal", revenueMetrics.rankingTotal);
    setNumberIfChanged(set, changedFields, customer, "totalPaid", revenueMetrics.rankingTotal);
    setNumberIfChanged(set, changedFields, customer, "lifetimeValue", revenueMetrics.rankingTotal);
    setNumberIfChanged(set, changedFields, customer, "rankingPaidTotal", revenueMetrics.rankingTotal);
  }

  const now = new Date().toISOString();
  set["sourceCoverage.lastCustomerVerificationAt"] = now;
  set["sourceCoverage.customerVerificationSources"] = {
    contact: contact.fieldSources,
    revenue: "stored WooCommerce/Authorize.net/NMI/Stripe/subscription records",
    subscription: "stored WooCommerce subscriptions and gateway recurring fields",
    factiiv: factiiv.profileId ? "stored customer.factiivProfile or ranking cache" : "",
  };
  set["sourceCoverage.customerVerificationChangedFields"] = changedFields;

  if (contact.businessName) rankingSet.businessName = contact.businessName;
  if (contact.businessNameSource) rankingSet.businessNameSource = contact.businessNameSource;
  if (contact.businessAddress) rankingSet.businessAddress = contact.businessAddress;
  if (contact.address1) rankingSet.address1 = contact.address1;
  if (contact.address2) rankingSet.address2 = contact.address2;
  if (contact.city) rankingSet.city = contact.city;
  if (contact.state) rankingSet.stateCode = contact.state;
  if (contact.zip) rankingSet.zip = contact.zip;
  if (contact.country) rankingSet.country = contact.country;
  if (contact.ein) rankingSet.ein = contact.ein;
  if (contact.phoneNumber) rankingSet.phone = contact.phoneNumber;
  rankingSet.contactFieldSources = contact.fieldSources;
  rankingSet.lifetimeSpent = revenueMetrics.rankingTotal;
  rankingSet.latestPaidDate = revenueMetrics.lastPaidDate || ranking?.latestPaidDate || "";
  rankingSet.paidMonths = revenueMetrics.paidMonths;
  rankingSet.activeSubscriptionCount = subscription.activeSubscriptionCount;
  rankingSet.estimatedMRR = subscription.mrr;
  if (factiiv.profileId) rankingSet.factiivProfileId = factiiv.profileId;
  if (factiiv.score) rankingSet.factiivScore = factiiv.score;
  if (factiiv.tradeLines) rankingSet.factiivTradeLines = factiiv.tradeLines;
  if (factiiv.totalTradeAmount) rankingSet.factiivTotalTradeAmount = factiiv.totalTradeAmount;
  if (factiiv.outstandingBalance) rankingSet.factiivOutstandingBalance = factiiv.outstandingBalance;
  if (factiiv.matchedBusiness) rankingSet.factiivMatchedBusiness = factiiv.matchedBusiness;
  if (factiiv.matchedEmail) rankingSet.factiivMatchedEmail = factiiv.matchedEmail;
  rankingSet.lastVerifiedAt = now;

  const missingFields = [
    !hasValue(customer.name) ? "customerName" : "",
    !email ? "email" : "",
    !hasValue(contact.phoneNumber || customer.phone || customer.businessProfile?.phone) ? "phone" : "",
    !hasValue(contact.businessName || customer.businessProfile?.businessName || customer.businessProfile?.company || ranking?.businessName) ? "businessName" : "",
    !hasValue(contact.ein || customer.businessProfile?.ein || customer.creditProfile?.ein || ranking?.ein) ? "ein" : "",
    !hasValue(contact.address1 || customer.businessProfile?.address1 || ranking?.address1) ? "address" : "",
    !hasValue(contact.city || customer.businessProfile?.city || ranking?.city) ? "city" : "",
    !hasValue(contact.state || customer.businessProfile?.stateCode || customer.businessProfile?.state || ranking?.stateCode) ? "state" : "",
    !hasValue(contact.zip || customer.businessProfile?.zip || ranking?.zip) ? "zip" : "",
    !hasValue(contact.country || customer.businessProfile?.country || ranking?.country) ? "country" : "",
    !fundingScore(customer, ranking) ? "fundingScore" : "",
    !factiiv.score ? "factiivScore" : "",
  ].filter(Boolean);

  const reviewReasons = [
    duplicateSuspect ? "Duplicate email/customer candidate" : "",
    revenueMismatch ? `Stored revenue ${storedRevenue} differs from recalculated ${revenueMetrics.rankingTotal}` : "",
    revenueMetrics.refundsAndChargebacksDetected ? "Refunds or chargebacks detected" : "",
    !email ? "Missing email" : "",
    !hasValue(contact.businessName || customer.businessProfile?.businessName || customer.businessProfile?.company || ranking?.businessName) ? "Missing business name" : "",
    !hasValue(contact.state || customer.businessProfile?.stateCode || customer.businessProfile?.state || ranking?.stateCode) ? "Missing state" : "",
  ].filter(Boolean);

  let score = 0;
  score += email ? 5 : 0;
  score += hasValue(customer.name) ? 4 : 0;
  score += hasValue(contact.phoneNumber || customer.phone || customer.businessProfile?.phone) ? 4 : 0;
  score += hasValue(contact.businessName || customer.businessProfile?.businessName || customer.businessProfile?.company || ranking?.businessName) ? 5 : 0;
  score += hasValue(contact.ein || customer.businessProfile?.ein || customer.creditProfile?.ein || ranking?.ein) ? 2 : 0;
  score += hasValue(contact.address1 || customer.businessProfile?.address1 || ranking?.address1) ? 5 : 0;
  score += hasValue(contact.city || customer.businessProfile?.city || ranking?.city) ? 4 : 0;
  score += hasValue(contact.state || customer.businessProfile?.stateCode || customer.businessProfile?.state || ranking?.stateCode) ? 5 : 0;
  score += hasValue(contact.zip || customer.businessProfile?.zip || ranking?.zip) ? 4 : 0;
  score += hasValue(contact.country || customer.businessProfile?.country || ranking?.country) ? 2 : 0;
  score += !revenueMismatch && revenueMetrics.rankingTotal >= 0 ? 20 : 8;
  score += subscription.activeSubscription || fundingScore(customer, ranking) ? 15 : 5;
  score += factiiv.profileId ? 5 : 0;
  score += factiiv.score ? 10 : 0;
  score += duplicateSuspect ? 0 : 10;
  const verificationScore = Math.max(0, Math.min(100, Math.round(score)));

  const criticalMissing = !email || !hasValue(contact.businessName || customer.businessProfile?.businessName || customer.businessProfile?.company || ranking?.businessName) || !hasValue(contact.state || customer.businessProfile?.stateCode || customer.businessProfile?.state || ranking?.stateCode);
  const verificationStatus: VerificationStatus = criticalMissing
    ? "Missing Critical Data"
    : reviewReasons.length || verificationScore < 70
      ? "Needs Review"
      : verificationScore >= 90
        ? "Verified"
        : "Partially Verified";

  return {
    customerId: String(customer._id ?? ranking?.customerId ?? ""),
    email,
    verificationStatus,
    verificationScore,
    missingFields,
    reviewReasons,
    sourceConfidence: verificationScore >= 90 ? "high" : verificationScore >= 70 ? "medium" : "low",
    revenueMetrics,
    revenueMismatch,
    subscriptionVerified: subscription.activeSubscription || Boolean(customer.subscriptionStatus),
    factiivScorePresent: factiiv.score > 0,
    fundingScorePresent: fundingScore(customer, ranking) > 0,
    contactMissing: missingFields.some((field) => ["businessName", "address", "city", "state", "zip", "phone"].includes(field)),
    duplicateSuspect,
    set,
    rankingSet,
    changedFields,
  };
}

export function verificationStatusParam(status: string) {
  if (status === "verified") return "Verified";
  if (status === "partial") return "Partially Verified";
  if (status === "needs_review") return "Needs Review";
  if (status === "missing_critical") return "Missing Critical Data";
  return "";
}

export function compactVerificationStatus(status: VerificationStatus) {
  if (status === "Verified") return "verified";
  if (status === "Partially Verified") return "partial";
  if (status === "Needs Review") return "needs_review";
  return "missing_critical";
}

export { clean as cleanVerificationValue, dateOnly as verificationDate };

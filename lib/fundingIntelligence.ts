import type { CustomerBusinessProfile, CustomerDocument, CustomerFactiivProfile, CustomerPublicEnrichment } from "@/models/Customer";
import type { CustomerRankingDocument } from "@/models/CustomerRanking";

export type FundingSegment =
  | "funding_ready"
  | "high_revenue_active"
  | "high_revenue_inactive"
  | "subscription_heavy"
  | "gateway_heavy"
  | "high_retry_risk"
  | "tradeline_verified"
  | "factiv_matched"
  | "high_payment_consistency";

type LeanCustomer = Partial<CustomerDocument> & { _id?: unknown };

export type FundingIntelligenceSummary = {
  factiivScore: number;
  fundingTier: string;
  vipTier: string;
  tradeLines: number;
  totalTradeAmount: number;
  outstandingBalance: number;
  paymentActivity: string;
  risk: string;
  verifiedCreditLimit: number;
  aiFundingInsight: string;
  paymentStabilityScore: number;
  monthlyPaymentConsistency: number;
  estimatedFundingReadiness: number;
  recurringRevenueTrend: string;
  chargebackRisk: string;
  failedPaymentTrend: string;
  activeSubscriptionCount: number;
  segments: FundingSegment[];
};

function money(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function hasVerifiedCredit(customer: LeanCustomer) {
  return Boolean(customer.creditProfile?.verified || customer.businessProfile?.creditMetaVerified);
}

function verifiedCreditValue(customer: LeanCustomer) {
  if (!hasVerifiedCredit(customer)) return 0;
  return Math.max(
    money(customer.creditProfile?.approvedCredits),
    money(customer.businessProfile?.approvedCredits),
    money(customer.actualCreditLimit)
  );
}

function profileCompleteness(profile: Partial<CustomerBusinessProfile>, enrichment: Partial<CustomerPublicEnrichment>) {
  const fields = [
    profile.company,
    profile.phone,
    profile.address1,
    profile.city,
    profile.state,
    profile.zip,
    profile.ein,
    profile.website || enrichment.publicBusinessWebsite,
    profile.naicsCode || enrichment.naicsCode,
    profile.sicCode || enrichment.sicCode,
  ];
  return Math.round((fields.filter(Boolean).length / fields.length) * 100);
}

export function computeFundingTier(score: number, lifetime: number) {
  if (score >= 85 && lifetime >= 10000) return "Funding VIP Elite";
  if (score >= 75 && lifetime >= 5000) return "Funding VIP";
  if (score >= 65) return "Funding Ready";
  if (score >= 50) return "Needs Enrichment";
  return "Not Ready";
}

export function computeVipTier(lifetime: number) {
  if (lifetime >= 10000) return "VIP Elite";
  if (lifetime >= 5000) return "VIP";
  if (lifetime >= 2000) return "High Value";
  return "Standard";
}

export function computePaymentStabilityScore(customer: LeanCustomer) {
  const paidMonths = money(customer.paidMonths ?? customer.paidOrderCount);
  const failed = money(customer.failedPayments);
  const chargebacks = money(customer.chargebacks);
  const recurring = money(customer.activeSubscriptions) + (customer.isGatewayRecurring ? 1 : 0);
  let score = 35;
  score += Math.min(30, paidMonths * 3);
  score += Math.min(20, recurring * 4);
  score -= Math.min(15, failed * 3);
  score -= Math.min(25, chargebacks * 10);
  return Math.max(0, Math.min(100, Math.round(score)));
}

export function computeFundingIntelligence(customer: LeanCustomer, ranking?: CustomerRankingDocument | null): FundingIntelligenceSummary {
  const factiv = (customer.factiivProfile ?? {}) as Partial<CustomerFactiivProfile>;
  const enrichment: Partial<CustomerPublicEnrichment> = customer.publicEnrichment ?? {};
  const profile: Partial<CustomerBusinessProfile> = customer.businessProfile ?? {};
  const lifetime = money(ranking?.lifetimeSpent ?? customer.lifetimeValue ?? customer.rankingPaidTotal ?? customer.paidTotal ?? customer.totalPaid);
  const attempted = money(ranking?.attemptedPipeline ?? customer.attemptedTotal);
  const activeSubscriptionCount = money(ranking?.activeSubscriptionCount ?? customer.activeSubscriptions) + (customer.isGatewayRecurring ? 1 : 0);
  const estimatedMRR = money(ranking?.estimatedMRR ?? customer.recurringAmount);
  const paymentStabilityScore = computePaymentStabilityScore(customer);
  const monthlyPaymentConsistency = Math.round((paymentStabilityScore + Math.min(100, money(customer.paidMonths ?? customer.paidOrderCount) * 6)) / 2);
  const verifiedCreditLimit = verifiedCreditValue(customer);
  const completeness = profileCompleteness(profile, enrichment);
  const factiivScore = money(factiv.factiivScore);
  let estimatedFundingReadiness = 0;
  estimatedFundingReadiness += Math.min(30, lifetime / 250);
  estimatedFundingReadiness += Math.min(18, monthlyPaymentConsistency * 0.18);
  estimatedFundingReadiness += Math.min(16, verifiedCreditLimit / 1000);
  estimatedFundingReadiness += Math.min(14, factiivScore * 0.14);
  estimatedFundingReadiness += Math.min(12, completeness * 0.12);
  estimatedFundingReadiness += activeSubscriptionCount > 0 ? 8 : 0;
  estimatedFundingReadiness -= money(customer.chargebacks) > 0 ? 18 : 0;
  estimatedFundingReadiness -= money(customer.failedPayments) > 2 ? 10 : 0;
  const roundedReadiness = Math.max(0, Math.min(100, Math.round(estimatedFundingReadiness)));
  const fundingTier = computeFundingTier(Math.max(roundedReadiness, factiivScore || 0), lifetime);
  const vipTier = computeVipTier(lifetime);
  const outstandingBalance = Math.max(
    money(customer.creditProfile?.outstandingBalance),
    money(profile.outstandingBalance),
    money(factiv.tradeBalanceTotal),
    money(factiv.activityLastKnownBalanceTotal)
  );
  const paymentActivity = lifetime > 0
    ? `${money(customer.paidOrderCount)} paid orders, ${money(customer.attemptedOrderCount)} attempted`
    : `${money(customer.attemptedOrderCount)} attempted orders`;
  const recurringRevenueTrend = activeSubscriptionCount > 0 && estimatedMRR > 0 ? "stable_recurring" : estimatedMRR > 0 ? "emerging_recurring" : "non_recurring";
  const chargebackRisk = money(customer.chargebacks) > 0 ? "high" : money(customer.failedPayments) > 1 ? "medium" : "low";
  const failedPaymentTrend = money(customer.failedPayments) > 3 ? "rising" : money(customer.failedPayments) > 0 ? "watch" : "stable";

  const segments: FundingSegment[] = [];
  if (roundedReadiness >= 65 || factiivScore >= 65) segments.push("funding_ready");
  if (lifetime >= 2000 && activeSubscriptionCount > 0) segments.push("high_revenue_active");
  if (lifetime >= 2000 && activeSubscriptionCount === 0) segments.push("high_revenue_inactive");
  if (activeSubscriptionCount > 1 || estimatedMRR >= 200) segments.push("subscription_heavy");
  if (money(customer.gatewayPaidCount) > money(customer.paidOrderCount) || customer.isGatewayRecurring) segments.push("gateway_heavy");
  if (money(customer.failedPayments) >= 3 || attempted >= 500) segments.push("high_retry_risk");
  if (hasVerifiedCredit(customer)) segments.push("tradeline_verified");
  if (Boolean(factiv.factiivMatched)) segments.push("factiv_matched");
  if (monthlyPaymentConsistency >= 75) segments.push("high_payment_consistency");

  const aiFundingInsight = roundedReadiness >= 75 || factiivScore >= 75
    ? `${customer.name ?? "Customer"} shows strong funding signals from paid history, verified credit data, and tradeline activity.`
    : roundedReadiness >= 55
      ? `${customer.name ?? "Customer"} has usable revenue and profile data, but underwriting would benefit from stronger tradeline or recurring-payment verification.`
      : `${customer.name ?? "Customer"} is not funding-ready yet; complete enrichment and verify more payment history before outreach.`;

  return {
    factiivScore,
    fundingTier,
    vipTier,
    tradeLines: money(factiv.tradeQuantity),
    totalTradeAmount: money(factiv.tradeAmountTotal),
    outstandingBalance,
    paymentActivity,
    risk: customer.riskLevel || "unknown",
    verifiedCreditLimit,
    aiFundingInsight,
    paymentStabilityScore,
    monthlyPaymentConsistency,
    estimatedFundingReadiness: roundedReadiness,
    recurringRevenueTrend,
    chargebackRisk,
    failedPaymentTrend,
    activeSubscriptionCount,
    segments: Array.from(new Set(segments)),
  };
}

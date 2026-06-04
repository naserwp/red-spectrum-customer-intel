import type { CustomerBusinessProfile, CustomerDocument, CustomerFactiivProfile, CustomerPublicEnrichment } from "@/models/Customer";
import type { CustomerRankingDocument } from "@/models/CustomerRanking";
import { monthsSince } from "@/lib/customerValue";

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
  fundingScore: number;
  fundingCategory: string;
  recommendedFundingProducts: string[];
  fundingStrengths: string[];
  fundingWeaknesses: string[];
  nextBestAction: string;
  fundingSummary: string;
  businessVerificationScore: number;
  industryRiskScore: number;
  scoreBreakdown: {
    businessAgeScore: number;
    revenueScore: number;
    tradelineScore: number;
    paymentHistoryScore: number;
    subscriptionStabilityScore: number;
    businessVerificationScore: number;
    industryRiskScore: number;
  };
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

function fundingCategory(score: number) {
  if (score >= 80) return "Ready Now";
  if (score >= 65) return "Ready in 30 Days";
  if (score >= 45) return "Ready in 90 Days";
  return "Needs More Credit Building";
}

function industryRiskScore(profile: Partial<CustomerBusinessProfile>, enrichment: Partial<CustomerPublicEnrichment>) {
  const industry = `${profile.industry ?? ""} ${profile.industryClassification ?? ""} ${profile.businessType ?? ""} ${enrichment.inferredIndustry ?? ""}`.toLowerCase();
  if (/gambl|adult|crypto|cannabis|marijuana/.test(industry)) return 1;
  if (/transport|truck|construction|restaurant|retail/.test(industry)) return 3;
  if (/professional|consult|medical|health|software|technology|service/.test(industry)) return 5;
  return 4;
}

function recommendedProducts(score: number, lifetime: number, activeSubscriptionCount: number, paymentStabilityScore: number, factiivScore: number, completeness: number) {
  if (score < 45) return ["Needs Credit Building"];
  const products: string[] = [];
  if (lifetime >= 2500 && paymentStabilityScore >= 60 && completeness >= 50) products.push("Equipment Financing");
  if (lifetime >= 5000 && paymentStabilityScore >= 45) products.push("MCA");
  if (completeness >= 60 && paymentStabilityScore >= 65 && lifetime >= 1000) products.push("Business Credit Card");
  if (lifetime >= 5000 && activeSubscriptionCount > 0 && factiivScore >= 50) products.push("Credit Line");
  return products.length ? products : ["Needs Credit Building"];
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
  const firstActivity = customer.firstPaidDate || customer.firstOrderDate || customer.customerCreatedAt || customer.lastSyncedAt || "";
  const businessAgeMonths = monthsSince(firstActivity);
  const businessAgeScore = Math.min(15, Math.round(businessAgeMonths / 4));
  const revenueScore = Math.min(20, Math.round(lifetime / 500));
  const tradelineScore = Math.min(20, Math.round(Math.max(factiivScore * 0.2, money(factiv.tradeQuantity) * 4, verifiedCreditLimit / 1000)));
  const paymentHistoryScore = Math.min(15, Math.round(paymentStabilityScore * 0.15));
  const subscriptionStabilityScore = Math.min(15, activeSubscriptionCount > 0 ? 8 + Math.min(7, Math.round(estimatedMRR / 150)) : 0);
  const businessVerificationScore = Math.min(10, Math.round(completeness * 0.1));
  const riskScore = industryRiskScore(profile, enrichment);
  const fundingScore = Math.max(0, Math.min(100, businessAgeScore + revenueScore + tradelineScore + paymentHistoryScore + subscriptionStabilityScore + businessVerificationScore + riskScore));
  const category = fundingCategory(fundingScore);
  const recommendedFundingProducts = recommendedProducts(fundingScore, lifetime, activeSubscriptionCount, paymentStabilityScore, factiivScore, completeness);
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
  const fundingStrengths = [
    lifetime >= 5000 ? "Strong customer revenue history" : "",
    activeSubscriptionCount > 0 ? "Recurring payment stability" : "",
    paymentStabilityScore >= 70 ? "Clean payment behavior" : "",
    factiivScore >= 60 || money(factiv.tradeQuantity) > 0 ? "Tradeline or Factiiv signal present" : "",
    completeness >= 70 ? "Business profile is substantially verified" : "",
  ].filter(Boolean);
  const fundingWeaknesses = [
    lifetime < 1000 ? "Revenue history is still limited" : "",
    activeSubscriptionCount === 0 ? "No active recurring revenue signal" : "",
    paymentStabilityScore < 55 ? "Payment history needs review" : "",
    factiivScore <= 0 && money(factiv.tradeQuantity) <= 0 ? "No tradeline signal found" : "",
    completeness < 60 ? "Business verification fields are incomplete" : "",
  ].filter(Boolean);
  const nextBestAction = category === "Ready Now"
    ? "Prioritize funding outreach and verify preferred product fit."
    : category === "Ready in 30 Days"
      ? "Complete missing verification fields and prepare funding outreach."
      : category === "Ready in 90 Days"
        ? "Build payment consistency and enrich business profile before outreach."
        : "Focus on credit building, profile completion, and additional successful payments.";
  const fundingSummary = `${customer.name ?? "This customer"} has spent $${lifetime.toFixed(2)}, has ${money(customer.paidOrderCount)} successful payments, is active since ${firstActivity ? firstActivity.slice(0, 10) : "unknown"}, and is ${category.toLowerCase()}. Suggested products: ${recommendedFundingProducts.join(", ")}.`;

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
    fundingScore,
    fundingCategory: category,
    recommendedFundingProducts,
    fundingStrengths,
    fundingWeaknesses,
    nextBestAction,
    fundingSummary,
    businessVerificationScore,
    industryRiskScore: riskScore,
    scoreBreakdown: {
      businessAgeScore,
      revenueScore,
      tradelineScore,
      paymentHistoryScore,
      subscriptionStabilityScore,
      businessVerificationScore,
      industryRiskScore: riskScore,
    },
  };
}

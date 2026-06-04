import { NextResponse } from "next/server";
import { connectToDatabase } from "@/lib/mongodb";
import { computeFundingIntelligence } from "@/lib/fundingIntelligence";
import { resolveFactiivScore } from "@/lib/factivScore";
import { Customer, type CustomerDocument, type CustomerFactiivProfile } from "@/models/Customer";
import { CustomerRanking, type CustomerRankingDocument } from "@/models/CustomerRanking";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  await connectToDatabase();
  const body = await request.json().catch(() => ({})) as {
    customerId?: string;
    profileId?: string;
    selectedProfileData?: Partial<CustomerFactiivProfile>;
  };

  if (!body.customerId || !body.profileId || !body.selectedProfileData) {
    return NextResponse.json({ error: "customerId, profileId, and selectedProfileData are required." }, { status: 400 });
  }

  const customer = await Customer.findById(body.customerId, {
    name: 1,
    email: 1,
    normalizedEmail: 1,
    phone: 1,
    paidTotal: 1,
    totalPaid: 1,
    lifetimeValue: 1,
    rankingPaidTotal: 1,
    attemptedTotal: 1,
    paidMonths: 1,
    paidOrderCount: 1,
    attemptedOrderCount: 1,
    activeSubscriptions: 1,
    isGatewayRecurring: 1,
    recurringAmount: 1,
    gatewayPaidCount: 1,
    failedPayments: 1,
    chargebacks: 1,
    riskLevel: 1,
    businessProfile: 1,
    creditProfile: 1,
    factiivProfile: 1,
    publicEnrichment: 1,
    sourceCoverage: 1,
  }).lean<Partial<CustomerDocument> & { _id: unknown } | null>();

  if (!customer) {
    return NextResponse.json({ error: "Customer not found." }, { status: 404 });
  }

  const now = new Date().toISOString();
  const selectedScore = resolveFactiivScore(body.selectedProfileData);
  const profile: CustomerFactiivProfile = {
    factiivProfileId: String(body.profileId),
    score: Number(body.selectedProfileData.score ?? 0),
    businessScore: Number(body.selectedProfileData.businessScore ?? 0),
    creditScore: Number(body.selectedProfileData.creditScore ?? 0),
    report: body.selectedProfileData.report ?? {},
    analytics: body.selectedProfileData.analytics ?? {},
    funding: body.selectedProfileData.funding ?? {},
    factiivScore: Number(selectedScore.scoreValue ?? body.selectedProfileData.factiivScore ?? 0),
    reputationScore: Number(body.selectedProfileData.reputationScore ?? 0),
    historyScore: Number(body.selectedProfileData.historyScore ?? 0),
    utilizationScore: Number(body.selectedProfileData.utilizationScore ?? 0),
    tradeQuantity: Number(body.selectedProfileData.tradeQuantity ?? 0),
    tradeAmountTotal: Number(body.selectedProfileData.tradeAmountTotal ?? 0),
    tradeBalanceTotal: Number(body.selectedProfileData.tradeBalanceTotal ?? 0),
    activityQuantity: Number(body.selectedProfileData.activityQuantity ?? 0),
    activityPaymentAmountTotal: Number(body.selectedProfileData.activityPaymentAmountTotal ?? 0),
    activityLastKnownBalanceTotal: Number(body.selectedProfileData.activityLastKnownBalanceTotal ?? 0),
    matchedBusinessName: String(body.selectedProfileData.matchedBusinessName ?? ""),
    matchedEmail: String(body.selectedProfileData.matchedEmail ?? ""),
    matchedUsername: String(body.selectedProfileData.matchedUsername ?? ""),
    factiivMatched: true,
    factiivMatchConfidence: "manual",
    matchedBy: "manual_admin",
    autoPersisted: false,
    autoPersistReason: "",
    factiivSearchQuery: String(body.selectedProfileData.factiivSearchQuery ?? ""),
    factiivMatchReason: String(body.selectedProfileData.factiivMatchReason ?? "manual_admin"),
    lastFactiivSync: now,
    manualAttachedBy: "admin",
    manualAttachedAt: now,
    trades: Array.isArray(body.selectedProfileData.trades) ? body.selectedProfileData.trades.map((trade) => ({
      tradeId: String(trade?.tradeId ?? ""),
      tradeName: String(trade?.tradeName ?? ""),
      tradeType: String(trade?.tradeType ?? ""),
      relation: String(trade?.relation ?? ""),
      amount: Number(trade?.amount ?? 0),
      balance: Number(trade?.balance ?? 0),
      tradeStatus: String(trade?.tradeStatus ?? ""),
      adminStatus: String(trade?.adminStatus ?? ""),
      fromCompanyName: String(trade?.fromCompanyName ?? ""),
      toCompanyName: String(trade?.toCompanyName ?? ""),
      lastActivity: String(trade?.lastActivity ?? ""),
      utilizationPercent: Number(trade?.utilizationPercent ?? 0),
    })) : [],
    activities: Array.isArray(body.selectedProfileData.activities) ? body.selectedProfileData.activities.map((activity) => ({
      activityDate: String(activity?.activityDate ?? ""),
      activityType: String(activity?.activityType ?? ""),
      paymentAmount: Number(activity?.paymentAmount ?? 0),
      chargeAmount: Number(activity?.chargeAmount ?? 0),
      interest: Number(activity?.interest ?? 0),
      daysLate: Number(activity?.daysLate ?? 0),
      paymentStatus: String(activity?.paymentStatus ?? ""),
    })) : [],
    source: String(body.selectedProfileData.source ?? "factiv_public_accounts"),
    rawSummary: String(body.selectedProfileData.rawSummary ?? ""),
  };

  const ranking = customer.email
    ? await CustomerRanking.findOne({ email: customer.email.toLowerCase() }).lean<CustomerRankingDocument | null>()
    : null;
  const funding = computeFundingIntelligence({ ...customer, factiivProfile: profile }, ranking);

  await Customer.updateOne(
    { _id: customer._id },
    {
      $set: {
        factiivProfile: profile,
        "businessProfile.fundingReadinessScore": funding.estimatedFundingReadiness,
        "businessProfile.fundingReadinessTier": funding.fundingTier,
        "businessProfile.fundingScore": funding.fundingScore,
        "businessProfile.fundingCategory": funding.fundingCategory,
        "businessProfile.recommendedFundingProducts": funding.recommendedFundingProducts,
        "businessProfile.fundingStrengths": funding.fundingStrengths,
        "businessProfile.fundingWeaknesses": funding.fundingWeaknesses,
        "businessProfile.nextBestAction": funding.nextBestAction,
        "businessProfile.fundingSummary": funding.fundingSummary,
        "businessProfile.businessVerificationScore": funding.businessVerificationScore,
        "businessProfile.industryRiskScore": funding.industryRiskScore,
        "businessProfile.fundingScoreBreakdown": funding.scoreBreakdown,
        "sourceCoverage.factiivSearchQuery": profile.factiivSearchQuery,
        "sourceCoverage.factiivMatchReason": profile.factiivMatchReason,
        "sourceCoverage.lastFactiivSearchQueries": [profile.factiivSearchQuery].filter(Boolean),
        "sourceCoverage.lastFactiivSearchResultsCount": 1,
        "sourceCoverage.lastFactiivMatchReason": profile.factiivMatchReason,
        "sourceCoverage.manualAttachedBy": profile.manualAttachedBy,
        "sourceCoverage.manualAttachedAt": profile.manualAttachedAt,
      },
    }
  ).exec();

  return NextResponse.json({
    ok: true,
    customerId: String(customer._id),
    factiivProfile: profile,
    fundingIntelligence: {
      fundingReadinessScore: funding.estimatedFundingReadiness,
      fundingReadinessTier: funding.fundingTier,
      fundingScore: funding.fundingScore,
      fundingCategory: funding.fundingCategory,
      recommendedFundingProducts: funding.recommendedFundingProducts,
      scoreBreakdown: funding.scoreBreakdown,
    },
    updatedAt: now,
  });
}

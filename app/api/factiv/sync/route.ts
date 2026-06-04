import { NextResponse } from "next/server";
import { syncFactiivProfile, shouldAutoPersistFactiiv } from "@/lib/factiv";
import { connectToDatabase } from "@/lib/mongodb";
import { computeFundingIntelligence } from "@/lib/fundingIntelligence";
import { Customer, type CustomerDocument } from "@/models/Customer";
import { CustomerRanking, type CustomerRankingDocument } from "@/models/CustomerRanking";

type LeanCustomer = Partial<CustomerDocument> & { _id: unknown };

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  await connectToDatabase();
  const body = await request.json().catch(() => ({})) as { limit?: number; offset?: number; dryRun?: boolean };
  const limit = Math.min(25, Math.max(1, Number(body.limit ?? 25)));
  const offset = Math.max(0, Number(body.offset ?? 0));
  const dryRun = Boolean(body.dryRun);

  const customers = await Customer.find({}, {
    name: 1,
    email: 1,
    normalizedEmail: 1,
    phone: 1,
    paidTotal: 1,
    totalPaid: 1,
    paidOrderCount: 1,
    attemptedOrderCount: 1,
    activeSubscriptions: 1,
    isGatewayRecurring: 1,
    gatewayPaidCount: 1,
    failedPayments: 1,
    chargebacks: 1,
    businessProfile: 1,
    creditProfile: 1,
    factiivProfile: 1,
  }).sort({ "factiivProfile.lastFactiivSync": 1, updatedAt: -1 }).skip(offset).limit(limit).lean<LeanCustomer[]>();

  const warnings: string[] = [];
  let matched = 0;
  let updated = 0;

  for (const customer of customers) {
    const result = await syncFactiivProfile(customer);
    warnings.push(...result.warnings);
    const shouldPersist = result.profile.factiivMatched && shouldAutoPersistFactiiv(result.profile);
    if (shouldPersist) matched += 1;
    if (dryRun) continue;
    const ranking = customer.email
      ? await CustomerRanking.findOne({ email: customer.email.toLowerCase() }).lean<CustomerRankingDocument | null>()
      : null;
    const profile = shouldPersist
      ? {
        ...result.profile,
        matchedBy: "auto",
        autoPersisted: true,
        autoPersistReason: result.profile.factiivMatchReason || result.profile.factiivMatchConfidence,
      }
      : {
        ...result.profile,
        factiivMatched: false,
        matchedBy: "",
        autoPersisted: false,
        autoPersistReason: "",
      };
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
          "sourceCoverage.factiivSearchQuery": result.profile.factiivSearchQuery,
          "sourceCoverage.factiivMatchReason": result.profile.factiivMatchReason,
          "sourceCoverage.lastFactiivSearchQueries": [result.profile.factiivSearchQuery].filter(Boolean),
          "sourceCoverage.lastFactiivSearchResultsCount": result.profile.factiivProfileId ? 1 : 0,
          "sourceCoverage.lastFactiivMatchReason": result.profile.factiivMatchReason,
        },
      }
    ).exec();
    updated += 1;
  }

  return NextResponse.json({
    processed: customers.length,
    matched,
    updated,
    hasMore: customers.length === limit,
    nextOffset: offset + customers.length,
    warnings: warnings.filter(Boolean).slice(0, 20),
    message: dryRun
      ? `Factiiv test complete. ${matched} customers matched in this batch.`
      : `Factiiv sync updated ${updated} customers.`,
  });
}

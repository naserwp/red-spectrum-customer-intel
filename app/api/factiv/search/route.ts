import { NextResponse } from "next/server";
import { searchFactiivProfiles, shouldAutoPersistFactiiv } from "@/lib/factiv";
import { connectToDatabase } from "@/lib/mongodb";
import { Customer, type CustomerDocument } from "@/models/Customer";
import { computeFundingIntelligence } from "@/lib/fundingIntelligence";
import { CustomerRanking, type CustomerRankingDocument } from "@/models/CustomerRanking";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  await connectToDatabase();
  const body = await request.json().catch(() => ({})) as {
    customerId?: string;
    email?: string;
    businessName?: string;
    customerName?: string;
    ein?: string;
    customQuery?: string;
    mode?: "email" | "business" | "name" | "ein" | "custom";
  };

  const customer = body.customerId
    ? await Customer.findById(body.customerId, {
      name: 1,
      email: 1,
      normalizedEmail: 1,
      phone: 1,
      businessProfile: 1,
      creditProfile: 1,
      factiivProfile: 1,
    }).lean<Partial<CustomerDocument> | null>()
    : null;

  const mode = body.mode ?? "custom";
  const query = (
    mode === "email" ? body.email
      : mode === "business" ? body.businessName
        : mode === "name" ? body.customerName
          : mode === "ein" ? body.ein
            : body.customQuery
  )?.trim() ?? "";

  if (!query) {
    return NextResponse.json({ error: "Search query is required." }, { status: 400 });
  }

  const results = await searchFactiivProfiles(query, customer ?? undefined);
  let autoPersisted = false;
  let attachedProfile = null;
  let fundingIntelligence: Record<string, unknown> | null = null;
  let updatedAt = "";
  if (body.customerId && results[0] && shouldAutoPersistFactiiv(results[0].selectedProfileData)) {
    const profile = {
      ...results[0].selectedProfileData,
      matchedBy: "auto",
      autoPersisted: true,
      autoPersistReason: results[0].matchReason || results[0].matchConfidence,
      manualAttachedBy: "",
      manualAttachedAt: "",
    };
    updatedAt = new Date().toISOString();
    const ranking = customer?.email
      ? await CustomerRanking.findOne({ email: customer.email.toLowerCase() }).lean<CustomerRankingDocument | null>()
      : null;
    const funding = computeFundingIntelligence({ ...(customer ?? {}), factiivProfile: profile }, ranking);
    fundingIntelligence = {
      fundingReadinessScore: funding.estimatedFundingReadiness,
      fundingReadinessTier: funding.fundingTier,
      fundingScore: funding.fundingScore,
      fundingCategory: funding.fundingCategory,
      recommendedFundingProducts: funding.recommendedFundingProducts,
      scoreBreakdown: funding.scoreBreakdown,
    };
    await Customer.updateOne(
      { _id: body.customerId },
      {
        $set: {
          factiivProfile: profile,
          "businessProfile.fundingReadinessScore": fundingIntelligence.fundingReadinessScore,
          "businessProfile.fundingReadinessTier": fundingIntelligence.fundingReadinessTier,
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
          "sourceCoverage.lastFactiivSearchQueries": [query],
          "sourceCoverage.lastFactiivSearchResultsCount": results.length,
          "sourceCoverage.lastFactiivMatchReason": profile.factiivMatchReason,
        },
      }
    ).exec();
    autoPersisted = true;
    attachedProfile = profile;
  } else if (body.customerId) {
    await Customer.updateOne(
      { _id: body.customerId },
      {
        $set: {
          "sourceCoverage.lastFactiivSearchQueries": [query],
          "sourceCoverage.lastFactiivSearchResultsCount": results.length,
          "sourceCoverage.lastFactiivMatchReason": results[0]?.matchReason || "manual_search_no_match",
        },
      }
    ).exec();
  }
  return NextResponse.json({
    query,
    resultsCount: results.length,
    results,
    autoPersisted,
    attachedProfile,
    fundingIntelligence,
    updatedAt,
  });
}

import { NextResponse } from "next/server";
import { GET as getTop110Export } from "@/app/api/customers/export-top-110/route";
import { searchFactiivProfiles, shouldAutoPersistFactiiv, type FactiivSearchResult } from "@/lib/factiv";
import { resolveFactiivScore } from "@/lib/factivScore";
import { computeFundingIntelligence } from "@/lib/fundingIntelligence";
import { connectToDatabase } from "@/lib/mongodb";
import { Customer, type CustomerDocument, type CustomerFactiivProfile } from "@/models/Customer";
import { CustomerRanking, type CustomerRankingDocument } from "@/models/CustomerRanking";

export const dynamic = "force-dynamic";

type Top110ExportRow = {
  customerId: string;
  customerName: string;
  email: string;
  businessName: string;
  phoneNumber: string;
  ein: string;
  factiivScore: number | "Missing";
  factiivDebugReason?: string;
};

type Top110ExportResponse = {
  success: boolean;
  total: number;
  customers: Top110ExportRow[];
};

type AttachOutcome = {
  customerId: string;
  email: string;
  businessName: string;
  query: string;
  matchProfileId?: string;
  matchBusinessName?: string;
  matchEmail?: string;
  matchConfidence?: string;
  matchReason?: string;
  factiivScore?: number | "Missing";
  reason?: string;
};

function text(value: unknown) {
  return String(value ?? "").trim();
}

function missingText(value: unknown) {
  const raw = text(value);
  return raw && raw !== "Missing" ? raw : "";
}

function normalizeEmail(value: unknown) {
  return text(value).toLowerCase();
}

function unique(values: string[]) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

async function readTop110Export() {
  const response = await getTop110Export(new Request("http://localhost/api/customers/export-top-110?format=json&limit=110&useAIIndustry=false&debugFactiiv=true"));
  const data = await response.json() as Top110ExportResponse;
  if (!data.success || !Array.isArray(data.customers)) {
    throw new Error("Top 110 export did not return a valid customer list.");
  }
  return data;
}

function buildSearchQueries(row: Top110ExportRow, customer: Partial<CustomerDocument>) {
  return unique([
    missingText(row.email) || missingText(customer.email),
    missingText(row.businessName) || missingText(customer.businessProfile?.businessName) || missingText(customer.businessProfile?.company),
    missingText(row.customerName) || missingText(customer.name),
    missingText(row.ein) || missingText(customer.businessProfile?.ein) || missingText(customer.creditProfile?.ein),
    missingText(row.phoneNumber) || missingText(customer.phone) || missingText(customer.businessProfile?.phone) || missingText(customer.creditProfile?.phone),
  ]);
}

function searchCustomerShape(row: Top110ExportRow, customer: Partial<CustomerDocument>): Partial<CustomerDocument> {
  return {
    ...customer,
    name: customer.name || row.customerName,
    email: customer.email || row.email,
    normalizedEmail: customer.normalizedEmail || normalizeEmail(customer.email || row.email),
    phone: customer.phone || row.phoneNumber,
    businessProfile: {
      ...(customer.businessProfile ?? {}),
      company: customer.businessProfile?.company || row.businessName,
      businessName: customer.businessProfile?.businessName || row.businessName,
      ein: customer.businessProfile?.ein || row.ein,
      phone: customer.businessProfile?.phone || row.phoneNumber,
    },
  } as Partial<CustomerDocument>;
}

function buildAutoProfile(result: FactiivSearchResult) {
  const selectedScore = resolveFactiivScore(result.selectedProfileData);
  return {
    ...result.selectedProfileData,
    factiivProfileId: String(result.profileId),
    factiivScore: Number(selectedScore.scoreValue ?? result.selectedProfileData.factiivScore ?? 0),
    matchedBy: "auto",
    autoPersisted: true,
    autoPersistReason: result.matchReason || result.matchConfidence,
    manualAttachedBy: "",
    manualAttachedAt: "",
    lastFactiivSync: new Date().toISOString(),
  } satisfies CustomerFactiivProfile;
}

async function persistFactiivProfile(customer: Partial<CustomerDocument> & { _id: unknown }, profile: CustomerFactiivProfile) {
  const ranking = customer.email
    ? await CustomerRanking.findOne({ email: normalizeEmail(customer.email) }).lean<CustomerRankingDocument | null>()
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
      },
    }
  ).exec();

  if (ranking) {
    await CustomerRanking.updateOne(
      { _id: (ranking as CustomerRankingDocument & { _id: unknown })._id },
      {
        $set: {
          factiivProfileId: profile.factiivProfileId,
          factiivScore: profile.factiivScore || 0,
          factiivReputationScore: profile.reputationScore || 0,
          factiivHistoryScore: profile.historyScore || 0,
          factiivUtilizationScore: profile.utilizationScore || 0,
          factiivTradeLines: profile.tradeQuantity || 0,
          factiivTotalTradeAmount: profile.tradeAmountTotal || 0,
          factiivOutstandingBalance: profile.tradeBalanceTotal || profile.activityLastKnownBalanceTotal || 0,
          factiivVerifiedCreditLimit: Number(customer.creditProfile?.approvedCredits ?? customer.businessProfile?.approvedCredits ?? customer.businessProfile?.creditLimit ?? 0),
          factiivMatchedBusiness: profile.matchedBusinessName,
          factiivMatchedEmail: profile.matchedEmail,
          factiivLastSync: profile.lastFactiivSync,
          fundingScore: funding.fundingScore,
          fundingCategory: funding.fundingCategory,
          recommendedFundingProducts: funding.recommendedFundingProducts,
          fundingStrengths: funding.fundingStrengths,
          fundingWeaknesses: funding.fundingWeaknesses,
          nextBestAction: funding.nextBestAction,
          fundingScoreBreakdown: funding.scoreBreakdown,
        },
      }
    ).exec();
  }

  return funding;
}

export async function POST() {
  const started = Date.now();
  await connectToDatabase();

  const before = await readTop110Export();
  const missingBeforeRows = before.customers.filter((row) => row.factiivScore === "Missing");

  let searched = 0;
  let attached = 0;
  let skippedNoMatch = 0;
  let skippedLowConfidence = 0;
  let failed = 0;
  const sampleAttached: AttachOutcome[] = [];
  const sampleStillMissing: AttachOutcome[] = [];

  for (const row of missingBeforeRows) {
    try {
      const customer = await Customer.findById(row.customerId, {
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
        firstPaidDate: 1,
        firstOrderDate: 1,
        customerCreatedAt: 1,
        lastSyncedAt: 1,
      }).lean<Partial<CustomerDocument> & { _id: unknown } | null>();

      if (!customer) {
        failed += 1;
        sampleStillMissing.push({ customerId: row.customerId, email: row.email, businessName: row.businessName, query: "", reason: "Customer not found." });
        continue;
      }

      const searchCustomer = searchCustomerShape(row, customer);
      const queries = buildSearchQueries(row, customer);
      let bestResult: FactiivSearchResult | null = null;
      let sawAnyResult = false;

      for (const query of queries) {
        searched += 1;
        const results = await searchFactiivProfiles(query, searchCustomer);
        if (results.length) sawAnyResult = true;
        const highConfidence = results.find((result) =>
          result.matchConfidence === "high"
          && shouldAutoPersistFactiiv(result.selectedProfileData)
          && Number(result.selectedProfileData.factiivScore ?? result.factiivScore ?? 0) > 0
        );
        if (highConfidence) {
          bestResult = highConfidence;
          break;
        }
      }

      if (!bestResult) {
        if (sawAnyResult) {
          skippedLowConfidence += 1;
          sampleStillMissing.push({ customerId: row.customerId, email: row.email, businessName: row.businessName, query: queries.join(" | "), reason: "No high-confidence Factiiv match found." });
        } else {
          skippedNoMatch += 1;
          sampleStillMissing.push({ customerId: row.customerId, email: row.email, businessName: row.businessName, query: queries.join(" | "), reason: "No Factiiv match found." });
        }
        continue;
      }

      const profile = buildAutoProfile(bestResult);
      await persistFactiivProfile(customer, profile);
      attached += 1;
      sampleAttached.push({
        customerId: row.customerId,
        email: row.email,
        businessName: row.businessName,
        query: profile.factiivSearchQuery,
        matchProfileId: profile.factiivProfileId,
        matchBusinessName: profile.matchedBusinessName,
        matchEmail: profile.matchedEmail,
        matchConfidence: profile.factiivMatchConfidence,
        matchReason: profile.factiivMatchReason,
        factiivScore: profile.factiivScore || "Missing",
      });
    } catch (error) {
      failed += 1;
      sampleStillMissing.push({
        customerId: row.customerId,
        email: row.email,
        businessName: row.businessName,
        query: "",
        reason: error instanceof Error ? error.message : "Unknown Factiiv attach failure.",
      });
    }
  }

  const after = await readTop110Export();
  const missingAfter = after.customers.filter((row) => row.factiivScore === "Missing").length;

  return NextResponse.json({
    success: true,
    totalTop110: before.total,
    missingBefore: missingBeforeRows.length,
    searched,
    attached,
    skippedNoMatch,
    skippedLowConfidence,
    failed,
    missingAfter,
    sampleAttached: sampleAttached.slice(0, 20),
    sampleStillMissing: sampleStillMissing.slice(0, 20),
    totalMs: Date.now() - started,
  });
}
